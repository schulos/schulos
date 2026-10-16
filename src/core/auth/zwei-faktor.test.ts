import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { appSettings, auditLog, grants, groupMembers, groups, sessions, twoFactors, verifications } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { hasPermission, loadPermissions, requiresTwoFactor } from "@/core/permissions";
import { createAuth, createUserWithPassword, hashPassword, type Auth } from "./auth";
import { totpCode } from "@schulos/server/totp-code";
import { discardPendingTotpSetup, dropTrustedDevices } from "./geraete-vertrauen";
import {
  completeSecondFactor,
  confirmSetup,
  disableOwn,
  regenerateBackupCodes,
  resetTwoFactor,
  secondFactorSatisfied,
  sessionSecondFactorOk,
  startSetup,
  TwoFactorRequiredError,
  twoFactorStatus,
} from "./zwei-faktor";
import { groupSecret, secretFromUri } from "@schulos/server/two-factor";

const PW = "geheim123";

/** Cookies aus Set-Cookie in einen Cookie-Header übernehmen (wie ein Browser). */
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
    headers: () => new Headers({ cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }),
  };
}

describe("requiresTwoFactor", () => {
  it("Pflicht für Admin, Verwaltung und alle mit Verwaltungsrechten", () => {
    expect(requiresTwoFactor("admin", [])).toBe(true);
    expect(requiresTwoFactor("verwaltung", [])).toBe(true);
    expect(requiresTwoFactor("lehrkraft", ["verwaltung.*"])).toBe(true);
    expect(requiresTwoFactor("lehrkraft", ["verwaltung.privacy"])).toBe(true);
    expect(requiresTwoFactor("lehrkraft", ["*"])).toBe(true);
    expect(requiresTwoFactor("lehrkraft", ["news.manage", "klassenbuch.view_all"])).toBe(false);
    expect(requiresTwoFactor("schueler", [])).toBe(false);
  });

  it("Hilfsfunktionen für das Geheimnis", () => {
    expect(secretFromUri("otpauth://totp/SchulOS:x?secret=ABCDEFGH&issuer=SchulOS")).toBe("ABCDEFGH");
    expect(groupSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
});

describe("Zwei-Faktor-Anmeldung (Better-Auth twoFactor + PGlite)", () => {
  let h: DbHandle;
  let auth: Auth;

  async function signIn(username: string) {
    const c = jar();
    const { headers, response } = await auth.api.signInUsername({ body: { username, password: PW }, returnHeaders: true });
    c.take(headers);
    return { c, response: response as { twoFactorRedirect?: boolean; token?: string } };
  }

  /** Anmelden inkl. Code – liefert die Cookies der fertigen Sitzung. */
  async function signInWithCode(username: string, secret: string) {
    const s = await signIn(username);
    const r = await auth.api.verifyTOTP({ body: { code: totpCode(secret) }, headers: s.c.headers(), returnHeaders: true });
    s.c.take(r.headers);
    return s.c;
  }

  beforeAll(async () => {
    h = await createTestDb();
    auth = createAuth(h.db);
    const hash = await hashPassword(PW);
    await createUserWithPassword(h.db, { id: "lk", name: "Jana Brandt", username: "jana", role: "lehrkraft" }, { hash });
    await createUserWithPassword(h.db, { id: "vw", name: "Sabine K", username: "sabine", role: "verwaltung" }, { hash });
    await createUserWithPassword(h.db, { id: "sl", name: "Petra L", username: "petra", role: "lehrkraft" }, { hash });
    await h.db.insert(groups).values({ id: "g-sl", name: "Schulleitung", slug: "sl", kind: "gremium" });
    await h.db.insert(groupMembers).values({ groupId: "g-sl", userId: "sl", role: "leader" });
    await h.db.insert(grants).values({ permission: "verwaltung.*", groupId: "g-sl" });
    await h.db.insert(grants).values({ permission: "verwaltung.users", role: "verwaltung" });
  });
  afterAll(() => h.close());

  it("Pflicht-Konten ohne 2FA haben keine Rechte, Lehrkräfte schon; Demo-Instanzen erzwingen nicht", async () => {
    const vw = await loadPermissions(h.db, "vw");
    expect(vw.twoFactorPending).toBe(true);
    expect(hasPermission(vw, "verwaltung.users")).toBe(false);
    expect((await loadPermissions(h.db, "sl")).twoFactorPending).toBe(true);
    expect((await loadPermissions(h.db, "lk")).twoFactorPending).toBe(false);

    await h.db.insert(appSettings).values({ key: "demo", value: true });
    const demo = await loadPermissions(h.db, "vw");
    expect(demo.twoFactorPending).toBe(false);
    expect(hasPermission(demo, "verwaltung.users")).toBe(true);
    expect(await twoFactorStatus(h.db, demo)).toEqual({ enabled: false, required: true, enforced: false, dueOn: null, outsideOnly: false, totp: false, passkeys: 0 });
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
  });

  it("Einrichtung: Passwort nötig, aktiv erst nach richtigem Code; danach verlangt die Anmeldung den Code", async () => {
    const { c } = await signIn("sabine");
    await expect(startSetup(auth, c.headers(), "falsch!!")).rejects.toThrow();
    const setup = await startSetup(auth, c.headers(), PW);
    expect(setup.backupCodes).toHaveLength(10);
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/SchulOS:/);
    expect(setup.qrSvg).toContain("<svg");
    expect((await loadPermissions(h.db, "vw")).twoFactorPending).toBe(true);

    await expect(confirmSetup(h.db, auth, c.headers(), "vw", "000000")).rejects.toThrow();
    await confirmSetup(h.db, auth, c.headers(), "vw", totpCode(setup.secret));
    const perms = await loadPermissions(h.db, "vw");
    expect(perms.twoFactorPending).toBe(false);
    expect(hasPermission(perms, "verwaltung.users")).toBe(true);

    // neue Anmeldung: keine Sitzung, nur 2FA-Aufforderung
    const count = async () => (await h.db.select().from(sessions).where(eq(sessions.userId, "vw"))).length;
    const before = await count();
    const login = await signIn("sabine");
    expect(login.response.twoFactorRedirect).toBe(true);
    expect(await count()).toBe(before);
    await expect(auth.api.verifyTOTP({ body: { code: "123456" }, headers: login.c.headers() })).rejects.toThrow();
    const ok = await auth.api.verifyTOTP({ body: { code: totpCode(setup.secret) }, headers: login.c.headers() });
    expect(ok.token).toBeTruthy();
    expect(await count()).toBe(before + 1);

    // Wiederherstellungscode: nur einmal gültig
    const again = await signIn("sabine");
    await auth.api.verifyBackupCode({ body: { code: setup.backupCodes[0]! }, headers: again.c.headers() });
    const third = await signIn("sabine");
    await expect(auth.api.verifyBackupCode({ body: { code: setup.backupCodes[0]! }, headers: third.c.headers() })).rejects.toThrow();

    // Pflicht-Konto darf 2FA nicht selbst abschalten; neue Codes ersetzen die alten
    const s = await signInWithCode("sabine", setup.secret);
    await expect(disableOwn(h.db, auth, s.headers(), perms, PW)).rejects.toBeInstanceOf(TwoFactorRequiredError);
    const codes = await regenerateBackupCodes(h.db, auth, s.headers(), "vw", PW);
    expect(codes).toHaveLength(10);
    expect(codes).not.toContain(setup.backupCodes[1]);
    const actions = (await h.db.select().from(auditLog).where(eq(auditLog.target, "vw"))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["konto.2fa.eingerichtet", "konto.2fa.codes"]));
  });

  it("G5A-S04: Einrichten beendet andere Sitzungen; nur die Anmeldung mit Code kennzeichnet die Sitzung", async () => {
    const sessionsOf = () => h.db.select().from(sessions).where(eq(sessions.userId, "sl"));
    const other = await signIn("petra"); // z. B. Lehrerzimmer-PC, nur mit Passwort
    const { c } = await signIn("petra");
    expect(await sessionsOf()).toHaveLength(2);
    const setup = await startSetup(auth, c.headers(), PW);
    await confirmSetup(h.db, auth, c.headers(), "sl", totpCode(setup.secret));
    const after = await sessionsOf();
    expect(after).toHaveLength(1);
    expect(after[0]!.token).not.toBe(other.response.token);
    // die Sitzung aus der Einrichtung gilt nicht als „mit Code angemeldet“
    expect(after[0]!.secondFactorAt).toBeNull();
    expect(await sessionSecondFactorOk(h.db, after[0]!.id, "sl")).toBe(false);
    // Anmeldung mit Code bzw. Wiederherstellungscode kennzeichnet die neue Sitzung
    const login = await signIn("petra");
    await completeSecondFactor(h.db, auth, login.c.headers(), totpCode(setup.secret), false);
    const backup = await signIn("petra");
    await completeSecondFactor(h.db, auth, backup.c.headers(), setup.backupCodes[0]!, true);
    const marked = (await sessionsOf()).filter((s) => s.secondFactorAt !== null);
    expect(marked).toHaveLength(2);
    for (const s of marked) expect(await sessionSecondFactorOk(h.db, s.id, "sl")).toBe(true);
    // fremde Sitzung zählt nie
    expect(await sessionSecondFactorOk(h.db, marked[0]!.id, "lk")).toBe(false);
    // rein: Konto mit 2FA braucht die gekennzeichnete Sitzung (auch in Demo-Instanzen), ohne 2FA nur Demo
    expect(secondFactorSatisfied(true, true, false)).toBe(true);
    expect(secondFactorSatisfied(true, false, true)).toBe(false);
    expect(secondFactorSatisfied(false, false, true)).toBe(true);
    expect(secondFactorSatisfied(false, false, false)).toBe(false);
  });

  it("Lehrkraft richtet freiwillig ein und schaltet wieder ab", async () => {
    const { c } = await signIn("jana");
    const setup = await startSetup(auth, c.headers(), PW);
    await confirmSetup(h.db, auth, c.headers(), "lk", totpCode(setup.secret));
    expect((await signIn("jana")).response.twoFactorRedirect).toBe(true);
    const s = await signInWithCode("jana", setup.secret);
    await disableOwn(h.db, auth, s.headers(), await loadPermissions(h.db, "lk"), PW);
    expect((await signIn("jana")).response.token).toBeTruthy();
    expect(await h.db.select().from(twoFactors).where(eq(twoFactors.userId, "lk"))).toHaveLength(0);
  });

  it("G4E-S02: „Gerät vertrauen“ ersetzt nie den zweiten Faktor; Zurücksetzen räumt Vertrauens-Einträge weg", async () => {
    await createUserWithPassword(h.db, { id: "ida", name: "Ida Vogt", username: "ida", role: "lehrkraft" }, { hash: await hashPassword(PW) });
    const first = await signIn("ida");
    const setup = await startSetup(auth, first.c.headers(), PW);
    await confirmSetup(h.db, auth, first.c.headers(), "ida", totpCode(setup.secret));
    // Anmeldung mit Code und trustDevice (nur noch serverseitig erreichbar – die Oberfläche sendet es nie)
    const c = jar();
    const login = await auth.api.signInUsername({ body: { username: "ida", password: PW }, returnHeaders: true });
    c.take(login.headers);
    const ok = await auth.api.verifyTOTP({ body: { code: totpCode(setup.secret), trustDevice: true }, headers: c.headers(), returnHeaders: true });
    c.take(ok.headers);
    // dasselbe Gerät meldet sich erneut an: der zweite Faktor wird trotzdem verlangt
    const again = await auth.api.signInUsername({ body: { username: "ida", password: PW }, headers: c.headers() });
    expect((again as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const trust = await h.db.select().from(verifications).where(like(verifications.identifier, "trust-device-%"));
    for (const t of trust) expect(t.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    // ein (z. B. vor dem Update ausgestellter) Vertrauens-Eintrag übersteht das Zurücksetzen nicht
    await h.db.insert(verifications).values({ id: "tv-ida", identifier: "trust-device-alt", value: "ida", expiresAt: new Date(Date.now() + 86_400_000) });
    await h.db.insert(verifications).values({ id: "tv-lk", identifier: "trust-device-fremd", value: "lk", expiresAt: new Date(Date.now() + 86_400_000) });
    await resetTwoFactor(h.db, null, "ida");
    expect((await h.db.select().from(verifications).where(like(verifications.identifier, "trust-device-%"))).map((v) => v.value)).not.toContain("ida");
    expect(await dropTrustedDevices(h.db, "lk")).toBe(1);
  });

  it("G4E-S01: eine nie bestätigte Einrichtung lässt sich verwerfen; eine bestätigte bleibt", async () => {
    await createUserWithPassword(h.db, { id: "ole", name: "Ole Berg", username: "ole", role: "lehrkraft" }, { hash: await hashPassword(PW) });
    const { c } = await signIn("ole");
    await startSetup(auth, c.headers(), PW);
    expect(await h.db.select().from(twoFactors).where(eq(twoFactors.userId, "ole"))).toHaveLength(1);
    expect(await discardPendingTotpSetup(h.db, "ole")).toBe(true);
    expect(await h.db.select().from(twoFactors).where(eq(twoFactors.userId, "ole"))).toHaveLength(0);
    const setup = await startSetup(auth, c.headers(), PW);
    await confirmSetup(h.db, auth, c.headers(), "ole", totpCode(setup.secret));
    expect(await discardPendingTotpSetup(h.db, "ole")).toBe(false);
    expect(await h.db.select().from(twoFactors).where(eq(twoFactors.userId, "ole"))).toHaveLength(1);
  });

  it("Zurücksetzen durch die Verwaltung: Geheimnis weg, Sitzungen beendet, Pflicht greift wieder", async () => {
    await resetTwoFactor(h.db, null, "vw");
    expect(await h.db.select().from(twoFactors).where(eq(twoFactors.userId, "vw"))).toHaveLength(0);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "vw"))).toHaveLength(0);
    expect((await loadPermissions(h.db, "vw")).twoFactorPending).toBe(true);
    expect((await signIn("sabine")).response.token).toBeTruthy();
    const rows = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.user.2fa_reset"));
    expect(rows.map((r) => r.target)).toContain("vw");
  });
});
