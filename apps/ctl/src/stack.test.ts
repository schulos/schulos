import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex, type HostFile, type ReleaseManifest } from "@schulos/server/release";
import { ctlProbeFile, replaceCtl, type HostFileDeps } from "./host-files";
import { ADMIN_PGOPTIONS, assetDownloadUrl, guardEnv, rollbackStack, smokeCtl, type RollbackSteps } from "./stack";

describe("REPO-02: Release-Anhänge ohne Token", () => {
  const asset = {
    name: "release.json",
    url: "https://api.github.com/repos/o/r/releases/assets/1",
    browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/release.json",
  };
  it("ohne Token über den öffentlichen Download-Link (kein API-Limit), mit Token über die API (privates Repo)", () => {
    expect(assetDownloadUrl(asset, undefined)).toBe(asset.browser_download_url);
    expect(assetDownloadUrl(asset, "")).toBe(asset.browser_download_url);
    expect(assetDownloadUrl(asset, "t")).toBe(asset.url);
    expect(assetDownloadUrl({ name: asset.name, url: asset.url }, undefined)).toBe(asset.url);
  });
});

describe("GATE-031 S-04: Sitzungen der Wartungsrolle mit festem search_path", () => {
  it("jede Rolle außer der App-Rolle bekommt PGOPTIONS", () => {
    expect(ADMIN_PGOPTIONS).toBe("-c search_path=pg_catalog,pg_temp");
    expect(guardEnv("postgres")).toEqual(["-e", "PGOPTIONS=-c search_path=pg_catalog,pg_temp"]);
    expect(guardEnv("schulos_sec07")).toEqual(["-e", "PGOPTIONS=-c search_path=pg_catalog,pg_temp"]);
    expect(guardEnv("schulos")).toEqual([]);
  });
});

describe("GATE-031 R-01: Probestart des neuen schulosctl mit echtem Node", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "schulosctl-probe-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // wie das echte Bundle: ESM (import aus node:…), antwortet auf `version`
  const bundle = (v: string) => `#!/usr/bin/env node\nimport process from "node:process";\nif (process.argv[2] === "version") console.log("schulosctl ${v}");\nelse process.exit(2);\n`;

  it("Probedatei behält die Endung .mjs", () => {
    expect(ctlProbeFile("/opt/schulos/schulosctl.mjs")).toBe("/opt/schulos/schulosctl.neu.mjs");
    expect(ctlProbeFile("/opt/x/ctl")).toBe("/opt/x/ctl.neu.mjs");
  });

  it("Node startet eine ESM-Datei mit unbekannter Endung nicht (Grund für R-01)", async () => {
    const f = path.join(dir, "schulosctl.mjs.neu");
    writeFileSync(f, bundle("9.9.9"));
    expect(await smokeCtl(f)).toBe(false);
  });

  it("replaceCtl mit echtem Dateisystem und echtem Probestart tauscht schulosctl", async () => {
    const file = path.join(dir, "schulosctl.mjs");
    writeFileSync(file, bundle("1.0.0"));
    const neu = new Uint8Array(Buffer.from(bundle("1.0.1"), "utf8"));
    const m = { version: "1.0.1", files: { "schulosctl.mjs": sha256Hex(neu) } } as unknown as ReleaseManifest;
    const d: HostFileDeps = {
      read: (f) => {
        try {
          return new Uint8Array(readFileSync(f));
        } catch {
          return null;
        }
      },
      write: (f, data, mode) => writeFileSync(f, data, { mode }),
      rename: (a, b) => {
        writeFileSync(b, readFileSync(a));
        rmSync(a);
      },
      remove: (f) => rmSync(f, { force: true }),
      fetch: async (_m, name: HostFile) => (name === "schulosctl.mjs" ? neu : null),
    };
    const note = await replaceCtl(d, { file, m, smoke: smokeCtl });
    expect(note).toContain("übernommen");
    expect(readFileSync(file, "utf8")).toContain("schulosctl 1.0.1");
    expect(readFileSync(`${file}.vorher`, "utf8")).toContain("schulosctl 1.0.0");
    expect(d.read(ctlProbeFile(file))).toBeNull();
    expect(await smokeCtl(file)).toBe(true);
  });
});

describe("GATE-031 R-02: Rückweg startet den alten Stack immer", () => {
  function steps(over: Partial<{ pg: boolean; restore: string | null; all: boolean }> = {}) {
    const calls: string[] = [];
    const st: RollbackSteps = {
      restoreFiles: () => void calls.push("dateien"),
      stopApp: async () => void calls.push("stop"),
      upPostgres: async () => (calls.push("up postgres"), over.pg ?? true),
      restoreDump: async () => (calls.push("pg_restore"), over.restore ?? null),
      upAll: async () => (calls.push("up"), over.all ?? true),
    };
    return { st, calls };
  }

  it("Reihenfolge: Dateien zurück, Postgres (alte Fassung) zuerst, Dump, dann alles", async () => {
    const f = steps();
    await rollbackStack(f.st);
    expect(f.calls).toEqual(["dateien", "stop", "up postgres", "pg_restore", "up"]);
  });

  it("Postgres startet nicht → kein Einspielen, trotzdem `up`, Fehler gemeldet", async () => {
    const f = steps({ pg: false, all: false });
    await expect(rollbackStack(f.st)).rejects.toThrow(/Postgres startet mit der alten Fassung nicht.*alter Stack startet nicht/);
    expect(f.calls).toEqual(["dateien", "stop", "up postgres", "up"]);
  });

  it("pg_restore scheitert → `up` trotzdem, Fehler gemeldet", async () => {
    const f = steps({ restore: "service postgres is not running" });
    await expect(rollbackStack(f.st)).rejects.toThrow(/pg_restore: service postgres is not running/);
    expect(f.calls.at(-1)).toBe("up");
  });
});
