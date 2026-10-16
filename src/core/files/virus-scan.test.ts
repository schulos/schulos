// P4-72: Virenscan – Protokoll gegen eine nachgebaute clamd (TCP, INSTREAM), Einhängen in die Upload-Pfade (Dateien,
// Aufgaben, Gebäude-Fotos, Prüfprotokolle). Gegen ein echtes ClamAV mit EICAR läuft nur die CI (Job „stack“,
// `node cli.mjs virenscan-pruefen`).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage } from "@/core/files/storage";
import { loadPermissions } from "@/core/permissions";
import { uploadFile } from "@/modules/dateien/service";
import { scanUpload } from "@/modules/upload-scan";
import {
  assertNoVirus,
  clamavTarget,
  clamavVersion,
  EICAR,
  encryptedZipSample,
  parseClamdReply,
  scanBuffer,
  VirusScanError,
} from "./virus-scan";

/** Nachgebaute clamd: liest INSTREAM-Blöcke und meldet EICAR als Fund */
function fakeClamd(): Promise<{
  port: number;
  received: Buffer[];
  close: () => Promise<void>;
}> {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.toString("latin1").startsWith("zVERSION\0")) {
        sock.end("ClamAV 1.5.4/27800/Tue Oct 14 08:00:00 2026\0");
        return;
      }
      if (!buf.toString("latin1").startsWith("zINSTREAM\0")) return;
      // Blöcke lesen, bis Länge 0
      let off = 10;
      const parts: Buffer[] = [];
      for (;;) {
        if (buf.length < off + 4) return;
        const len = buf.readUInt32BE(off);
        if (len === 0) break;
        if (buf.length < off + 4 + len) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
      const data = Buffer.concat(parts);
      received.push(data);
      sock.end(
        data.toString("latin1").includes("EICAR-STANDARD")
          ? "stream: Eicar-Test-Signature FOUND\0"
          : "stream: OK\0",
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

describe("P4-72: Virenscan (clamd-Protokoll)", () => {
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  beforeAll(async () => {
    clamd = await fakeClamd();
  });
  afterAll(() => clamd.close());

  it("Einstellung: aus, host:port, Vorgabe-Port, Unsinn", () => {
    expect(clamavTarget({})).toBeNull();
    expect(clamavTarget({ SCHULOS_CLAMAV: "clamav:3310" })).toEqual({
      host: "clamav",
      port: 3310,
    });
    expect(clamavTarget({ SCHULOS_CLAMAV: "clamav" })).toEqual({
      host: "clamav",
      port: 3310,
    });
    expect(() => clamavTarget({ SCHULOS_CLAMAV: "clamav:x; rm" })).toThrow(
      "host:port",
    );
  });

  it("G4E-O09: verschlüsseltes Probe-ZIP gültig aufgebaut; strenge clamd-Einstellungen in compose.yaml; Heuristik-Fund zählt", async () => {
    const zip = Buffer.from(encryptedZipSample());
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(6) & 1).toBe(1);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    const cd = zip.readUInt32LE(end + 16);
    expect(zip.readUInt32LE(cd)).toBe(0x02014b50);
    expect(zip.readUInt16LE(cd + 8) & 1).toBe(1);
    expect(zip.subarray(30, 30 + zip.readUInt16LE(26)).toString()).toBe("rechnung.txt");
    expect(parseClamdReply("stream: Heuristics.Encrypted.Zip FOUND\0")).toEqual({ clean: false, signature: "Heuristics.Encrypted.Zip" });
    const { readFileSync } = await import("node:fs");
    const compose = readFileSync(path.join(__dirname, "../../../compose.yaml"), "utf8");
    for (const opt of ["AlertEncrypted yes", "AlertEncryptedArchive yes", "AlertEncryptedDoc yes", "AlertExceedsMax yes", "AlertBrokenExecutables yes", "StreamMaxLength 30M"])
      expect(compose).toContain(opt);
    expect(compose).toContain("target: /etc/schulos/clamd-schulos.conf");
    expect(compose).toContain("exec /init");
  });

  it("Antworten von clamd", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({
      clean: true,
      signature: null,
    });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      clean: false,
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(() =>
      parseClamdReply("INSTREAM size limit exceeded. ERROR\0"),
    ).toThrow("zu groß");
    expect(() => parseClamdReply("")).toThrow(VirusScanError);
  });

  it("INSTREAM in Blöcken (auch > 64 KB), EICAR gefunden, harmlose Datei durch, Version", async () => {
    const t = { host: "127.0.0.1", port: clamd.port };
    const big = new Uint8Array(200_000).fill(65);
    expect(await scanBuffer(big, t)).toEqual({ clean: true, signature: null });
    expect(clamd.received.at(-1)!.length).toBe(200_000);
    expect(await scanBuffer(new TextEncoder().encode(EICAR), t)).toEqual({
      clean: false,
      signature: "Eicar-Test-Signature",
    });
    expect(await clamavVersion(t)).toContain("ClamAV 1.5.4");
  });

  it("vor dem Speichern: Fund → Meldung, nicht erreichbar → abgelehnt (streng), aus → nichts", async () => {
    const env = { SCHULOS_CLAMAV: `127.0.0.1:${clamd.port}` };
    await expect(
      assertNoVirus(new TextEncoder().encode(EICAR), "rechnung.pdf", env),
    ).rejects.toThrow(
      "„rechnung.pdf“ enthält Schadsoftware (Eicar-Test-Signature) und wurde nicht gespeichert.",
    );
    await expect(
      assertNoVirus(new TextEncoder().encode("ok"), "a.txt", env),
    ).resolves.toBeUndefined();
    await expect(
      assertNoVirus(new TextEncoder().encode("ok"), "a.txt", {
        SCHULOS_CLAMAV: "127.0.0.1:1",
      }),
    ).rejects.toThrow(/nicht gespeichert: Virenscan nicht erreichbar/);
    await expect(
      assertNoVirus(new TextEncoder().encode(EICAR), "a.txt", {}),
    ).resolves.toBeUndefined();
    // Feldmeldung des Formulars
    await expect(
      scanUpload(new TextEncoder().encode(EICAR), "x.doc", "file", env),
    ).rejects.toMatchObject({
      fieldErrors: { file: expect.stringContaining("Schadsoftware") },
    });
  });
});

