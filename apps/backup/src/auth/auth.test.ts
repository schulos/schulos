import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THROTTLE } from "@schulos/server/throttle";
import { totpCode } from "@schulos/server/totp-code";
import type { DbHandle } from "@/db/client";
import { auditLog, authThrottle, sessions, users } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { createAuth, createUserWithPassword, hashPassword, type Auth } from "./auth";
import { activeLock, recordFailure } from "./throttle";
import { confirmSetup, regenerateBackupCodes, startSetup } from "./two-factor";

const PW = "Tafel Kreide Pause";

/** Minimaler Cookie-Speicher für die Better-Auth-API im Test. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    take(h: Headers) {
      for (const c of h.getSetCookie()) {
        const [pair] = c.split(";");
        const [name, ...v] = pair!.split("=");
        const value = v.join("=");
        if (!value || /max-age=0/i.test(c)) cookies.delete(name!);
        else cookies.set(name!, value);
      }
    },
    names: () => [...cookies.keys()],
    headers: () => new Headers({ cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }),
  };
}

describe("Anmeldung am Backupserver (Better-Auth + PGlite)", () => {
  let h: DbHandle;
  let auth: Auth;

  async function signIn(username: string, password = PW) {
    const c = jar();
    const { headers, response } = await auth.api.signInUsername({ body: { username, password }, returnHeaders: true });
    c.take(headers);
    return { c, response: response as { twoFactorRedirect?: boolean; token?: string } };
  }

  beforeAll(async () => {
    h = await createTestDb();
    auth = createAuth(h.db);
    const hash = await hashPassword(PW);
    await createUserWithPassword(h.db, { id: "a1", username: "it.admin", firstName: "Ina", lastName: "Tech" }, { hash });
    await createUserWithPassword(h.db, { id: "a2", username: "zweit", firstName: "Zoe", lastName: "Zweit" }, { hash });
  });
  afterAll(() => h.close());

  it("eigener Cookie-Präfix – kollidiert nicht mit der Sitzung des Hauptsystems auf demselben Host", async () => {
    const { c } = await signIn("it.admin");
    expect(c.names().every((n) => n.startsWith("schulos-backup."))).toBe(true);
    expect(c.names().length).toBeGreaterThan(0);
  });

  it("Einrichtung des zweiten Faktors; danach verlangt die Anmeldung den Code, Anmeldungen stehen im Protokoll", async () => {
    const { c } = await signIn("it.admin");
    await expect(startSetup(auth, c.headers(), "falsch!!")).rejects.toThrow();
    const setup = await startSetup(auth, c.headers(), PW);
    expect(setup.backupCodes).toHaveLength(10);
    expect(setup.qrSvg).toContain("<svg");
    await expect(confirmSetup(h.db, auth, c.headers(), "a1", "000000")).rejects.toThrow();
    await confirmSetup(h.db, auth, c.headers(), "a1", totpCode(setup.secret));

    const count = async () => (await h.db.select().from(sessions).where(eq(sessions.userId, "a1"))).length;
    const before = await count();
    const login = await signIn("it.admin");
    expect(login.response.twoFactorRedirect).toBe(true);
    expect(await count()).toBe(before);
    const ok = await auth.api.verifyTOTP({ body: { code: totpCode(setup.secret) }, headers: login.c.headers(), returnHeaders: true });
    login.c.take(ok.headers);
    expect(await count()).toBe(before + 1);

    const codes = await regenerateBackupCodes(h.db, auth, login.c.headers(), "a1", PW);
    expect(codes).toHaveLength(10);
    expect(codes).not.toContain(setup.backupCodes[0]);

    const actions = (await h.db.select().from(auditLog).where(eq(auditLog.actorId, "a1"))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["konto.anmeldung", "konto.2fa.eingerichtet", "konto.2fa.codes"]));
  });

  it("sperrt nach zu vielen Fehlversuchen – auch das richtige Passwort, bis die Sperre abläuft", async () => {
    for (let i = 0; i < THROTTLE.maxPerUser; i++) await expect(signIn("zweit", "falsch-falsch")).rejects.toThrow();
    await expect(signIn("zweit")).rejects.toThrow(/Zu viele Fehlversuche/);
    const locked = await h.db.select().from(auditLog).where(eq(auditLog.action, "konto.anmeldung.gesperrt"));
    expect(locked.map((a) => a.target)).toEqual(["a2"]);
  });

  it("gleichzeitige Fehlversuche zählen alle (atomar in der DB) – genau ein Audit-Eintrag beim Sperrbeginn", async () => {
    await Promise.all(Array.from({ length: THROTTLE.maxPerUser + 2 }, () => recordFailure(h.db, "it.admin", "10.7.7.7")));
    const [row] = await h.db.select().from(authThrottle).where(eq(authThrottle.key, "u:it.admin"));
    expect(row?.failures).toBe(THROTTLE.maxPerUser + 2);
    expect(row?.lockedUntil).not.toBeNull();
    const locked = await h.db.select().from(auditLog).where(eq(auditLog.action, "konto.anmeldung.gesperrt"));
    expect(locked.map((a) => a.target)).toEqual(["a2", "a1"]);
  });

  it("über HTTP nur die Anmeldung per Benutzername – keine E-Mail-Anmeldung, keine Selbständerung, kein 2FA-Abschalten (SEC-04)", async () => {
    await createUserWithPassword(h.db, { id: "a3", username: "dritt", firstName: "Dora", lastName: "Dritt" }, { hash: await hashPassword(PW) });
    const post = (path: string, body: unknown, cookie?: string) =>
      auth.handler(
        new Request(`http://localhost:3100/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3100", ...(cookie ? { cookie } : {}) },
          body: JSON.stringify(body),
        }),
      );
    expect((await post("/sign-in/email", { email: "dritt@backup.schulos.local", password: PW })).status).toBe(404);
    const res = await post("/sign-in/username", { username: "dritt", password: PW });
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    for (const path of ["/update-user", "/two-factor/disable", "/change-password", "/delete-user"]) {
      expect((await post(path, { name: "Andere Person", username: "it.admin", password: PW }, cookie)).status, path).toBe(404);
    }
    const [u] = await h.db.select({ name: users.name }).from(users).where(eq(users.id, "a3"));
    expect(u?.name).toBe("Dora Dritt");
  });

  it("IP-Sperre trifft unbekannte Namen, nicht ein Konto ohne Fehlversuche (SEC-04)", async () => {
    for (let i = 0; i < THROTTLE.maxPerIp; i++) await recordFailure(h.db, `name${i}`, "10.9.9.9");
    expect(await activeLock(h.db, "gibtsnicht", "10.9.9.9")).not.toBeNull();
    expect(await activeLock(h.db, "dritt", "10.9.9.9")).toBeNull();
  });
});
