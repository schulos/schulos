import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, mailOutbox, sessions, users, verifications } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { createAuth, createUserWithPassword, hashPassword } from "./auth";
import { completePasswordReset, pendingPasswordReset, requestPasswordReset, resetEligible } from "./passwort-reset";

const opts = { school: "Testschule", ip: "198.51.100.1" };
const tokenOf = (link: string) => link.split("/").pop()!;

describe("P4-70: Passwort vergessen", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = await createTestDb();
    const hash = { hash: await hashPassword("altes Passwort 1") };
    const make = async (id: string, role: "lehrkraft" | "eltern" | "schueler" | "verwaltung", extra: Partial<typeof users.$inferInsert>) => {
      await createUserWithPassword(h.db, { id, name: `Konto ${id}`, username: id, role }, hash);
      await h.db
        .update(users)
        .set({ email: `${id}@example.org`, emailVerified: true, twoFactorEnabled: true, ...extra })
        .where(eq(users.id, id));
    };
    await make("lkr", "lehrkraft", {});
    await make("elt", "eltern", {});
    await make("ohne2fa", "lehrkraft", { twoFactorEnabled: false });
    await make("unbest", "lehrkraft", { emailVerified: false });
    await make("sch", "schueler", {});
    await make("vw", "verwaltung", {});
    await make("gesperrt", "eltern", { status: "locked" });
  });
  afterAll(() => h.close());

  it("nur Lehrkräfte, Personal, Eltern – aktiv, mit 2FA und bestätigter echter Adresse", () => {
    const base = { role: "lehrkraft" as const, status: "active", twoFactorEnabled: true, emailVerified: true, email: "a@example.org" };
    expect(resetEligible(base)).toBe(true);
    expect(resetEligible({ ...base, role: "personal" })).toBe(true);
    expect(resetEligible({ ...base, role: "eltern" })).toBe(true);
    expect(resetEligible({ ...base, role: "verwaltung" })).toBe(false);
    expect(resetEligible({ ...base, role: "schueler" })).toBe(false);
    expect(resetEligible({ ...base, twoFactorEnabled: false })).toBe(false);
    expect(resetEligible({ ...base, emailVerified: false })).toBe(false);
    expect(resetEligible({ ...base, email: "x@schulos.local" })).toBe(false);
    expect(resetEligible({ ...base, status: "locked" })).toBe(false);
  });

  it("ohne Berechtigung kein Link und keine Mail (Antwort gleich)", async () => {
    for (const who of ["ohne2fa", "unbest", "sch", "vw", "gesperrt", "gibtsnicht", "ohne2fa@example.org"])
      expect(await requestPasswordReset(h.db, who, opts)).toBeNull();
    expect(await h.db.select().from(mailOutbox)).toHaveLength(0);
  });

  it("Link per Benutzername oder Adresse, 1 h gültig, einmal; neues Passwort beendet alle Sitzungen", async () => {
    const now = new Date();
    const auth = createAuth(h.db);
    await auth.api.signInUsername({ body: { username: "lkr", password: "altes Passwort 1" } });
    expect((await h.db.select().from(sessions).where(eq(sessions.userId, "lkr"))).length).toBe(0); // 2FA: keine Sitzung ohne Code
    await h.db.insert(sessions).values({ id: "s-lkr", token: "t-lkr", userId: "lkr", expiresAt: new Date(now.getTime() + 3_600_000) });

    const first = await requestPasswordReset(h.db, "LKR@example.org", { ...opts, now });
    const link = await requestPasswordReset(h.db, "lkr", { ...opts, now });
    expect(link).toMatch(/\/passwort-vergessen\/[A-Za-z0-9_-]+$/);
    // nur ein offener Link je Konto, gespeichert nur als Hash
    expect(await pendingPasswordReset(h.db, tokenOf(first!), now)).toBeNull();
    const rows = (await h.db.select().from(verifications)).filter((r) => r.identifier.startsWith("password-reset:"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).not.toContain(tokenOf(link!));
    expect(await pendingPasswordReset(h.db, tokenOf(link!), new Date(now.getTime() + 61 * 60_000))).toBeNull();
    expect(await pendingPasswordReset(h.db, tokenOf(link!), now)).toMatchObject({ userId: "lkr" });

    await expect(completePasswordReset(h.db, tokenOf(link!), { next: "kurz", repeat: "kurz" }, opts)).rejects.toThrow("Mindestens");
    await expect(completePasswordReset(h.db, tokenOf(link!), { next: "Neues Passwort 2026", repeat: "anders" }, opts)).rejects.toThrow(
      "stimmen nicht",
    );
    await completePasswordReset(h.db, tokenOf(link!), { next: "Neues Passwort 2026", repeat: "Neues Passwort 2026" }, opts);
    await expect(completePasswordReset(h.db, tokenOf(link!), { next: "Neues Passwort 2027", repeat: "Neues Passwort 2027" }, opts)).rejects.toThrow(
      "ungültig",
    );
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "lkr"))).toHaveLength(0);

    // neues Passwort gilt, der zweite Faktor bleibt Pflicht
    const res = (await auth.api.signInUsername({ body: { username: "lkr", password: "Neues Passwort 2026" } })) as { twoFactorRedirect?: boolean };
    expect(res.twoFactorRedirect).toBe(true);
    const actions = (await h.db.select().from(auditLog).where(eq(auditLog.target, "lkr"))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["konto.passwort.reset_angefordert", "konto.passwort.reset_mail"]));
    const mails = (await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, "lkr@example.org"))).map((m) => m.subject);
    expect(mails).toEqual(["Testschule: Passwort zurücksetzen", "Testschule: Passwort zurücksetzen", "Testschule: Passwort geändert"]);
  });

  it("G4E-C12: scheitert ein Schritt, bleibt alles beim Alten – Link gültig, altes Passwort, Sitzungen da", async () => {
    const now = new Date();
    await createUserWithPassword(h.db, { id: "lk2", name: "Konto lk2", username: "lk2", role: "lehrkraft" }, { hash: await hashPassword("altes Passwort 1") });
    await h.db.update(users).set({ email: "lk2@example.org", emailVerified: true, twoFactorEnabled: true }).where(eq(users.id, "lk2"));
    await h.db.insert(sessions).values({ id: "s-lk2", token: "t-lk2", userId: "lk2", expiresAt: new Date(now.getTime() + 3_600_000) });
    await h.db.insert(verifications).values({ id: "tv-lk2", identifier: "trust-device-lk2", value: "lk2", expiresAt: new Date(now.getTime() + 86_400_000) });
    const link = await requestPasswordReset(h.db, "lk2", { ...opts, ip: "198.51.100.5", now });
    // eingeschobener Fehler: das Beenden der Sitzungen scheitert (nach Link-Verbrauch und Passwortwechsel)
    await h.db.execute(sql.raw(`create function g4e_c12() returns trigger language plpgsql as $$ begin raise exception 'Testfehler'; end $$`));
    await h.db.execute(sql.raw(`create trigger g4e_c12 before delete on sessions for each row when (old.user_id = 'lk2') execute function g4e_c12()`));
    await expect(completePasswordReset(h.db, tokenOf(link!), { next: "Neues Passwort 2026", repeat: "Neues Passwort 2026" }, opts)).rejects.toThrow(/delete from "sessions"/);
    await h.db.execute(sql.raw("drop trigger g4e_c12 on sessions"));
    await h.db.execute(sql.raw("drop function g4e_c12()"));
    expect(await pendingPasswordReset(h.db, tokenOf(link!), now)).toMatchObject({ userId: "lk2" });
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "lk2"))).toHaveLength(1);
    const auth = createAuth(h.db);
    expect(((await auth.api.signInUsername({ body: { username: "lk2", password: "altes Passwort 1" } })) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    // im zweiten Anlauf klappt es – und auch „Gerät vertrauen“ ist danach weg (G4E-S02)
    await completePasswordReset(h.db, tokenOf(link!), { next: "Neues Passwort 2026", repeat: "Neues Passwort 2026" }, opts);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "lk2"))).toHaveLength(0);
    expect(await h.db.select().from(verifications).where(eq(verifications.id, "tv-lk2"))).toHaveLength(0);
  });

  it("Rate-Limit je Konto (3/h) und je IP (10/h)", async () => {
    const now = new Date();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await requestPasswordReset(h.db, "elt", { ...opts, ip: "198.51.100.9", now }));
    expect(results.slice(0, 3).every(Boolean)).toBe(true);
    expect(results[3]).toBeNull();
    for (let i = 0; i < 10; i++) await requestPasswordReset(h.db, "gibtsnicht", { ...opts, ip: "198.51.100.77", now });
    await h.db.update(users).set({ email: "elt2@example.org" }).where(eq(users.id, "elt"));
    expect(await requestPasswordReset(h.db, "lkr", { ...opts, ip: "198.51.100.77", now })).toBeNull();
  });
});