describe("P4-72: Upload mit Fund wird nicht gespeichert (Dateien)", () => {
  let h: DbHandle;
  let dir: string;
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  const before = process.env.SCHULOS_CLAMAV;
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-scan-"));
    clamd = await fakeClamd();
    process.env.SCHULOS_CLAMAV = `127.0.0.1:${clamd.port}`;
  }, 60_000);
  afterAll(async () => {
    if (before === undefined) delete process.env.SCHULOS_CLAMAV;
    else process.env.SCHULOS_CLAMAV = before;
    await clamd.close();
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("EICAR im persönlichen Bereich: Feldmeldung, nichts im Speicher; harmlose Datei geht", async () => {
    const storage = localStorage(dir);
    const lea = await loadPermissions(h.db, "u-lea.schaefer");
    await expect(
      uploadFile(h.db, storage, lea, "personal", null, {
        name: "spiel.exe",
        type: "",
        data: new TextEncoder().encode(EICAR),
      }),
    ).rejects.toMatchObject({
      fieldErrors: { file: expect.stringContaining("Schadsoftware") },
    });
    expect(await readdir(dir)).toEqual([]);
    await uploadFile(h.db, storage, lea, "personal", null, {
      name: "ok.txt",
      type: "text/plain",
      data: new TextEncoder().encode("Hallo"),
    });
    expect((await readdir(dir)).length).toBe(1);
  });
});
