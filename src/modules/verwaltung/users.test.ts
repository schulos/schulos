import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "@/core/auth/auth";
import type { DbHandle } from "@/core/db/client";
import { auditLog, sessions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import {
  createUser,
  getUserDetail,
  listUsers,
  PAGE_SIZE,
  resetPassword,
  setUserLocked,
  suggestUsername,
  updateOwnOfficeHours,
  updateUser,
  ValidationError,
} from "./users";
import { generatePassword } from "@schulos/server/passwort";

const ADMIN = "u-admin";

describe("Benutzerverwaltung", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  describe("listUsers", () => {
    it("paginiert und zählt alle", async () => {
      const { rows, total } = await listUsers(h.db);
      expect(total).toBe(633); // inkl. Hausmeister (Rolle personal, P4-10) und Schulsozialarbeit (Rolle beratung, Q5-17)
      expect(rows).toHaveLength(PAGE_SIZE);
    });
    it("sucht nach Name, Benutzername und Kürzel (Groß/Klein egal)", async () => {
      expect((await listUsers(h.db, { q: "brandt" })).rows.map((r) => r.id)).toContain("u-jana.brandt");
      expect((await listUsers(h.db, { q: "KLE" })).rows.map((r) => r.id)).toContain("u-tobias.kleine");
      expect((await listUsers(h.db, { q: "lea.schae" })).rows.map((r) => r.id)).toEqual(["u-lea.schaefer"]);
    });
    it("behandelt % und _ in der Suche wörtlich", async () => {
      expect((await listUsers(h.db, { q: "%" })).total).toBe(0);
    });
    it("filtert nach Rolle und Klasse und liefert die Klassen mit", async () => {
      const lk = await listUsers(h.db, { role: "lehrkraft" });
      expect(lk.total).toBe(28);
      const k7b = await listUsers(h.db, { groupId: "g-7b", role: "schueler" });
      expect(k7b.total).toBe(25);
      expect(k7b.rows.every((r) => r.classes.includes("7b"))).toBe(true);
    });
  });

  it("liefert Details mit Gruppen und Eltern", async () => {
    const d = await getUserDetail(h.db, "u-lea.schaefer");
    expect(d?.memberships.map((m) => m.slug)).toContain("7b");
    expect(d?.parents).toHaveLength(1);
    expect(await getUserDetail(h.db, "gibts-nicht")).toBeNull();
  });

  describe("createUser", () => {
    it("legt an, schlägt einen freien Benutzernamen vor und das Passwort funktioniert", async () => {
      const res = await createUser(h.db, ADMIN, { firstName: "Lea", lastName: "Schäfer", role: "schueler" });
      expect(res.username).toBe("lea.schaefer2");
      const auth = createAuth(h.db);
      const login = await auth.api.signInUsername({ body: { username: res.username, password: res.password } });
      expect(login?.token).toBeTruthy();
      const log = await h.db.select().from(auditLog).where(eq(auditLog.target, res.id));
      expect(log[0]?.action).toBe("verwaltung.user.create");
    });
    it("validiert Pflichtfelder, Kürzel-Format und Kürzel nur für Lehrkräfte", async () => {
      await expect(createUser(h.db, ADMIN, { firstName: "", lastName: "X", role: "schueler" })).rejects.toThrow(ValidationError);
      await expect(createUser(h.db, ADMIN, { firstName: "A", lastName: "B", role: "lehrkraft", shortCode: "X1" })).rejects.toThrow(ValidationError);
      await expect(createUser(h.db, ADMIN, { firstName: "A", lastName: "B", role: "schueler", shortCode: "ABC" })).rejects.toThrow(ValidationError);
    });
    it("verhindert doppelte Kürzel und Benutzernamen", async () => {
      const dup = createUser(h.db, ADMIN, { firstName: "Jan", lastName: "Brand", role: "lehrkraft", shortCode: "bra" });
      await expect(dup).rejects.toMatchObject({ fieldErrors: { shortCode: "Kürzel ist vergeben" } });
      const dupName = createUser(h.db, ADMIN, { firstName: "X", lastName: "Y", role: "eltern", username: "jana.brandt" });
      await expect(dupName).rejects.toMatchObject({ fieldErrors: { username: "Benutzername ist vergeben" } });
    });
    it("Sprechzeiten nur für die Rolle Beratung (Q5-17)", async () => {
      const res = await createUser(h.db, ADMIN, { firstName: "Tom", lastName: "Rat", role: "beratung", officeHours: "  Mo 8–10 Uhr, Raum B 1.02 " });
      const [row] = await h.db.select({ officeHours: users.officeHours }).from(users).where(eq(users.id, res.id));
      expect(row?.officeHours).toBe("Mo 8–10 Uhr, Raum B 1.02");
      await updateUser(h.db, ADMIN, res.id, { firstName: "Tom", lastName: "Rat", role: "lehrkraft", officeHours: "Mo 8–10 Uhr" });
      const [after] = await h.db.select({ officeHours: users.officeHours }).from(users).where(eq(users.id, res.id));
      expect(after?.officeHours).toBeNull();
      await expect(updateUser(h.db, ADMIN, res.id, { firstName: "Tom", lastName: "Rat", role: "beratung", officeHours: "x".repeat(301) })).rejects.toMatchObject({
        fieldErrors: { officeHours: expect.stringContaining("300") },
      });
    });
    it("Q5-25: Beratung pflegt die eigenen Sprechzeiten selbst – nur die eigene Zeile, andere Rollen nicht", async () => {
      const nina = await createUser(h.db, ADMIN, { firstName: "Nora", lastName: "Rat", role: "beratung", officeHours: "Mo 8–10 Uhr" });
      const other = await createUser(h.db, ADMIN, { firstName: "Olaf", lastName: "Rat", role: "beratung", officeHours: "Fr 9 Uhr" });
      const hours = async (id: string) => (await h.db.select({ o: users.officeHours }).from(users).where(eq(users.id, id)))[0]?.o;
      expect(await updateOwnOfficeHours(h.db, nina.id, "  Di + Do 9–12 Uhr,\n Raum A 0.14 ")).toBe("Di + Do 9–12 Uhr, Raum A 0.14");
      expect(await hours(nina.id)).toBe("Di + Do 9–12 Uhr, Raum A 0.14");
      expect(await hours(other.id)).toBe("Fr 9 Uhr");
      // Lehrkräfte, Schüler:innen, Verwaltung: nicht über diesen Weg
      for (const id of ["u-jana.brandt", "u-lea.schaefer", "u-sabine.kowalski"])
        await expect(updateOwnOfficeHours(h.db, id, "Mo 8 Uhr")).rejects.toMatchObject({ fieldErrors: { officeHours: /Beratung/ } });
      expect(await hours("u-jana.brandt")).toBeNull();
      await expect(updateOwnOfficeHours(h.db, nina.id, "x".repeat(301))).rejects.toMatchObject({ fieldErrors: { officeHours: expect.stringContaining("300") } });
      expect(await updateOwnOfficeHours(h.db, nina.id, "")).toBeNull();
      expect(await hours(nina.id)).toBeNull();
      const logs = await h.db.select().from(auditLog).where(eq(auditLog.action, "konto.sprechzeiten"));
      expect(logs.map((l) => [l.actorId, l.target])).toEqual([
        [nina.id, nina.id],
        [nina.id, nina.id],
      ]);
      // die Verwaltung ändert sie weiterhin im Benutzerformular
      await updateUser(h.db, ADMIN, nina.id, { firstName: "Nora", lastName: "Rat", role: "beratung", officeHours: "Mi 10 Uhr" });
      expect(await hours(nina.id)).toBe("Mi 10 Uhr");
    });
  });

  it("aktualisiert Namen und Rolle", async () => {
    await updateUser(h.db, ADMIN, "u-jana.brandt", { firstName: "Jana", lastName: "Brandt-Meyer", role: "lehrkraft", shortCode: "BRA" });
    const [u] = await h.db.select().from(users).where(eq(users.id, "u-jana.brandt"));
    expect(u?.name).toBe("Jana Brandt-Meyer");
  });

  it("Admin kann sich nicht selbst degradieren oder sperren", async () => {
    await expect(updateUser(h.db, ADMIN, ADMIN, { firstName: "Admin", lastName: "IT", role: "lehrkraft" })).rejects.toThrow(ValidationError);
    await expect(setUserLocked(h.db, ADMIN, ADMIN, true)).rejects.toThrow(ValidationError);
  });

  it("Sperren beendet Sitzungen, Entsperren erlaubt wieder Login", async () => {
    const auth = createAuth(h.db);
    await auth.api.signInUsername({ body: { username: "lea.schaefer", password: "schulos" } });
    await setUserLocked(h.db, ADMIN, "u-lea.schaefer", true);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "u-lea.schaefer"))).toHaveLength(0);
    await expect(auth.api.signInUsername({ body: { username: "lea.schaefer", password: "schulos" } })).rejects.toThrow();
    await setUserLocked(h.db, ADMIN, "u-lea.schaefer", false);
    expect((await auth.api.signInUsername({ body: { username: "lea.schaefer", password: "schulos" } }))?.token).toBeTruthy();
  });

  it("Passwort-Reset: altes Passwort ungültig, neues gültig", async () => {
    const auth = createAuth(h.db);
    const pw = await resetPassword(h.db, ADMIN, "u-tobias.kleine");
    await expect(auth.api.signInUsername({ body: { username: "tobias.kleine", password: "schulos" } })).rejects.toThrow();
    expect((await auth.api.signInUsername({ body: { username: "tobias.kleine", password: pw } }))?.token).toBeTruthy();
  });

  it("Hilfsfunktionen", async () => {
    expect(await suggestUsername(h.db, "Neue", "Person")).toBe("neue.person");
    const pw = generatePassword();
    expect(pw).toHaveLength(10);
    expect(pw).not.toMatch(/[0O1lI]/);
  });
});
