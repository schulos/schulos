import { and, desc, eq, ne } from "drizzle-orm";
import { renderSVG } from "uqr";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { passkeys, sessions, twoFactorCodeLists, twoFactors, users } from "@/core/db/schema";
import { notify } from "@/core/notifications";
import { guardianRecipients } from "@/core/school/majority";
import { enqueueMail } from "@/core/mail";
import { twoFactorEnabledMail } from "@/core/mail-templates";
import { isDemoDb, twoFactorDuty, type PermissionSet } from "@/core/permissions";
import { endLiveStreams } from "@/core/notifications/bus";
import { readSchoolSettings, readSecuritySettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import { realEmail } from "./email";
import { SETUP_RELEASE_HOURS } from "./pflicht";
import { assertMayManage, loadActor } from "@/modules/verwaltung/escalation";
import { secretFromUri } from "@schulos/server/two-factor";
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import type { Auth } from "./auth";
import { lockTwoFactorState, secondFactorMethods, syncTwoFactorEnabled } from "./passkeys";
import { dropTrustedDevices } from "./geraete-vertrauen";

export interface TwoFactorStatus {
  enabled: boolean;
  /** Pflicht für dieses Konto (Rolle/Rechte) */
  required: boolean;
  /** Pflicht wird durchgesetzt (nicht in Demo-Instanzen) */
  enforced: boolean;
  /** SEC-01: Pflicht ab diesem Tag (Übergangsfrist), sonst null */
  dueOn: string | null;
  /** SEC-01: Pflicht nur bei Anmeldung von außerhalb des Schulnetzes (Schüler:innen) */
  outsideOnly: boolean;
  /** SEC-03: Code-App bestätigt eingerichtet */
  totp: boolean;
  /** SEC-03: Anzahl Sicherheitsschlüssel/Passkeys */
  passkeys: number;
}

export async function twoFactorStatus(db: Db, perms: PermissionSet, now = new Date()): Promise<TwoFactorStatus> {
  const [u] = await db.select({ enabled: users.twoFactorEnabled }).from(users).where(eq(users.id, perms.userId));
  const duty = twoFactorDuty(perms.role, perms.granted, (await readSecuritySettings(db)).twoFactorFrom, toBerlinDate(now));
  const demo = await isDemoDb(db);
  const methods = await secondFactorMethods(db, perms.userId);
  return {
    enabled: Boolean(u?.enabled),
    required: duty.required,
    enforced: duty.required && !demo,
    dueOn: demo ? null : duty.dueOn,
    outsideOnly: duty.outsideOnly,
    totp: methods.totp,
    passkeys: methods.passkeys,
  };
}

export interface SetupData {
  uri: string;
  secret: string;
  qrSvg: string;
  backupCodes: string[];
}

/**
 * Schritt 1 der Einrichtung (Passwort zur Bestätigung): legt Geheimnis und Wiederherstellungscodes an.
 * Aktiv wird 2FA erst mit dem ersten richtigen Code (confirmSetup) – bis dahin gilt die Anmeldung ohne Code.
 */
export async function startSetup(auth: Auth, headers: Headers, password: string): Promise<SetupData> {
  const res = await auth.api.enableTwoFactor({ body: { password, method: "totp" }, headers });
  if (res.method !== "totp") throw new Error("TOTP erwartet");
  return {
    uri: res.totpURI,
    secret: secretFromUri(res.totpURI),
    qrSvg: renderSVG(res.totpURI, { border: 2 }),
    backupCodes: res.backupCodes,
  };
}

/**
 * Schritt 2: erster richtiger Code schaltet 2FA ein. Better Auth tauscht dabei die Sitzung aus; GATE-5a (G5A-S04): alle
 * **anderen** Sitzungen der Person enden (sie entstanden nur mit Passwort). Die neue Sitzung gilt nicht als „mit zweitem
 * Faktor angemeldet“ – Bereiche, die das verlangen (Notenbuch), fordern eine neue Anmeldung mit Code.
 */
export async function confirmSetup(db: Db, auth: Auth, headers: Headers, userId: string, code: string): Promise<void> {
  await auth.api.verifyTOTP({ body: { code: code.replace(/\s/g, "") }, headers });
  const [current] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt)).limit(1);
  const ended = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), current ? ne(sessions.id, current.id) : undefined))
    .returning({ id: sessions.id });
  if (ended.length) endLiveStreams(userId);
  // G4E-S02: kein „Gerät vertrauen“ aus der Zeit davor
  await dropTrustedDevices(db, userId);
  // SEC-01: eine Freigabe der Verwaltung gilt nur für diese eine Einrichtung
  await db.update(users).set({ twoFactorSetupUntil: null }).where(eq(users.id, userId));
  await audit(db, userId, "konto.2fa.eingerichtet", userId, ended.length ? { sitzungenBeendet: ended.length } : undefined);
  await notifyTwoFactorEnabled(db, userId);
}

