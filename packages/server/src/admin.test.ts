import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAdminConfig, scrubConfigPassword } from "./admin";

const OK = { SCHULOS_ADMIN_USERNAME: "it.admin", SCHULOS_ADMIN_FIRST_NAME: "Ina", SCHULOS_ADMIN_LAST_NAME: "Tech" };

describe("Admin aus der Konfiguration", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("liefert Fehler als Liste statt zu werfen – jede App meldet sie mit eigenem Fehlertyp", () => {
    expect(parseAdminConfig({ ...OK, SCHULOS_ADMIN_PASSWORD: "Tafel Kreide Pause" })).toMatchObject({ ok: true, admin: { username: "it.admin" } });
    const r = parseAdminConfig({});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toHaveLength(3);
  });

  it("entfernt das Klartext-Passwort aus der Datei, lässt den Rest stehen; ohne Passwortzeile false", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-admin-"));
    dirs.push(dir);
    const file = path.join(dir, "backup.env");
    writeFileSync(file, "SCHULOS_ADMIN_USERNAME=it.admin\nSCHULOS_ADMIN_PASSWORD=Tafel Kreide Pause\n");
    expect(scrubConfigPassword(dir, "backup.env")).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("Tafel");
    expect(text).toContain("SCHULOS_ADMIN_USERNAME=it.admin");
    expect(scrubConfigPassword(dir, "backup.env")).toBe(false);
    expect(scrubConfigPassword(undefined, "backup.env")).toBe(false);
  });
});
