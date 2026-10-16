import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, DbHandle } from "@/core/db/client";
import { auditLog, mailOutbox, passkeys, sessions, twoFactors, users, verifications } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { totpCode } from "@schulos/server/totp-code";
import { DISABLED_AUTH_PATHS } from "@schulos/server/auth-paths";
import { createAuth, createUserWithPassword, hashPassword, type Auth } from "./auth";
import { PASSKEY_2FA_PATHS } from "./passkey-plugin";
import { cleanName, finishRegistration, listPasskeys, PasskeyError, registrationOptions, relyingParty, removePasskey, secondFactorMethods } from "./passkeys";
import { fakeAuthenticator, type FakeAuthenticator } from "./passkeys.testing";
import {
  completePasskeySecondFactor,
  confirmSetup,
  disableOwn,
  passkeySignInOptions,
  resetTwoFactor,
  sessionSecondFactorOk,
  sessionTokenFrom,
  startSetup,
  TwoFactorRequiredError,
  twoFactorStatus,
} from "./zwei-faktor";

const PW = "geheim123";
const ORIGIN = "http://localhost:3000";
const RP = { rpID: "localhost", origin: ORIGIN };

/** Cookies aus Set-Cookie übernehmen (wie ein Browser); Origin wie bei einer Server Action. */
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
    headers: () => new Headers({ origin: ORIGIN, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }),
  };
}

