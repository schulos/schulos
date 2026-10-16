import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTmpDir, TMP_MAX_AGE_MS } from "./tmp-aufraeumen";

describe("G4E-O18: /tmp von Agent und Backup-App aufräumen", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("nur mit SCHULOS_TMP_AUFRAEUMEN=1; älter als 24 h weg, jüngere und .cache bleiben", () => {
    dir = mkdtempSync(path.join(tmpdir(), "schulos-tmp-"));
    const now = Date.now();
    const old = (now - TMP_MAX_AGE_MS - 60_000) / 1000;
    mkdirSync(path.join(dir, "restore-alt"));
    writeFileSync(path.join(dir, "restore-alt", "schulos.dump"), "personendaten");
    utimesSync(path.join(dir, "restore-alt"), old, old);
    writeFileSync(path.join(dir, "dump-alt.sql"), "x");
    utimesSync(path.join(dir, "dump-alt.sql"), old, old);
    writeFileSync(path.join(dir, "dump-laeuft.sql"), "y");
    mkdirSync(path.join(dir, ".cache"));
    utimesSync(path.join(dir, ".cache"), old, old);
    expect(cleanTmpDir(dir, { now, env: {} })).toEqual([]);
    expect(existsSync(path.join(dir, "dump-alt.sql"))).toBe(true);
    const removed = cleanTmpDir(dir, { now, env: { SCHULOS_TMP_AUFRAEUMEN: "1" } }).sort();
    expect(removed).toEqual(["dump-alt.sql", "restore-alt"]);
    expect(existsSync(path.join(dir, "dump-laeuft.sql"))).toBe(true);
    expect(existsSync(path.join(dir, ".cache"))).toBe(true);
    expect(cleanTmpDir(path.join(dir, "fehlt"), { env: { SCHULOS_TMP_AUFRAEUMEN: "1" } })).toEqual([]);
  });

  it("Compose setzt den Schalter für Agent und Backup-App (beide /tmp als Volume)", async () => {
    const { readFileSync } = await import("node:fs");
    const root = path.resolve(__dirname, "../../..");
    for (const f of ["compose.yaml", "compose.backup.yaml"]) expect(readFileSync(path.join(root, f), "utf8")).toContain('SCHULOS_TMP_AUFRAEUMEN: "1"');
  });
});