/**
 * SEC-01 (Q-5A-30): Hinweis-Mail „Zwei-Faktor-Anmeldung wurde eingerichtet“ an die **bestätigte** echte Adresse – wer nur das
 * Passwort erbeutet und 2FA für sich eingerichtet hat, fällt so der Person selbst auf. Ohne bestätigte Adresse keine Mail.
 */
export async function notifyTwoFactorEnabled(db: Db, userId: string, now = new Date()): Promise<boolean> {
  const [u] = await db.select({ name: users.name, email: users.email, verified: users.emailVerified }).from(users).where(eq(users.id, userId));
  const to = u?.verified ? realEmail(u.email) : null;
  if (!u || !to) return false;
  await enqueueMail(db, { to, ...twoFactorEnabledMail({ school: (await readSchoolSettings(db)).name, name: u.name }), purpose: "2fa-eingerichtet" }, now);
  return true;
}

/**
 * Q-5A-30: Die Verwaltung erlaubt einer Person, die 2FA von außerhalb des Schulnetzes einzurichten (48 h). Nur für Konten
 * ohne 2FA; Konten mit mehr Rechten nur durch Admins (wie beim Zurücksetzen).
 */
export async function releaseExternalSetup(db: Db, actorId: string, userId: string, now = new Date()): Promise<Date> {
  await assertMayManage(db, await loadActor(db, actorId), userId, "twoFactor");
  const [u] = await db.select({ enabled: users.twoFactorEnabled }).from(users).where(eq(users.id, userId));
  if (!u) throw new Error("Konto gibt es nicht");
  if (u.enabled) throw new TwoFactorSetupError("Für dieses Konto ist die Zwei-Faktor-Anmeldung schon eingerichtet.");
  const until = new Date(now.getTime() + SETUP_RELEASE_HOURS * 3_600_000);
  await db.update(users).set({ twoFactorSetupUntil: until }).where(eq(users.id, userId));
  await audit(db, actorId, "verwaltung.user.2fa_freigabe", userId);
  return until;
}

export class TwoFactorSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwoFactorSetupError";
  }
}

/**
 * G5A-S04: Anmeldung mit zweitem Faktor abschließen (Code aus der App bzw. Wiederherstellungscode) und die neue Sitzung als
 * „mit zweitem Faktor angemeldet“ kennzeichnen (`sessions.second_factor_at`).
 */
export async function completeSecondFactor(db: Db, auth: Auth, headers: Headers, code: string, backup: boolean, now = new Date()): Promise<void> {
  const res = backup ? await auth.api.verifyBackupCode({ body: { code }, headers }) : await auth.api.verifyTOTP({ body: { code }, headers });
  const token = (res as { token?: string } | null)?.token;
  if (token) await db.update(sessions).set({ secondFactorAt: now }).where(eq(sessions.token, token));
}

/** SEC-03: Optionen für den Sicherheitsschlüssel der angefangenen Anmeldung (Cookie nach richtigem Passwort). */
export async function passkeySignInOptions(auth: Auth, headers: Headers): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return (await auth.api.passkeySecondFactorOptions({ headers })) as PublicKeyCredentialRequestOptionsJSON;
}

/** SEC-03: Anmeldung mit Sicherheitsschlüssel abschließen – die Sitzung gilt wie mit Code als „mit zweitem Faktor“. */
export async function completePasskeySecondFactor(db: Db, auth: Auth, headers: Headers, response: AuthenticationResponseJSON, now = new Date()): Promise<void> {
  const res = await auth.api.verifyPasskeySecondFactor({ body: { response: { ...response } }, headers });
  const token = (res as { token?: string } | null)?.token;
  if (token) await db.update(sessions).set({ secondFactorAt: now }).where(eq(sessions.token, token));
}

/** Rein: Sitzung erfüllt „mit zweitem Faktor“? Konto mit 2FA → nur mit Kennzeichen; ohne 2FA nur in Demo-Instanzen. */
export function secondFactorSatisfied(accountEnabled: boolean, sessionMarked: boolean, demo: boolean): boolean {
  return accountEnabled ? sessionMarked : demo;
}

