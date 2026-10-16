// SEC-03 (Q-71): Sicherheitsschlüssel und Passkeys (WebAuthn) als zweiter Faktor neben der Code-App. Nur nach dem Passwort –
// keine passwortlose Anmeldung. Grundlage ist @simplewebauthn/server (MIT); das Passkey-Plugin von Better Auth (ebenfalls MIT)
// ist geprüft, aber nicht eingebunden: es baut Passkeys als eigene Anmeldung ohne Passwort (Q-4E-9).
//
// Ein Konto „hat 2FA“ (`users.two_factor_enabled`), sobald die Code-App bestätigt **oder** ein Schlüssel eingerichtet ist – damit
// greifen Pflicht (SEC-01), Notenbuch-Sitzungsprüfung, „Passwort vergessen“ (P4-70) und die Anmeldung mit zweitem Faktor
// unverändert. Die Anmeldung mit Schlüssel schließt `passkeySecondFactor` (passkey-plugin.ts) ab.
import { randomUUID } from "node:crypto";
import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { passkeys, sessions, twoFactors, users, verifications } from "@/core/db/schema";
import { enqueueMail } from "@/core/mail";
import { passkeyAddedMail } from "@/core/mail-templates";
import { endLiveStreams } from "@/core/notifications/bus";
import { readSchoolSettings } from "@/core/settings";
import { realEmail } from "./email";
import { dropTrustedDevices } from "./geraete-vertrauen";

export const PASSKEY_RP_NAME = "SchulOS";
/** So lange gilt eine Aufforderung an den Schlüssel (Einrichten bzw. Anmelden) */
export const CHALLENGE_SECONDS = 300;
/** Höchstens so viele Schlüssel je Konto */
export const MAX_PASSKEYS = 10;
const NAME_MAX = 60;
/**
 * Verfahren: EdDSA, ES256, RS256 – ausdrücklich, sonst prüft die Bibliothek bei jedem Aufruf, ob die Laufzeit schon
 * ML-DSA kann (Warnung „experimental“ im Serverprotokoll).
 */
const ALGORITHMS = [-8, -7, -257];

export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

export interface RelyingParty {
  rpID: string;
  origin: string;
}

/**
 * Für wen gilt der Schlüssel? In Betrieb die öffentliche Adresse (`BETTER_AUTH_URL`, wie Cookies und Links); ohne sie
 * (Entwicklung, E2E) die Adresse, von der die Anfrage kommt. Ein Schlüssel gilt nur für genau diesen Namen – eine
 * nachgemachte Seite unter anderem Namen bekommt keine gültige Antwort (Schutz vor Phishing).
 */
export function relyingParty(headers: Headers, env: Record<string, string | undefined> = process.env): RelyingParty {
  const base = env.BETTER_AUTH_URL;
  const origin = base ? new URL(base).origin : (headers.get("origin") ?? "http://localhost:3000");
  return { rpID: new URL(origin).hostname, origin };
}

