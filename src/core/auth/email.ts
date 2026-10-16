// Echte E-Mail-Adressen (Q5-04). `users.email` ist für Better Auth Pflicht und eindeutig; ohne echte Adresse steht dort
// ein Platzhalter `<benutzername>@schulos.local`. Echte Adressen pflegt die Verwaltung (unbestätigt) oder die Person selbst
// per Bestätigungslink – erst dann wird `email_verified` wahr. Die Better-Auth-Selbstbedienung (/change-email) bleibt aus
// (SEC-04). Bestätigungen: ein offener Link je Konto in `verifications` (Token nur als SHA-256, 24 h, nur mit Anmeldung).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { users, verifications, type Role } from "@/core/db/schema";
import { appUrl, enqueueMail, mailAvailable } from "@/core/mail";
import { consumeRate, rateLimitMessage } from "@/core/rate-limit";
import { emailChangedMail, emailConfirmMail } from "@/core/mail-templates";
import { isMailAddress } from "@schulos/server/mail";

export const PLACEHOLDER_DOMAIN = "schulos.local";
/** Gültigkeit des Bestätigungslinks */
export const EMAIL_CONFIRM_HOURS = 24;

export const placeholderEmail = (username: string) => `${username}@${PLACEHOLDER_DOMAIN}`;

/** Platzhalter: `…@schulos.local` und Unterdomänen (Demo-Seed: `@lindenhof.schulos.local`). */
export function isPlaceholderEmail(email: string): boolean {
  return /@([a-z0-9-]+\.)*schulos\.local$/i.test(email.trim());
}

/** Echte Adresse oder null (Platzhalter). */
export function realEmail(email: string | null | undefined): string | null {
  return email && !isPlaceholderEmail(email) ? email : null;
}

/**
 * Eingabe prüfen und normalisieren: leer → null; sonst kleingeschrieben, gültig und keine Platzhalter-Domain.
 * Fehlertext für das Formularfeld oder null.
 */
export function normalizeEmail(raw: string | null | undefined): { email: string | null; error: string | null } {
  const email = (raw ?? "").trim().toLowerCase();
  if (!email) return { email: null, error: null };
  if (!isMailAddress(email)) return { email: null, error: "Keine gültige E-Mail-Adresse" };
  if (isPlaceholderEmail(email)) return { email: null, error: `Adressen unter ${PLACEHOLDER_DOMAIN} sind reserviert` };
  return { email, error: null };
}

/** Wird die Adresse schon von einem anderen Konto verwendet? */
export async function emailTaken(db: Db, email: string, exceptUserId?: string): Promise<boolean> {
  const where = exceptUserId ? and(eq(users.email, email), ne(users.id, exceptUserId)) : eq(users.email, email);
  const [hit] = await db.select({ id: users.id }).from(users).where(where);
  return Boolean(hit);
}

/**
 * Selbstbedienung: wer darf die eigene Adresse ändern? Alle außer Schüler:innen (Kinderdaten, Datensparsamkeit – I-14:
 * bei Schüler:innen optional und per Vorgabe leer; die Verwaltung kann sie bei Bedarf eintragen).
 */
export function maySelfServeEmail(role: Role): boolean {
  return role !== "schueler";
}

const identifier = (userId: string) => `email-change:${userId}`;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class EmailChangeError extends Error {}

export interface EmailChangeRequest {
  /** Antwort für die Oberfläche – gleich, ob die Adresse frei ist (kein Aufzählen fremder Adressen) */
  sentTo: string;
  /** nur für Tests: Link, der in der Mail steht (null, wenn keine Mail ging) */
  link: string | null;
}

/**
 * Neue Adresse anfordern: alter offener Link verfällt, Bestätigungsmail an die neue Adresse. Ist sie schon an einem
 * anderen Konto, geht keine Mail raus – die Antwort ist dieselbe (sonst ließen sich fremde Adressen erraten).
 */
export async function requestEmailChange(
  db: Db,
  userId: string,
  rawEmail: string,
  opts: { school: string; now?: Date },
): Promise<EmailChangeRequest> {
  const now = opts.now ?? new Date();
  const [u] = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) throw new EmailChangeError("Konto gibt es nicht");
  if (!maySelfServeEmail(u.role)) throw new EmailChangeError("Die E-Mail-Adresse trägt bei Schüler:innen das Sekretariat ein.");
  const { email, error } = normalizeEmail(rawEmail);
  if (error || !email) throw new EmailChangeError(error ?? "Bitte eine E-Mail-Adresse eingeben");
  // P4-31: höchstens 3 Links je Stunde und Konto (sonst ließe sich über SchulOS Post an fremde Adressen schicken)
  const rate = await consumeRate(db, "konto.email", userId, now);
  if (!rate.allowed) throw new EmailChangeError(rateLimitMessage(rate.retryAt));
  await db.delete(verifications).where(eq(verifications.identifier, identifier(userId)));
  if (await emailTaken(db, email, userId)) {
    await audit(db, userId, "konto.email.angefordert", userId, { versandt: false });
    return { sentTo: email, link: null };
  }
  const link = await issueEmailLink(db, u, email, { school: opts.school, now });
  await audit(db, userId, "konto.email.angefordert", userId, { versandt: true });
  return { sentTo: email, link };
}

