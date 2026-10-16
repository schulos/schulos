import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { accounts, sessions, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { createAuth, createUserWithPassword, hashPassword, type Auth } from "./auth";

describe("Auth (Better-Auth + PGlite)", () => {
  let h: DbHandle;
  let auth: Auth;
  beforeAll(async () => {
    h = await createTestDb();
    auth = createAuth(h.db);
    const hash = await hashPassword("geheim123");
    await createUserWithPassword(h.db, { id: "u1", name: "Jana Brandt", username: "Jana.Brandt", role: "lehrkraft" }, { hash });
    await createUserWithPassword(h.db, { id: "u2", name: "Gesperrt", username: "gesperrt", status: "locked" }, { hash });
  });
  afterAll(() => h.close());

  it("legt Benutzer mit normalisiertem Benutzernamen und Passwort-Konto an", async () => {
    const [u] = await h.db.select().from(users).where(eq(users.id, "u1"));
    expect(u?.username).toBe("jana.brandt");
    expect(u?.email).toBe("jana.brandt@schulos.local");
    const acc = await h.db.select().from(accounts).where(eq(accounts.userId, "u1"));
    expect(acc[0]?.providerId).toBe("credential");
  });

  it("meldet mit richtigem Passwort an (Groß/Klein egal) und legt eine Session an", async () => {
    const res = await auth.api.signInUsername({ body: { username: "JANA.BRANDT", password: "geheim123" } });
    expect(res?.token).toBeTruthy();
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "u1"))).toHaveLength(1);
  });

  it("weist ein falsches Passwort ab", async () => {
    await expect(auth.api.signInUsername({ body: { username: "jana.brandt", password: "falsch!!" } })).rejects.toThrow();
  });

  it("weist gesperrte Konten ab", async () => {
    await expect(auth.api.signInUsername({ body: { username: "gesperrt", password: "geheim123" } })).rejects.toThrow(/gesperrt/);
  });

  describe("HTTP-Endpunkte (SEC-04)", () => {
    const post = (path: string, body: unknown, cookie?: string) =>
      auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
          body: JSON.stringify(body),
        }),
      );

    it("Anmeldung per Benutzername geht, per E-Mail nicht", async () => {
      expect((await post("/sign-in/email", { email: "jana.brandt@schulos.local", password: "geheim123" })).status).toBe(404);
      expect((await post("/sign-in/username", { username: "jana.brandt", password: "geheim123" })).status).toBe(200);
    });

    it("Name und Benutzername lassen sich nicht selbst ändern, 2FA nicht an den Formularen vorbei abschalten", async () => {
      const res = await post("/sign-in/username", { username: "jana.brandt", password: "geheim123" });
      const cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      for (const [path, body] of [
        ["/update-user", { name: "Petra Lindner (Schulleitung)" }],
        ["/update-user", { username: "petra.lindner" }],
        ["/change-email", { newEmail: "x@example.org" }],
        ["/delete-user", {}],
        ["/two-factor/disable", { password: "geheim123" }],
        // G4E-S01/S02: Geheimnis abrufen und Codes prüfen (inkl. trustDevice) nur über die Server Actions
        ["/two-factor/get-totp-uri", { password: "geheim123" }],
        ["/two-factor/verify-totp", { code: "123456", trustDevice: true }],
        ["/two-factor/verify-backup-code", { code: "abcde-fghij", trustDevice: true }],
        ["/change-password", { currentPassword: "geheim123", newPassword: "neuesgeheim123" }],
      ] as const) {
        expect((await post(path, body, cookie)).status, path).toBe(404);
      }
      const [u] = await h.db.select({ name: users.name, username: users.username }).from(users).where(eq(users.id, "u1"));
      expect(u).toEqual({ name: "Jana Brandt", username: "jana.brandt" });
    });

    it("die E-Mail-Anmeldung im Server zählt in dieselbe Sperre wie der Benutzername", async () => {
      await createUserWithPassword(h.db, { id: "u3", name: "Mail Test", username: "mail.test", role: "lehrkraft" }, { hash: await hashPassword("geheim123") });
      for (let i = 0; i < 5; i++) await expect(auth.api.signInEmail({ body: { email: "mail.test@schulos.local", password: "falsch!!" } })).rejects.toThrow();
      await expect(auth.api.signInUsername({ body: { username: "mail.test", password: "geheim123" } })).rejects.toThrow(/Zu viele Fehlversuche/);
      await expect(auth.api.signInEmail({ body: { email: "mail.test@schulos.local", password: "geheim123" } })).rejects.toThrow(/Zu viele Fehlversuche/);
    });
  });

  it("erlaubt keine Selbstregistrierung", async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: "neu@test.de", password: "geheim123", name: "Neu" } }),
    ).rejects.toThrow();
  });
});