export interface PasskeyInfo {
  id: string;
  name: string;
  /** synchronisierter Passkey (Handy, Passwortmanager) statt eines einzelnen Sicherheitsschlüssels */
  synced: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function listPasskeys(db: Db, userId: string): Promise<PasskeyInfo[]> {
  const rows = await db
    .select({ id: passkeys.id, name: passkeys.name, deviceType: passkeys.deviceType, createdAt: passkeys.createdAt, lastUsedAt: passkeys.lastUsedAt })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(asc(passkeys.createdAt), asc(passkeys.id));
  return rows.map((r) => ({ id: r.id, name: r.name, synced: r.deviceType === "multiDevice", createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
}

export async function passkeyCount(db: Db, userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  return Number(r?.n ?? 0);
}

/** Ist die Code-App (TOTP) bestätigt eingerichtet? */
export async function hasTotp(db: Db, userId: string): Promise<boolean> {
  const [r] = await db
    .select({ id: twoFactors.id })
    .from(twoFactors)
    .where(and(eq(twoFactors.userId, userId), eq(twoFactors.verified, true)));
  return Boolean(r);
}

/** Welche zweiten Faktoren hat das Konto? (für die Anmeldeseite und die Verwaltung) */
export async function secondFactorMethods(db: Db, userId: string): Promise<{ totp: boolean; passkeys: number }> {
  const [totp, n] = await Promise.all([hasTotp(db, userId), passkeyCount(db, userId)]);
  return { totp, passkeys: n };
}

/** G4E-C09: Kontozeile sperren (in einer Transaktion), bevor Faktoren geprüft und geändert werden. */
export async function lockTwoFactorState(tx: Db, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
}

/**
 * G4E-C09: `users.two_factor_enabled` aus dem tatsächlichen Bestand ableiten (bestätigte Code-App oder mindestens ein Schlüssel).
 * Nach jeder Änderung an den Faktoren unter der Sperre aufrufen. Liefert den neuen Wert.
 */
export async function syncTwoFactorEnabled(tx: Db, userId: string): Promise<boolean> {
  const { totp, passkeys: n } = await secondFactorMethods(tx, userId);
  const enabled = totp || n > 0;
  await tx.update(users).set({ twoFactorEnabled: enabled }).where(eq(users.id, userId));
  return enabled;
}

const regKey = (userId: string) => `passkey-einrichten:${userId}`;

async function storeChallenge(db: Db, identifier: string, challenge: string, now: Date): Promise<void> {
  await db.delete(verifications).where(eq(verifications.identifier, identifier));
  // abgelaufene Aufforderungen gleich mit aufräumen
  await db.delete(verifications).where(and(sql`${verifications.identifier} like 'passkey-einrichten:%'`, lt(verifications.expiresAt, now)));
  await db.insert(verifications).values({
    id: randomUUID(),
    identifier,
    value: challenge,
    expiresAt: new Date(now.getTime() + CHALLENGE_SECONDS * 1000),
  });
}

/** Aufforderung einmalig einlösen (gelöscht, auch wenn abgelaufen). */
async function takeChallenge(db: Db, identifier: string, now: Date): Promise<string | null> {
  const [row] = await db
    .delete(verifications)
    .where(eq(verifications.identifier, identifier))
    .returning({ value: verifications.value, expiresAt: verifications.expiresAt });
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  return row.value;
}

/**
 * Schritt 1 der Einrichtung: Optionen für `navigator.credentials.create`. Vorhandene Schlüssel sind ausgeschlossen (derselbe
 * Schlüssel nicht zweimal). Der Schlüssel muss nicht auf dem Gerät gespeichert werden (Sicherheitsschlüssel haben wenig Platz),
 * PIN/Fingerabdruck ist erwünscht, aber nicht Pflicht – er ist der zweite Faktor neben dem Passwort.
 */
export async function registrationOptions(db: Db, userId: string, rp: RelyingParty, now = new Date()): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const [u] = await db.select({ name: users.name, username: users.username }).from(users).where(eq(users.id, userId));
  if (!u) throw new PasskeyError("Konto gibt es nicht.");
  const existing = await db.select({ id: passkeys.credentialId, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, userId));
  if (existing.length >= MAX_PASSKEYS) throw new PasskeyError(`Höchstens ${MAX_PASSKEYS} Schlüssel je Konto – bitte erst einen entfernen.`);
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: rp.rpID,
    userName: u.username ?? userId,
    userDisplayName: u.name,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? c.transports.split(",") : undefined })),
    authenticatorSelection: { residentKey: "discouraged", userVerification: "preferred" },
    timeout: CHALLENGE_SECONDS * 1000,
    supportedAlgorithmIDs: ALGORITHMS,
  });
  await storeChallenge(db, regKey(userId), options.challenge, now);
  return options;
}

export function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return name || "Sicherheitsschlüssel";
}

/**
 * Schritt 2: Antwort des Schlüssels prüfen und speichern. Ist es der **erste** zweite Faktor des Kontos, gilt das wie das
 * Einschalten der Code-App (confirmSetup): 2FA an, alle anderen Sitzungen enden, eine Freigabe der Verwaltung ist verbraucht.
 * Hinweis-Mail an die bestätigte Adresse in jedem Fall – wer nur das Passwort hat, fällt so auf.
 */
export async function finishRegistration(
  db: Db,
  input: { userId: string; currentSessionId: string | null; response: RegistrationResponseJSON; name: string; rp: RelyingParty },
  now = new Date(),
): Promise<{ id: string; first: boolean }> {
  const challenge = await takeChallenge(db, regKey(input.userId), now);
  if (!challenge) throw new PasskeyError("Die Einrichtung ist abgelaufen. Bitte noch einmal starten.");
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.rpID,
      requireUserVerification: false,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch {
    throw new PasskeyError("Der Schlüssel konnte nicht geprüft werden. Bitte noch einmal versuchen.");
  }
  if (!result.verified) throw new PasskeyError("Der Schlüssel konnte nicht geprüft werden. Bitte noch einmal versuchen.");
  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = result.registrationInfo;
  const [taken] = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, credential.id));
  if (taken) throw new PasskeyError("Dieser Schlüssel ist schon eingerichtet.");

  const id = randomUUID();
  const name = cleanName(input.name);
  const first = await db.transaction(async (tx) => {
    const [u] = await tx.select({ enabled: users.twoFactorEnabled }).from(users).where(eq(users.id, input.userId));
    await tx.insert(passkeys).values({
      id,
      name,
      userId: input.userId,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      credentialId: credential.id,
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports?.join(",") ?? null,
      aaguid,
      createdAt: now,
    });
    if (u?.enabled) return false;
    await tx.update(users).set({ twoFactorEnabled: true, twoFactorSetupUntil: null }).where(eq(users.id, input.userId));
    return true;
  });
  let ended = 0;
  if (first) {
    // G5A-S04: Sitzungen, die nur mit Passwort entstanden, enden (die aktuelle bleibt, öffnet das Notenbuch aber erst nach neuer Anmeldung)
    const rows = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, input.userId), input.currentSessionId ? ne(sessions.id, input.currentSessionId) : undefined))
      .returning({ id: sessions.id });
    ended = rows.length;
    if (ended) endLiveStreams(input.userId);
    // G4E-S02: kein „Gerät vertrauen“ aus der Zeit vor dem ersten Faktor
    await dropTrustedDevices(db, input.userId);
  }
  await audit(db, input.userId, first ? "konto.2fa.eingerichtet" : "konto.2fa.schluessel", input.userId, {
    schluessel: name,
    ...(ended ? { sitzungenBeendet: ended } : {}),
  });
  await notifyPasskeyAdded(db, input.userId, name, first, now);
  return { id, first };
}

