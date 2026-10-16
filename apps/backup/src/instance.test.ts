import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import { hashPassword } from "@/auth/auth";
import type { DbHandle } from "@/db/client";
import { accounts, auditLog, users } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { initializeBackup, StartupError } from "@/instance";

const ADMIN = { SCHULOS_ADMIN_USERNAME: "it.admin", SCHULOS_ADMIN_FIRST_NAME: "Ina", SCHULOS_ADMIN_LAST_NAME: "Tech" };

describe("Erststart Backupserver", () => {
  let h: DbHandle;
  beforeEach(async () => {
    h = await createTestDb();
  });
  afterEach(() => h.close());

  it("legt das Admin-Konto aus der Konfiguration an und protokolliert es; zweiter Start prüft nur", async () => {
    const r = await initializeBackup(h.db, { ...ADMIN, SCHULOS_ADMIN_PASSWORD: "Tafel Kreide Pause" }, true);
    expect(r).toEqual({ action: "created-admin", admin: "it.admin", usedPlainPassword: true, dev: false });
    const [u] = await h.db.select().from(users);
    expect(u).toMatchObject({ username: "it.admin", name: "Ina Tech", twoFactorEnabled: false });
    const [acc] = await h.db.select().from(accounts).where(eq(accounts.userId, u!.id));
    expect(await verifyPassword({ hash: acc!.password!, password: "Tafel Kreide Pause" })).toBe(true);
    expect((await h.db.select().from(auditLog)).map((a) => a.action)).toEqual(["system.erststart"]);

    expect(await initializeBackup(h.db, {}, true)).toEqual({ action: "checked", users: 1 });
  });

  it("übernimmt einen fertigen Passwort-Hash (so schreibt es der Installer)", async () => {
    const hash = await hashPassword("Tafel Kreide Pause");
    const r = await initializeBackup(h.db, { ...ADMIN, SCHULOS_ADMIN_PASSWORD_HASH: hash }, true);
    expect(r).toMatchObject({ action: "created-admin", usedPlainPassword: false });
  });

  it("bricht im Betrieb ohne bzw. mit unvollständiger Konfiguration ab", async () => {
    await expect(initializeBackup(h.db, {}, true)).rejects.toThrow(StartupError);
    await expect(initializeBackup(h.db, { ...ADMIN, SCHULOS_ADMIN_PASSWORD: "Passwort2026!" }, true)).rejects.toThrow(/SCHULOS_ADMIN_PASSWORD/);
    expect(await h.db.select().from(users)).toHaveLength(0);
  });

  it("legt in der Entwicklung ohne Konfiguration ein Dev-Konto an – aber nicht bei halber Konfiguration", async () => {
    await expect(initializeBackup(h.db, { SCHULOS_ADMIN_USERNAME: "x.y" }, false)).rejects.toThrow(StartupError);
    expect(await initializeBackup(h.db, {}, false)).toMatchObject({ action: "created-admin", admin: "admin", dev: true });
  });
});