/** Offenen Link (Hash) für diese Adresse anlegen und die Bestätigungsmail einreihen; ein älterer Link des Kontos verfällt. */
async function issueEmailLink(db: Db, u: { id: string; name: string }, email: string, opts: { school: string; now: Date; bySchool?: boolean }): Promise<string> {
  await db.delete(verifications).where(eq(verifications.identifier, identifier(u.id)));
  const token = randomBytes(32).toString("base64url");
  await db.insert(verifications).values({
    id: crypto.randomUUID(),
    identifier: identifier(u.id),
    value: JSON.stringify({ hash: hashToken(token), email }),
    expiresAt: new Date(opts.now.getTime() + EMAIL_CONFIRM_HOURS * 3_600_000),
    createdAt: opts.now,
    updatedAt: opts.now,
  });
  const link = appUrl(`/konto/email/${token}`);
  await enqueueMail(
    db,
    { to: email, ...emailConfirmMail({ school: opts.school, name: u.name, link, hours: EMAIL_CONFIRM_HOURS, bySchool: opts.bySchool }), purpose: "email-bestaetigen" },
    opts.now,
  );
  return link;
}

/**
 * Q5-24: Die Verwaltung löst für die **eingetragene, unbestätigte** Adresse eines Kontos den Bestätigungslink aus (z. B. vor
 * dem Passwort-Reset per Mail, P4-70). Nur mit eingerichtetem Mailversand, höchstens 3 Links je Konto und Tag; bestätigt wird
 * wie bei der Selbstbedienung angemeldet als die Person selbst. Rechte und Audit macht der Aufrufer (Benutzerverwaltung).
 */
export async function sendEmailConfirmationFor(
  db: Db,
  userId: string,
  opts: { school: string; now?: Date; mailOn?: boolean },
): Promise<{ sentTo: string; link: string }> {
  const now = opts.now ?? new Date();
  if (!(opts.mailOn ?? mailAvailable())) throw new EmailChangeError("Der E-Mail-Versand ist nicht eingerichtet (SMTP, Verwaltung → System).");
  const [u] = await db.select({ id: users.id, name: users.name, email: users.email, verified: users.emailVerified, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u) throw new EmailChangeError("Konto gibt es nicht");
  const email = realEmail(u.email);
  if (!email) throw new EmailChangeError("Für dieses Konto ist keine E-Mail-Adresse eingetragen");
  if (u.verified) throw new EmailChangeError("Die Adresse ist schon bestätigt");
  if (u.status !== "active") throw new EmailChangeError("Das Konto ist gesperrt");
  const rate = await consumeRate(db, "verwaltung.email", userId, now);
  if (!rate.allowed) throw new EmailChangeError(rateLimitMessage(rate.retryAt));
  return { sentTo: email, link: await issueEmailLink(db, u, email, { school: opts.school, now, bySchool: true }) };
}

/** Offene Bestätigung dieses Kontos zum Token – oder null (falsches Konto, falscher/abgelaufener Token). */
export async function pendingEmailChange(db: Db, userId: string, token: string, now = new Date()): Promise<{ email: string; expiresAt: Date } | null> {
  const [row] = await db.select().from(verifications).where(eq(verifications.identifier, identifier(userId)));
  if (!row || row.expiresAt <= now) return null;
  let parsed: { hash?: unknown; email?: unknown };
  try {
    parsed = JSON.parse(row.value) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.hash !== "string" || typeof parsed.email !== "string") return null;
  const a = Buffer.from(parsed.hash, "hex");
  const b = Buffer.from(hashToken(token), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { email: parsed.email, expiresAt: row.expiresAt };
}

/** Link bestätigen (angemeldet als dasselbe Konto): Adresse übernehmen, `email_verified` wahr, Hinweis an die alte Adresse. */
export async function confirmEmailChange(db: Db, userId: string, token: string, opts: { school: string; now?: Date }): Promise<string> {
  const now = opts.now ?? new Date();
  const pending = await pendingEmailChange(db, userId, token, now);
  if (!pending) throw new EmailChangeError("Der Link ist ungültig oder abgelaufen. Bitte die Adresse noch einmal eintragen.");
  if (await emailTaken(db, pending.email, userId)) {
    await db.delete(verifications).where(eq(verifications.identifier, identifier(userId)));
    throw new EmailChangeError("Diese Adresse ist inzwischen an einem anderen Konto eingetragen – bitte an das Sekretariat wenden.");
  }
  const [before] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId));
  await db.update(users).set({ email: pending.email, emailVerified: true }).where(eq(users.id, userId));
  await db.delete(verifications).where(eq(verifications.identifier, identifier(userId)));
  const old = realEmail(before?.email);
  if (old && old !== pending.email) await enqueueMail(db, { to: old, ...emailChangedMail({ school: opts.school, name: before!.name }), purpose: "email-geaendert" }, now);
  await audit(db, userId, "konto.email.bestaetigt", userId);
  return pending.email;
}

/** Eigene Adresse entfernen (zurück auf den Platzhalter). */
export async function removeOwnEmail(db: Db, userId: string): Promise<void> {
  const [u] = await db.select({ username: users.username, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u?.username) throw new EmailChangeError("Konto gibt es nicht");
  if (!maySelfServeEmail(u.role)) throw new EmailChangeError("Die E-Mail-Adresse trägt bei Schüler:innen das Sekretariat ein.");
  await db.update(users).set({ email: placeholderEmail(u.username), emailVerified: false }).where(eq(users.id, userId));
  await db.delete(verifications).where(eq(verifications.identifier, identifier(userId)));
  await audit(db, userId, "konto.email.entfernt", userId);
}
