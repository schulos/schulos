// Transaktionsmails (P4-30): Mails an beliebige Empfänger (Bestätigungslinks, Anmeldung, später Passwort-Reset) – nur Text,
// Absender SCHULOS_SMTP_FROM. Nichts wird direkt gesendet: alles läuft über die Warteschlange `mail_outbox`, die ein leichter
// Job jede Minute abarbeitet (mit Wiederholung bei Fehlern). Ohne SMTP bleiben die Mails liegen – in Entwicklung und E2E
// sind sie unter /dev/mail lesbar. Nach dem Versand werden Empfänger, Betreff und Text geleert (nur Kennzahlen bleiben).
import { and, asc, count, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { mailOutbox } from "@/core/db/schema";
import { isMailAddress, safeMailConfig, smtpSender, type Env, type MailConfig, type Sender } from "@schulos/server/mail";

/** Nach so vielen Versuchen gilt eine Mail als endgültig gescheitert. */
export const MAIL_MAX_ATTEMPTS = 8;
/** Grenzen gegen Missbrauch und Riesenmails */
export const MAIL_MAX_SUBJECT = 200;
export const MAIL_MAX_TEXT = 20_000;

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** Zweck (Kennzahl), z. B. „email-bestaetigen“ */
  purpose: string;
}

/** Wartezeit vor dem nächsten Versuch: 1, 2, 4, 8 … Minuten, höchstens 6 Stunden. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 60_000, 6 * 3_600_000);
}

/** SMTP für Transaktionsmails (ohne Pflicht zu Alarm-Empfängern); fehlerhafte Angaben → protokolliert, null. */
export function transportConfig(env: Env = process.env): MailConfig | null {
  return safeMailConfig(env, undefined, { alarmTo: false });
}

/**
 * Mails bleiben lesbar unter /dev/mail: nur in der Entwicklung bzw. mit SCHULOS_DEV_MAIL=1 (E2E-Server) –
 * nie auf einer Produktivinstanz.
 */
export function devMailEnabled(env: Env = process.env): boolean {
  if (env.SCHULOS_INSTANCE?.trim().toLowerCase() === "production") return false;
  return env.NODE_ENV === "development" || env.SCHULOS_DEV_MAIL === "1";
}

/** Können Transaktionsmails ankommen (SMTP eingerichtet) – oder sind sie in Entwicklung/E2E lesbar? */
export function mailAvailable(env: Env = process.env): boolean {
  return transportConfig(env) !== null || devMailEnabled(env);
}

/** Basisadresse für Links in Mails (BETTER_AUTH_URL, wie die Anmeldung). */
export function appUrl(path: string, env: Env = process.env): string {
  const base = (env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export class MailInputError extends Error {}

/** Mail in die Warteschlange stellen; prüft Adresse und Größen, entfernt Zeilenumbrüche aus dem Betreff. */
export async function enqueueMail(db: Db, mail: OutgoingMail, now = new Date()): Promise<string> {
  const to = mail.to.trim();
  if (!isMailAddress(to)) throw new MailInputError(`Keine gültige E-Mail-Adresse: ${to.slice(0, 80)}`);
  const subject = mail.subject.replace(/[\r\n]+/g, " ").trim().slice(0, MAIL_MAX_SUBJECT);
  if (!subject) throw new MailInputError("Betreff fehlt");
  if (mail.text.length > MAIL_MAX_TEXT) throw new MailInputError("Text zu lang");
  const [row] = await db
    .insert(mailOutbox)
    .values({ to, subject, text: mail.text, purpose: mail.purpose.slice(0, 60), nextAttemptAt: now, createdAt: now })
    .returning({ id: mailOutbox.id });
  return row!.id;
}

/** Fehlermeldung ohne Adressen (SMTP-Server nennen gern den Empfänger) und gekürzt. */
export function scrubError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[^\s@<>"']+@[^\s@<>"']+/g, "<adresse>").slice(0, 300);
}

const cleared = { to: "", subject: "", text: "" } as const;

const pending = (now: Date) => and(isNull(mailOutbox.sentAt), isNull(mailOutbox.failedAt), lte(mailOutbox.nextAttemptAt, now));

type OutboxRow = typeof mailOutbox.$inferSelect;

/** So lange gilt eine Mail als „in Arbeit“, nachdem ein Versand sie beansprucht hat (danach darf der Job es erneut versuchen). */
const CLAIM_MS = 10 * 60_000;

async function deliverRow(db: Db, row: OutboxRow, sender: Sender, now: Date): Promise<"sent" | "retry" | "failed" | "busy"> {
  // GATE-4c (Code-L8): erst beanspruchen – Testmail-Knopf (sendNow) und Minuten-Job senden dieselbe Zeile nie beide
  const claimed = await db
    .update(mailOutbox)
    .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_MS) })
    .where(and(eq(mailOutbox.id, row.id), pending(now)))
    .returning({ id: mailOutbox.id });
  if (!claimed.length) return "busy";
  const attempts = row.attempts + 1;
  try {
    await sender({ to: [row.to], subject: row.subject, text: row.text });
  } catch (err) {
    const final = attempts >= MAIL_MAX_ATTEMPTS;
    await db
      .update(mailOutbox)
      .set({
        attempts,
        lastError: scrubError(err),
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
        ...(final ? { failedAt: now, ...cleared } : {}),
      })
      .where(eq(mailOutbox.id, row.id));
    return final ? "failed" : "retry";
  }
  await db
    .update(mailOutbox)
    .set({ attempts, sentAt: now, lastError: null, ...cleared })
    .where(eq(mailOutbox.id, row.id));
  return "sent";
}