/** G5A-S04: Ist diese Sitzung mit zweitem Faktor angemeldet (bzw. – Demo, Konto ohne 2FA – nicht verlangt)? Frisch aus der DB. */
export async function sessionSecondFactorOk(db: Db, sessionId: string, userId: string): Promise<boolean> {
  const [r] = await db
    .select({ enabled: users.twoFactorEnabled, marked: sessions.secondFactorAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (!r) return false;
  return secondFactorSatisfied(Boolean(r.enabled), r.marked !== null, await isDemoDb(db));
}

export async function regenerateBackupCodes(db: Db, auth: Auth, headers: Headers, userId: string, password: string): Promise<string[]> {
  const res = await auth.api.generateBackupCodes({ body: { password }, headers });
  await audit(db, userId, "konto.2fa.codes", userId);
  return res.backupCodes;
}

/**
 * Code-App ausschalten. SEC-03: Mit eingerichtetem Sicherheitsschlüssel bleibt 2FA an (dann auch bei Pflicht erlaubt) – nur die
 * Code-App und die Wiederherstellungscodes sind weg.
 */
export async function disableOwn(db: Db, auth: Auth, headers: Headers, perms: PermissionSet, password: string): Promise<void> {
  const status = await twoFactorStatus(db, perms);
  if (status.enforced && status.passkeys === 0) throw new TwoFactorRequiredError();
  // G4E-C08: Better Auth tauscht dabei die Sitzung aus – die neue erbt die Kennzeichnung „mit zweitem Faktor“ der alten
  const before = await auth.api.getSession({ headers, query: { disableRefresh: true, disableCookieCache: true } });
  const [old] = before
    ? await db.select({ marked: sessions.secondFactorAt }).from(sessions).where(eq(sessions.id, before.session.id))
    : [];
  const res = await auth.api.disableTwoFactor({ body: { password }, headers, returnHeaders: true });
  const token = sessionTokenFrom(res.headers);
  if (old?.marked && token) await db.update(sessions).set({ secondFactorAt: old.marked }).where(and(eq(sessions.token, token), eq(sessions.userId, perms.userId)));
  // G4E-C09: Better Auth hat 2FA ausgeschaltet; unter der Sperre aus dem tatsächlichen Bestand ableiten – ein gleichzeitig
  // entfernter Schlüssel lässt sonst 2FA „an“ ohne jeden Faktor zurück
  const stillOn = await db.transaction(async (tx) => {
    await lockTwoFactorState(tx, perms.userId);
    return syncTwoFactorEnabled(tx, perms.userId);
  });
  await audit(db, perms.userId, stillOn ? "konto.2fa.app_entfernt" : "konto.2fa.deaktiviert", perms.userId);
}

/**
 * Verwaltung setzt 2FA zurück (Gerät verloren, Codes weg): Geheimnis und Codes gelöscht, alle Sitzungen beendet.
 * Pflicht-Konten müssen bei der nächsten Anmeldung neu einrichten.
 */
export async function resetTwoFactor(db: Db, actorId: string | null, userId: string): Promise<void> {
  // SEC-04: Konten mit mehr Rechten (Admin, Schulleitung) nur durch Admins – sonst Übernahme per 2FA- + Passwort-Reset
  await assertMayManage(db, await loadActor(db, actorId), userId, "twoFactor");
  await db.transaction(async (tx) => {
    await tx.delete(twoFactors).where(eq(twoFactors.userId, userId));
    // SEC-03: Sicherheitsschlüssel ebenso
    await tx.delete(passkeys).where(eq(passkeys.userId, userId));
    // SEC-02: auch die gedruckte Code-Liste gilt nicht mehr
    await tx.delete(twoFactorCodeLists).where(eq(twoFactorCodeLists.userId, userId));
    await tx.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    // G4E-S02: auch „Gerät vertrauen“ übersteht das Zurücksetzen nicht
    await dropTrustedDevices(tx, userId);
  });
  endLiveStreams(userId);
  await audit(db, actorId, "verwaltung.user.2fa_reset", userId);
  await notifyTwoFactorReset(db, userId);
}

/**
 * SEC-02: Gong an das Konto bzw. – bei Schüler:innen – an die handelnden Eltern (Eigenständige an sich selbst), damit ein nicht
 * abgesprochenes Zurücksetzen auffällt. Ohne Inhalte außer dem Namen.
 */
async function notifyTwoFactorReset(db: Db, userId: string): Promise<void> {
  const [u] = await db.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) return;
  const recipients = u.role === "schueler" ? [userId, ...(await guardianRecipients(db, [userId], { withInformed: false }))] : [userId];
  await notify(db, recipients, {
    moduleId: "verwaltung",
    title: "Zwei-Faktor-Anmeldung zurückgesetzt",
    body: `Das Sekretariat hat die Zwei-Faktor-Anmeldung von ${u.name} zurückgesetzt. War das nicht abgesprochen, bitte im Sekretariat melden.`,
    href: "/zwei-faktor",
  });
}

/** Rein: Token der Sitzung aus den Set-Cookie-Kopfzeilen einer Better-Auth-Antwort (signiertes Cookie „token.signatur“). */
export function sessionTokenFrom(headers: Headers): string | null {
  for (const c of headers.getSetCookie()) {
    const [pair = ""] = c.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    const value = decodeURIComponent(pair.slice(at + 1));
    if (at > 0 && name.endsWith("session_token") && value) return value.split(".")[0] || null;
  }
  return null;
}

export class TwoFactorRequiredError extends Error {
  constructor() {
    super("Für dieses Konto ist die Zwei-Faktor-Anmeldung Pflicht.");
    this.name = "TwoFactorRequiredError";
  }
}