describe("SEC-03 Sicherheitsschlüssel (WebAuthn-Attrappe + PGlite)", () => {
  let h: DbHandle;
  let auth: Auth;

  async function signIn(username: string) {
    const c = jar();
    const { headers, response } = await auth.api.signInUsername({ body: { username, password: PW }, returnHeaders: true, headers: c.headers() });
    c.take(headers);
    return { c, response: response as { twoFactorRedirect?: boolean; token?: string } };
  }

  async function currentSessionId(token: string | undefined) {
    const [s] = await h.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.token, token ?? ""));
    return s?.id ?? null;
  }

  async function register(userId: string, key: FakeAuthenticator, name = "Schlüssel blau", sessionId: string | null = null) {
    const options = await registrationOptions(h.db, userId, RP);
    return finishRegistration(h.db, { userId, currentSessionId: sessionId, response: key.register(options, ORIGIN), name, rp: RP });
  }

  /** Anmeldung: Passwort, dann Schlüssel – liefert die Cookies der fertigen Sitzung. */
  async function signInWithKey(username: string, key: FakeAuthenticator) {
    const s = await signIn(username);
    expect(s.response.twoFactorRedirect).toBe(true);
    const options = await passkeySignInOptions(auth, s.c.headers());
    const r = await auth.api.verifyPasskeySecondFactor({
      body: { response: { ...key.authenticate(options, ORIGIN) } },
      headers: s.c.headers(),
      returnHeaders: true,
    });
    s.c.take(r.headers);
    return s.c;
  }

  beforeAll(async () => {
    h = await createTestDb();
    auth = createAuth(h.db);
    const hash = await hashPassword(PW);
    await createUserWithPassword(
      h.db,
      { id: "lk", name: "Jana Brandt", username: "jana", role: "lehrkraft", email: "jana@example.org", emailVerified: true },
      { hash },
    );
    await createUserWithPassword(h.db, { id: "vw", name: "Sabine K", username: "sabine", role: "verwaltung" }, { hash });
    await createUserWithPassword(h.db, { id: "el", name: "Eva Eltern", username: "eva", role: "eltern" }, { hash });
  });
  afterAll(() => h.close());

  it("Endpunkte nur per Server Action, nicht über HTTP", () => {
    for (const p of PASSKEY_2FA_PATHS) expect(DISABLED_AUTH_PATHS).toContain(p);
  });

  it("relyingParty: öffentliche Adresse aus BETTER_AUTH_URL, sonst die Adresse der Anfrage", () => {
    const h1 = new Headers({ origin: "http://localhost:3130" });
    expect(relyingParty(h1, { BETTER_AUTH_URL: "https://schule.example.org" })).toEqual({ rpID: "schule.example.org", origin: "https://schule.example.org" });
    expect(relyingParty(h1, {})).toEqual({ rpID: "localhost", origin: "http://localhost:3130" });
    expect(cleanName("  ")).toBe("Sicherheitsschlüssel");
    expect(cleanName(" Mein   Schlüssel ")).toBe("Mein Schlüssel");
  });

  it("erster Schlüssel = 2FA eingerichtet: andere Sitzungen enden, Hinweis-Mail, Anmeldung verlangt danach den Schlüssel", async () => {
    const other = await signIn("jana");
    const mine = await signIn("jana");
    const key = fakeAuthenticator();
    const res = await register("lk", key, "Schlüssel blau", await currentSessionId(mine.response.token));
    expect(res.first).toBe(true);
    const [u] = await h.db.select().from(users).where(eq(users.id, "lk"));
    expect(u!.twoFactorEnabled).toBe(true);
    const left = await h.db.select().from(sessions).where(eq(sessions.userId, "lk"));
    expect(left.map((s) => s.token)).toEqual([mine.response.token]);
    expect(left.map((s) => s.token)).not.toContain(other.response.token);
    expect((await listPasskeys(h.db, "lk")).map((k) => k.name)).toEqual(["Schlüssel blau"]);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, "jana@example.org"));
    expect(mails.map((m) => m.subject)).toEqual([expect.stringContaining("Zwei-Faktor-Anmeldung wurde eingerichtet")]);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.target, "lk"))).map((r) => r.action)).toContain("konto.2fa.eingerichtet");

    // Anmeldung: Passwort allein reicht nicht mehr; mit Schlüssel → Sitzung „mit zweitem Faktor“ (Notenbuch)
    const s = await signIn("jana");
    expect(s.response.twoFactorRedirect).toBe(true);
    const options = await passkeySignInOptions(auth, s.c.headers());
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([key.credentialId]);
    const before = (await h.db.select().from(sessions).where(eq(sessions.userId, "lk"))).length;
    await completePasskeySecondFactor(h.db, auth, s.c.headers(), key.authenticate(options, ORIGIN));
    const all = await h.db.select().from(sessions).where(eq(sessions.userId, "lk"));
    expect(all).toHaveLength(before + 1);
    const marked = all.filter((x) => x.secondFactorAt !== null);
    expect(marked).toHaveLength(1);
    expect(await sessionSecondFactorOk(h.db, marked[0]!.id, "lk")).toBe(true);
    const [k] = await h.db.select().from(passkeys).where(eq(passkeys.userId, "lk"));
    expect(k!.counter).toBe(1);
    expect(k!.lastUsedAt).not.toBeNull();
    // dieselbe angefangene Anmeldung gilt nur einmal
    await expect(passkeySignInOptions(auth, s.c.headers())).rejects.toThrow();
  });

  it("Einrichtung: Aufforderung nur einmal, nur für diese Adresse, kein Schlüssel doppelt; zweiter Schlüssel ohne Sitzungsende", async () => {
    const key = fakeAuthenticator();
    // falsche Adresse (nachgemachte Seite)
    const o1 = await registrationOptions(h.db, "lk", RP);
    await expect(
      finishRegistration(h.db, { userId: "lk", currentSessionId: null, response: key.register(o1, "https://falsch.example"), name: "x", rp: RP }),
    ).rejects.toBeInstanceOf(PasskeyError);
    // Aufforderung ist verbraucht
    await expect(finishRegistration(h.db, { userId: "lk", currentSessionId: null, response: key.register(o1, ORIGIN), name: "x", rp: RP })).rejects.toThrow(
      /abgelaufen/,
    );
    // abgelaufen
    const o2 = await registrationOptions(h.db, "lk", RP, new Date(Date.now() - 600_000));
    await expect(finishRegistration(h.db, { userId: "lk", currentSessionId: null, response: key.register(o2, ORIGIN), name: "x", rp: RP })).rejects.toThrow(
      /abgelaufen/,
    );
    // vorhandene Schlüssel sind ausgeschlossen
    const o3 = await registrationOptions(h.db, "lk", RP);
    expect(o3.excludeCredentials).toHaveLength(1);
    const sessionsBefore = (await h.db.select().from(sessions).where(eq(sessions.userId, "lk"))).length;
    const res = await finishRegistration(h.db, { userId: "lk", currentSessionId: null, response: key.register(o3, ORIGIN), name: "Handy", rp: RP });
    expect(res.first).toBe(false);
    expect((await h.db.select().from(sessions).where(eq(sessions.userId, "lk"))).length).toBe(sessionsBefore);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, "jana@example.org"));
    expect(mails.map((m) => m.subject)).toContainEqual(expect.stringContaining("Neuer Sicherheitsschlüssel"));
    // derselbe Schlüssel ein zweites Mal
    const o4 = await registrationOptions(h.db, "lk", RP);
    await expect(finishRegistration(h.db, { userId: "lk", currentSessionId: null, response: key.register(o4, ORIGIN), name: "x", rp: RP })).rejects.toThrow(
      /schon eingerichtet/,
    );
    expect(await secondFactorMethods(h.db, "lk")).toEqual({ totp: false, passkeys: 2 });
    // keine Aufforderungen bleiben liegen
    expect(await h.db.select().from(verifications).where(eq(verifications.identifier, "passkey-einrichten:lk"))).toHaveLength(0);
  });

  it("Anmeldung: fremder Schlüssel, falsche Adresse und wiederholte Antwort werden abgelehnt", async () => {
    const mine = fakeAuthenticator();
    await register("el", mine, "Eltern-Schlüssel");
    const foreign = fakeAuthenticator();
    await register("vw", foreign, "Verwaltung");

    const s = await signIn("eva");
    // Schlüssel eines anderen Kontos
    const o1 = await passkeySignInOptions(auth, s.c.headers());
    await expect(completePasskeySecondFactor(h.db, auth, s.c.headers(), foreign.authenticate(o1, ORIGIN))).rejects.toThrow(/nicht zu deinem Konto/);
    // falsche Adresse
    const o2 = await passkeySignInOptions(auth, s.c.headers());
    await expect(completePasskeySecondFactor(h.db, auth, s.c.headers(), mine.authenticate(o2, "https://falsch.example"))).rejects.toThrow(/nicht erkannt/);
    // Antwort auf eine alte Aufforderung (Challenge verbraucht)
    const o3 = await passkeySignInOptions(auth, s.c.headers());
    const answer = mine.authenticate(o3, ORIGIN);
    await passkeySignInOptions(auth, s.c.headers()); // neue Aufforderung ersetzt die alte
    await expect(completePasskeySecondFactor(h.db, auth, s.c.headers(), answer)).rejects.toThrow(/nicht erkannt/);
    // geklonter Schlüssel: Zähler läuft nicht vorwärts
    const ok = await signInWithKey("eva", mine);
    expect(ok.headers().get("cookie")).toContain("session_token");
    const again = await signIn("eva");
    const o4 = await passkeySignInOptions(auth, again.c.headers());
    await expect(completePasskeySecondFactor(h.db, auth, again.c.headers(), mine.authenticate(o4, ORIGIN, { counter: 1 }))).rejects.toThrow(/nicht erkannt/);
    // ohne angefangene Anmeldung keine Optionen
    await expect(passkeySignInOptions(auth, jar().headers())).rejects.toThrow();
  });

  it("Pflicht: Schlüssel zählt; der letzte zweite Faktor lässt sich bei Pflicht nicht entfernen, sonst ist 2FA danach aus", async () => {
    // Verwaltung (Pflicht) mit nur einem Schlüssel: keine Sperre
    const vw = await loadPermissions(h.db, "vw");
    expect(vw.twoFactorPending).toBe(false);
    const status = await twoFactorStatus(h.db, vw);
    expect(status).toMatchObject({ enabled: true, enforced: true, totp: false, passkeys: 1 });
    const [only] = await listPasskeys(h.db, "vw");
    await expect(removePasskey(h.db, "vw", only!.id, status.enforced)).rejects.toThrow(/einziger zweiter Faktor/);
    // fremder Schlüssel: gibt es „nicht“
    await expect(removePasskey(h.db, "el", only!.id, false)).rejects.toThrow(/gibt es nicht/);
    // Eltern ohne Pflicht (vor dem Stichtag gibt es keinen – hier freiwillig): letzter Schlüssel weg → 2FA aus
    const [elKey] = await listPasskeys(h.db, "el");
    expect(await removePasskey(h.db, "el", elKey!.id, false)).toEqual({ twoFactorOff: true });
    const [el] = await h.db.select().from(users).where(eq(users.id, "el"));
    expect(el!.twoFactorEnabled).toBe(false);
    expect((await signIn("eva")).response.token).toBeTruthy();
  });

  it("Code-App neben dem Schlüssel; Code-App ausschalten lässt 2FA an (auch bei Pflicht); Zurücksetzen löscht auch Schlüssel", async () => {
    const key = fakeAuthenticator();
    const vwKey = await listPasskeys(h.db, "vw");
    expect(vwKey).toHaveLength(1);
    // Verwaltung: Schlüssel von oben ist nicht als Attrappe greifbar – neu einrichten
    await removePasskey(h.db, "vw", vwKey[0]!.id, false);
    await register("vw", key, "Verwaltung neu");
    const c = await signInWithKey("sabine", key);
    const setup = await startSetup(auth, c.headers(), PW);
    await confirmSetup(h.db, auth, c.headers(), "vw", totpCode(setup.secret));
    expect(await secondFactorMethods(h.db, "vw")).toEqual({ totp: true, passkeys: 1 });
    // Anmeldung geht jetzt mit Code oder Schlüssel
    const c2 = await signInWithKey("sabine", key);
    const perms = await loadPermissions(h.db, "vw");
    await disableOwn(h.db, auth, c2.headers(), perms, PW);
    expect(await h.db.select().from(twoFactors).where(eq(twoFactors.userId, "vw"))).toHaveLength(0);
    const [u] = await h.db.select().from(users).where(eq(users.id, "vw"));
    expect(u!.twoFactorEnabled).toBe(true);
    expect((await signIn("sabine")).response.twoFactorRedirect).toBe(true);
    // ohne Schlüssel und mit Pflicht: Code-App ausschalten verboten (wie bisher)
    const c3 = await signInWithKey("sabine", key);
    const setup2 = await startSetup(auth, c3.headers(), PW);
    await confirmSetup(h.db, auth, c3.headers(), "vw", totpCode(setup2.secret));
    await h.db.delete(passkeys).where(eq(passkeys.userId, "vw"));
    await expect(disableOwn(h.db, auth, c3.headers(), perms, PW)).rejects.toBeInstanceOf(TwoFactorRequiredError);

    await register("vw", fakeAuthenticator(), "noch einer");
    await resetTwoFactor(h.db, null, "vw");
    expect(await secondFactorMethods(h.db, "vw")).toEqual({ totp: false, passkeys: 0 });
    expect((await loadPermissions(h.db, "vw")).twoFactorPending).toBe(true);
  });

  it("G4E-C08: Code-App ausschalten (Schlüssel bleibt) – die neue Sitzung bleibt „mit zweitem Faktor“", async () => {
    await createUserWithPassword(h.db, { id: "pia", name: "Pia Kurz", username: "pia", role: "lehrkraft" }, { hash: await hashPassword(PW) });
    const key = fakeAuthenticator();
    await register("pia", key, "Pia");
    const c = await signInWithKey("pia", key);
    const setup = await startSetup(auth, c.headers(), PW);
    await confirmSetup(h.db, auth, c.headers(), "pia", totpCode(setup.secret));
    const c2 = await signInWithKey("pia", key);
    // die Anmeldung mit Schlüssel kennzeichnet die Sitzung (completePasskeySecondFactor)
    const t0 = new Date("2026-10-14T08:00:00Z");
    await h.db.update(sessions).set({ secondFactorAt: t0 }).where(eq(sessions.userId, "pia"));
    const before = new Set((await h.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, "pia"))).map((s) => s.id));
    await disableOwn(h.db, auth, c2.headers(), await loadPermissions(h.db, "pia"), PW);
    const fresh = (await h.db.select().from(sessions).where(eq(sessions.userId, "pia"))).filter((s) => !before.has(s.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.secondFactorAt).toEqual(t0);
    expect(await sessionSecondFactorOk(h.db, fresh[0]!.id, "pia")).toBe(true);
    expect(sessionTokenFrom(new Headers([["set-cookie", "better-auth.session_token=abc.sig%3D; Path=/"]]))).toBe("abc");
  });

  it("G4E-C09: gleichzeitiges Entfernen beider Faktoren lässt 2FA nie „an“ ohne Faktor", async () => {
    await createUserWithPassword(h.db, { id: "rob", name: "Rob Lang", username: "rob", role: "lehrkraft" }, { hash: await hashPassword(PW) });
    const enabled = async () => (await h.db.select({ on: users.twoFactorEnabled }).from(users).where(eq(users.id, "rob")))[0]!.on;
    /** Code-App + Schlüssel einrichten; liefert eine frische Sitzung (mit Schlüssel angemeldet) */
    async function both(): Promise<ReturnType<typeof jar>> {
      const key = fakeAuthenticator();
      await register("rob", key, "Rob");
      const c = await signInWithKey("rob", key);
      const setup = await startSetup(auth, c.headers(), PW);
      await confirmSetup(h.db, auth, c.headers(), "rob", totpCode(setup.secret));
      expect(await secondFactorMethods(h.db, "rob")).toEqual({ totp: true, passkeys: 1 });
      return signInWithKey("rob", key);
    }
    // a) Schlüssel entfernen – zwischen Prüfung und Löschen schaltet ein zweiter Tab die Code-App aus
    await both();
    const [k] = await listPasskeys(h.db, "rob");
    const racingDb = new Proxy(h.db, {
      get(t, p) {
        if (p === "transaction")
          return async (fn: Parameters<Db["transaction"]>[0]) => {
            await h.db.delete(twoFactors).where(eq(twoFactors.userId, "rob"));
            return t.transaction(fn);
          };
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect(await removePasskey(racingDb, "rob", k!.id, false)).toEqual({ twoFactorOff: true });
    expect(await secondFactorMethods(h.db, "rob")).toEqual({ totp: false, passkeys: 0 });
    expect(await enabled()).toBe(false);
    // b) Code-App ausschalten – währenddessen entfernt ein zweiter Tab den (einzigen) Schlüssel
    const c = await both();
    const racingAuth = {
      ...auth,
      api: {
        ...auth.api,
        disableTwoFactor: (async (a: Parameters<Auth["api"]["disableTwoFactor"]>[0]) => {
          await h.db.delete(passkeys).where(eq(passkeys.userId, "rob"));
          return auth.api.disableTwoFactor(a);
        }) as Auth["api"]["disableTwoFactor"],
      },
    } as Auth;
    await disableOwn(h.db, racingAuth, c.headers(), await loadPermissions(h.db, "rob"), PW);
    expect(await secondFactorMethods(h.db, "rob")).toEqual({ totp: false, passkeys: 0 });
    expect(await enabled()).toBe(false);
  });
});