export interface DeliveryResult {
  sent: number;
  retry: number;
  failed: number;
}

/** Fällige Mails senden (älteste zuerst, höchstens `limit` je Lauf). Läuft im Job unter einer Sperre (kein Doppelversand). */
export async function deliverOutbox(db: Db, opts: { sender: Sender; now?: Date; limit?: number }): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select()
    .from(mailOutbox)
    .where(pending(now))
    .orderBy(asc(mailOutbox.createdAt))
    .limit(opts.limit ?? 50);
  const out: DeliveryResult = { sent: 0, retry: 0, failed: 0 };
  for (const r of rows) {
    const res = await deliverRow(db, r, opts.sender, now);
    if (res !== "busy") out[res]++;
  }
  return out;
}

/** Eine bestimmte Mail sofort senden (Testmail-Knopf: Rückmeldung direkt). Fehler → später erneut über den Job. */
export async function sendNow(db: Db, id: string, sender: Sender, now = new Date()): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db.select().from(mailOutbox).where(and(eq(mailOutbox.id, id), isNull(mailOutbox.sentAt), isNull(mailOutbox.failedAt)));
  if (!row) return { ok: false, error: "Mail nicht (mehr) in der Warteschlange" };
  const r = await deliverRow(db, row, sender, now);
  if (r === "sent") return { ok: true };
  if (r === "busy") return { ok: false, error: "Die Mail wird gerade versendet" };
  const [after] = await db.select({ lastError: mailOutbox.lastError }).from(mailOutbox).where(eq(mailOutbox.id, id));
  return { ok: false, error: after?.lastError ?? "Versand fehlgeschlagen" };
}

export interface OutboxStats {
  pending: number;
  sent: number;
  failed: number;
  oldestPending: Date | null;
}

/** Kennzahlen für Verwaltung → System (ohne Inhalte). */
export async function outboxStats(db: Db): Promise<OutboxStats> {
  const [r] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${mailOutbox.sentAt} is null and ${mailOutbox.failedAt} is null)`.mapWith(Number),
      sent: sql<number>`count(*) filter (where ${mailOutbox.sentAt} is not null)`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${mailOutbox.failedAt} is not null)`.mapWith(Number),
      oldestPending: sql<string | null>`min(${mailOutbox.createdAt}) filter (where ${mailOutbox.sentAt} is null and ${mailOutbox.failedAt} is null)`,
    })
    .from(mailOutbox);
  return {
    pending: r?.pending ?? 0,
    sent: r?.sent ?? 0,
    failed: r?.failed ?? 0,
    oldestPending: r?.oldestPending ? new Date(r.oldestPending) : null,
  };
}

/** Für /dev/mail: neueste Mails mit Inhalt (nur ungesendete haben noch einen). */
export async function listOutbox(db: Db, limit = 50) {
  return db.select().from(mailOutbox).orderBy(desc(mailOutbox.createdAt), desc(mailOutbox.id)).limit(limit);
}

export async function countOutbox(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(mailOutbox);
  return r?.n ?? 0;
}

/** Job-Takt: mit SMTP die Warteschlange abarbeiten; ohne SMTP passiert nichts (Mails bleiben liegen). */
export async function deliverWithConfig(db: Db, now = new Date(), cfg: MailConfig | null = transportConfig()): Promise<DeliveryResult | null> {
  if (!cfg) return null;
  return deliverOutbox(db, { sender: smtpSender(cfg), now });
}
