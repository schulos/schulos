import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { groupFeatures } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { cleanName, createFolder, deleteNode, getDownload, groupFolders, listFolder, MAX_FILE_BYTES, QUOTA, renameNode, uploadFile } from "./service";

const bytes = (s: string) => new TextEncoder().encode(s);

async function readAll(stream: ReadableStream<Uint8Array>) {
  return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe("Dateien", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-files-"));
    storage = localStorage(dir);
    // Seed gibt Klassen und AGs Gruppenordner – für den Negativfall der AG das Merkmal wieder nehmen
    await h.db.delete(groupFeatures).where(and(eq(groupFeatures.groupId, "g-ag-schuelerzeitung"), eq(groupFeatures.feature, "dateien.gruppenordner")));
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  const p = (id: string) => loadPermissions(h.db, id);

  it("cleanName entschärft Namen", () => {
    expect(cleanName("  ../geheim/datei.txt ")).toBe(".._geheim_datei.txt");
    expect(() => cleanName("..")).toThrow(ValidationError);
  });

  it("Ordner + Upload + Download im persönlichen Bereich; Ordner zuerst, Brotkrumen", async () => {
    const lea = await p("u-lea.schaefer");
    const folder = await createFolder(h.db, lea, "personal", null, "Mathe");
    const sub = await createFolder(h.db, lea, "personal", folder, "Brüche");
    const f = await uploadFile(h.db, storage, lea, "personal", null, { name: "aufsatz.txt", type: "text/plain", data: bytes("Hallo Welt") });
    const root = await listFolder(h.db, lea, "personal", null);
    expect(root.items.map((i) => i.name)).toEqual(["Mathe", "aufsatz.txt"]);
    expect(root.used).toBe(10);
    expect((await listFolder(h.db, lea, "personal", sub)).crumbs.map((c) => c.name)).toEqual(["Mathe", "Brüche"]);
    const dl = await getDownload(h.db, lea, f.id);
    expect(await readAll((await storage.get(dl!.storageKey!))!)).toBe("Hallo Welt");
  });

  it("gleiche Namen: Upload bekommt Zähler, Ordner/Umbenennen werden abgelehnt", async () => {
    const lea = await p("u-lea.schaefer");
    const f2 = await uploadFile(h.db, storage, lea, "personal", null, { name: "Aufsatz.txt", type: "text/plain", data: bytes("x") });
    expect(f2.name).toBe("Aufsatz (2).txt");
    await expect(createFolder(h.db, lea, "personal", null, "mathe")).rejects.toThrow(ValidationError);
    await expect(renameNode(h.db, lea, "personal", f2.id, "AUFSATZ.TXT")).rejects.toThrow(ValidationError);
    await renameNode(h.db, lea, "personal", f2.id, "Entwurf.txt");
  });

  it("persönlicher Bereich ist privat", async () => {
    const lea = await p("u-lea.schaefer");
    const brandt = await p("u-jana.brandt");
    const [f] = (await listFolder(h.db, lea, "personal", null)).items.filter((i) => i.kind === "file");
    expect(await getDownload(h.db, brandt, f!.id)).toBeNull();
    await expect(renameNode(h.db, brandt, "personal", f!.id, "x")).rejects.toThrow(); // nicht in Brandts Bereich
  });

  it("Gruppenordner nur mit Merkmal und Mitgliedschaft; Fremdes löschen nur Leitung/Personal", async () => {
    const lea = await p("u-lea.schaefer");
    expect((await groupFolders(h.db, lea)).map((g) => g.name)).toEqual(["Klasse 7b"]);
    await expect(listFolder(h.db, lea, "group:g-ag-schuelerzeitung", null)).rejects.toThrow(ValidationError); // ohne Merkmal
    const brandt = await p("u-jana.brandt");
    const up = await uploadFile(h.db, storage, brandt, "group:g-7b", null, { name: "Arbeitsblatt.pdf", type: "application/pdf", data: bytes("%PDF") });
    const leaView = await listFolder(h.db, lea, "group:g-7b", null);
    expect(leaView.items.find((i) => i.id === up.id)?.canModify).toBe(false);
    await expect(deleteNode(h.db, storage, lea, "group:g-7b", up.id)).rejects.toThrow(ValidationError);
    const own = await uploadFile(h.db, storage, lea, "group:g-7b", null, { name: "Lea.txt", type: "text/plain", data: bytes("x") });
    await deleteNode(h.db, storage, brandt, "group:g-7b", own.id); // Klassenleitung darf
    const fremd = await p("u-daniel.okafor"); // Personal, aber Mitglied der 7b? (Seed: zufällig) – nur wenn Mitglied
    expect((await getDownload(h.db, fremd, up.id)) === null).toBe(!fremd.memberOf.has("g-7b"));
  });

  it("Ordner löschen entfernt Inhalt aus DB und Speicher", async () => {
    const lea = await p("u-lea.schaefer");
    const folder = await createFolder(h.db, lea, "personal", null, "Weg damit");
    const sub = await createFolder(h.db, lea, "personal", folder, "Unterordner");
    await uploadFile(h.db, storage, lea, "personal", sub, { name: "a.txt", type: "text/plain", data: bytes("a") });
    await uploadFile(h.db, storage, lea, "personal", folder, { name: "b.txt", type: "text/plain", data: bytes("b") });
    const before = (await readdir(dir, { recursive: true })).length;
    expect(await deleteNode(h.db, storage, lea, "personal", folder)).toBe(2);
    expect((await readdir(dir, { recursive: true })).length).toBeLessThan(before);
    expect((await listFolder(h.db, lea, "personal", null)).items.some((i) => i.name === "Weg damit")).toBe(false);
  });

  it("Größenlimit und Kontingent", async () => {
    const lea = await p("u-lea.schaefer");
    await expect(uploadFile(h.db, storage, lea, "personal", null, { name: "gross.bin", type: "", data: new Uint8Array(MAX_FILE_BYTES + 1) })).rejects.toMatchObject({ fieldErrors: { file: expect.stringMatching(/25 MB/) } });
  });
  it("SEC-05: parallele Uploads überschreiten das Kontingent nicht; abgelehnte hinterlassen keine Datei", async () => {
    const jana = await p("u-jana.brandt");
    const used = (await listFolder(h.db, jana, "personal", null)).used;
    const before = (await storage.list()).length;
    const saved = QUOTA.personal;
    QUOTA.personal = used + 25; // Platz für genau zwei Dateien à 10 Byte
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => uploadFile(h.db, storage, jana, "personal", null, { name: `teil-${i}.txt`, type: "text/plain", data: bytes("0123456789") })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ fieldErrors: { file: "Speicherplatz reicht nicht aus" } });
      expect((await listFolder(h.db, jana, "personal", null)).used).toBe(used + 20);
      expect((await storage.list()).length).toBe(before + 2);
    } finally {
      QUOTA.personal = saved;
    }
  });
});