async function notifyPasskeyAdded(db: Db, userId: string, keyName: string, first: boolean, now: Date): Promise<void> {
  const [u] = await db.select({ name: users.name, email: users.email, verified: users.emailVerified }).from(users).where(eq(users.id, userId));
  const to = u?.verified ? realEmail(u.email) : null;
  if (!u || !to) return;
  const school = (await readSchoolSettings(db)).name;
  await enqueueMail(db, { to, ...passkeyAddedMail({ school, name: u.name, keyName, first }), purpose: first ? "2fa-eingerichtet" : "2fa-schluessel" }, now);
}

/**
 * Schlüssel entfernen (eigenes Konto). Ist es der letzte zweite Faktor (keine Code-App, kein weiterer Schlüssel), geht das nur,
 * wenn 2FA für das Konto keine Pflicht ist – dann ist 2FA danach aus.
 */
export async function removePasskey(db: Db, userId: string, passkeyId: string, enforced: boolean): Promise<{ twoFactorOff: boolean }> {
  const [row] = await db
    .select({ name: passkeys.name })
    .from(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId)));
  if (!row) throw new PasskeyError("Diesen Schlüssel gibt es nicht (mehr).");
  // G4E-C09: Prüfen und Entfernen unter der Sperre der Kontozeile – zwei gleichzeitige Entfernungen (zweiter Tab, Code-App
  // ausschalten) sehen sonst beide noch den anderen Faktor, und am Ende bliebe 2FA „an“ ohne jeden Faktor
  const last = await db.transaction(async (tx) => {
    await lockTwoFactorState(tx, userId);
    const { totp, passkeys: n } = await secondFactorMethods(tx, userId);
    const isLast = !totp && n <= 1;
    if (isLast && enforced)
      throw new PasskeyError(
        "Das ist dein einziger zweiter Faktor, und für dein Konto ist er Pflicht. Richte zuerst die Code-App oder einen weiteren Schlüssel ein.",
      );
    await tx.delete(passkeys).where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId)));
    await syncTwoFactorEnabled(tx, userId);
    return isLast;
  });
  await audit(db, userId, last ? "konto.2fa.deaktiviert" : "konto.2fa.schluessel_entfernt", userId, { schluessel: row.name });
  return { twoFactorOff: last };
}

/** Optionen für `navigator.credentials.get` bei der Anmeldung – nur die Schlüssel dieses Kontos. */
export async function authenticationOptions(db: Db, userId: string, rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const keys = await db.select({ id: passkeys.credentialId, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, userId));
  if (!keys.length) throw new PasskeyError("Für dein Konto ist kein Sicherheitsschlüssel eingerichtet.");
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports ? (k.transports.split(",") as AuthenticatorTransportList) : undefined })),
    userVerification: "preferred",
    timeout: CHALLENGE_SECONDS * 1000,
  });
}

type AuthenticatorTransportList = NonNullable<Parameters<typeof generateAuthenticationOptions>[0]["allowCredentials"]>[number]["transports"];

/**
 * Antwort des Schlüssels bei der Anmeldung prüfen: Schlüssel gehört zu **diesem** Konto, Signatur passt zur Aufforderung, der
 * Zähler läuft vorwärts (geklonte Schlüssel fallen auf). Danach Zähler und „zuletzt benutzt“ fortschreiben.
 */
export async function verifyAuthentication(
  db: Db,
  input: { userId: string; response: AuthenticationResponseJSON; expectedChallenge: string; rp: RelyingParty },
  now = new Date(),
): Promise<{ passkeyId: string }> {
  const credentialId = typeof input.response?.id === "string" ? input.response.id : "";
  const [key] = await db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.credentialId, credentialId), eq(passkeys.userId, input.userId)));
  if (!key) throw new PasskeyError("Dieser Schlüssel gehört nicht zu deinem Konto.");
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.rpID,
      credential: {
        id: key.credentialId,
        publicKey: isoBase64URL.toBuffer(key.publicKey),
        counter: key.counter,
        transports: key.transports ? (key.transports.split(",") as AuthenticatorTransportList) : undefined,
      },
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyError("Der Schlüssel wurde nicht erkannt. Bitte noch einmal versuchen.");
  }
  if (!result.verified) throw new PasskeyError("Der Schlüssel wurde nicht erkannt. Bitte noch einmal versuchen.");
  await db.update(passkeys).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: now }).where(eq(passkeys.id, key.id));
  return { passkeyId: key.id };
}
