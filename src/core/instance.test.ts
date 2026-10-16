import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import { accounts, appSettings, schoolYears, subjects, users } from "@/core/db/schema";
import { createSeededTestDb, createTestDb } from "@/core/db/testing";
import { adminFromEnv, initializeInstance, InstanceError, instanceTypeFrom, schoolYearFor } from "./instance";
import { scrubPlainPassword } from "@schulos/server/admin";

const PROD = {
  SCHULOS_INSTANCE: "production",
  SCHULOS_ADMIN_USERNAME: "m.mueller",
  SCHULOS_ADMIN_FIRST_NAME: "Maria",
  SCHULOS_ADMIN_LAST_NAME: "Müller",
  SCHULOS_ADMIN_PASSWORD: "Kastanienbaum-Fahrrad-7",
  SCHULOS_SCHOOL_NAME: "Realschule am Park",
  SCHULOS_SCHOOL_STATE: "nw",
  SCHULOS_SCHOOL_FORM: "realschule",
};

describe("Instanztyp und Erststart", () => {
  it("liest den Instanztyp und lehnt Unbekanntes ab", () => {
    expect(instanceTypeFrom({})).toBeUndefined();
    expect(instanceTypeFrom({ SCHULOS_INSTANCE: " Demo " })).toBe("demo");
    expect(() => instanceTypeFrom({ SCHULOS_INSTANCE: "test" })).toThrow(InstanceError);
  });

  it("prüft das Admin-Konto aus der Konfiguration (Passwortregeln, Hash-Format, Pflichtfelder)", () => {
    expect(adminFromEnv(PROD)).toMatchObject({ username: "m.mueller", password: { plain: PROD.SCHULOS_ADMIN_PASSWORD } });
    expect(() => adminFromEnv({ ...PROD, SCHULOS_ADMIN_PASSWORD: "Passwort2026!" })).toThrow(/SCHULOS_ADMIN_PASSWORD/);
    expect(() => adminFromEnv({ ...PROD, SCHULOS_ADMIN_PASSWORD: undefined })).toThrow(/fehlt/);
    expect(() => adminFromEnv({ ...PROD, SCHULOS_ADMIN_USERNAME: "M Müller" })).toThrow(/USERNAME/);
    expect(() => adminFromEnv({ ...PROD, SCHULOS_ADMIN_PASSWORD: undefined, SCHULOS_ADMIN_PASSWORD_HASH: "kein-hash" })).toThrow(/salt:key/);
    expect(adminFromEnv({ ...PROD, SCHULOS_ADMIN_PASSWORD: undefined, SCHULOS_ADMIN_PASSWORD_HASH: "ab12:cd34" }).password).toEqual({ hash: "ab12:cd34" });
  });

  it("Schuljahr zum Datum (Wechsel am 1. August)", () => {
    expect(schoolYearFor(new Date(2026, 9, 4))).toMatchObject({ id: "sj-2026-27", name: "2026/27", startsOn: "2026-08-01", endsOn: "2027-07-31" });
    expect(schoolYearFor(new Date(2027, 6, 31)).name).toBe("2026/27");
  });

  it("ohne SCHULOS_INSTANCE passiert nichts (Entwicklung)", async () => {
    const h = await createTestDb();
    expect(await initializeInstance(h.db, {})).toEqual({ action: "none" });
    expect(await h.db.select().from(users)).toHaveLength(0);
    await h.close();
  });

  it("Produktiv: leere Instanz nur mit Admin, Schuleinstellungen und aktuellem Schuljahr; zweiter Start prüft nur", async () => {
    const h = await createTestDb();
    const r = await initializeInstance(h.db, PROD, new Date(2026, 9, 4));
    expect(r).toEqual({ action: "created-production", admin: "m.mueller", usedPlainPassword: true });
    const all = await h.db.select().from(users);
    expect(all.map((u) => [u.username, u.role, u.mustChangePassword])).toEqual([["m.mueller", "admin", false]]);
    const [acc] = await h.db.select().from(accounts).where(eq(accounts.userId, all[0]!.id));
    expect(await verifyPassword({ hash: acc!.password!, password: PROD.SCHULOS_ADMIN_PASSWORD })).toBe(true);
    const settings = Object.fromEntries((await h.db.select().from(appSettings)).map((s) => [s.key, s.value]));
    expect(settings).toMatchObject({ "instance.type": "production", "school.name": "Realschule am Park", "school.state": "NW", "school.form": "realschule" });
    expect(settings.demo).toBeUndefined();
    expect((await h.db.select().from(schoolYears)).map((y) => [y.name, y.isCurrent])).toEqual([["2026/27", true]]);
    expect(await h.db.select().from(subjects)).toHaveLength(0); // Vorlagen nur auf Wunsch

    expect(await initializeInstance(h.db, PROD)).toEqual({ action: "checked", type: "production" });
    expect(await h.db.select().from(users)).toHaveLength(1);
    await expect(initializeInstance(h.db, { SCHULOS_INSTANCE: "demo" })).rejects.toThrow(/Produktivinstanz/);
    await h.close();
  });

  it("Produktiv mit Vorlagen: Fächer und Zeitraster ohne Personendaten", async () => {
    const h = await createTestDb();
    await initializeInstance(h.db, { ...PROD, SCHULOS_TEMPLATES: "1" });
    expect((await h.db.select().from(subjects)).length).toBeGreaterThan(10);
    expect(await h.db.select().from(users)).toHaveLength(1);
    await h.close();
  });

  it("Produktiv ohne gültigen Admin startet nicht und legt nichts an", async () => {
    const h = await createTestDb();
    await expect(initializeInstance(h.db, { SCHULOS_INSTANCE: "production" })).rejects.toThrow(InstanceError);
    // nur die Vorgabe aus Migration 0078 (Stichtag der 2FA-Pflicht)
    expect((await h.db.select().from(appSettings)).map((r) => r.key)).toEqual(["sicherheit.zwei_faktor_ab"]);
    await h.close();
  });

  it("Demo → Produktiv ist ausgeschlossen (auch für ältere Demo-DBs ohne gespeicherten Typ)", async () => {
    const h = await createSeededTestDb();
    await expect(initializeInstance(h.db, PROD)).rejects.toThrow(/Demo → Produktiv ist ausgeschlossen/);
    expect(await initializeInstance(h.db, { SCHULOS_INSTANCE: "demo" })).toEqual({ action: "checked", type: "demo" });
    const [row] = await h.db.select().from(appSettings).where(eq(appSettings.key, "instance.type"));
    expect(row?.value).toBe("demo");
    expect(await h.db.select().from(users).where(eq(users.username, "m.mueller"))).toHaveLength(0);
    await h.close();
  });

  it("entfernt das Klartext-Passwort aus der Konfigurationsdatei", () => {
    expect(scrubPlainPassword("SCHULOS_INSTANCE=production\nSCHULOS_ADMIN_PASSWORD=geheim\nSCHULOS_ADMIN_PASSWORD_HASH=a:b\n")).toBe(
      "SCHULOS_INSTANCE=production\n# SCHULOS_ADMIN_PASSWORD wurde nach dem Erststart entfernt\nSCHULOS_ADMIN_PASSWORD_HASH=a:b\n",
    );
  });
});
