// Rate-Limits in der App (P4-31): Caddy hat ohne Plugin keine. Zähler je Zweck + Subjekt in `rate_limits`, atomar per
// Upsert (gleichzeitige Anfragen gehen nicht verloren). Regeln wie bei der Anmeldesperre aus `@schulos/server/throttle`.
// Datensparsam: der Schlüssel ist ein HMAC aus Zweck und Subjekt (IPv6 auf /64 gekürzt); die Zeile lebt nur bis zum Ende
// von Fenster bzw. Sperre (`expires_at`, LK-SESSION) – danach räumt `pruneRateLimits` bzw. der Löschlauf sie weg.
import { createHmac } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rateLimits } from "@/core/db/schema";
import { afterHit, clientIp, type RateRule } from "@schulos/server/throttle";

export { clientIp };

/** Alle Regeln an einer Stelle (Grenzen aus docs/PHASE4.md §3.3 bzw. den Modulen). */
export const RATE_RULES = {
  /** öffentliche Anmeldung: Einreichungen je IP und Stunde */
  "anmeldung.ip": { max: 10, windowMinutes: 60 },
  /** GATE-4c: zusätzlich grob je IPv6-/48 (ein Tunnel/Anschluss hat oft 65 536 /64-Netze) */
  "anmeldung.ip48": { max: 30, windowMinutes: 60 },
  /** öffentliche Anmeldung: Einreichungen je E-Mail-Adresse (normalisiert, `emailSubject`) und Tag */
  "anmeldung.email": { max: 5, windowMinutes: 24 * 60 },
  /** GATE-4c: jeder Formular-Zeitstempel gilt für genau einen Antrag (Subjekt = Stempel, Fenster = Gültigkeit) */
  "anmeldung.stempel": { max: 1, windowMinutes: 12 * 60 },
  /** GATE-4c (Security N3): Abruf freier Termine (Slot-Wahl live) je IP */
  "anmeldung.termine": { max: 120, windowMinutes: 15 },
  /** Anmeldungen über ein Elternkonto (P4-34b) je Konto und Tag */
  "anmeldung.konto": { max: 5, windowMinutes: 24 * 60 },
  /** Token-Prüfungen (Bestätigungs-/Vorgangslinks) je IP */
  "anmeldung.token": { max: 20, windowMinutes: 15 },
  /** Bestätigungslinks „E-Mail-Adresse ändern“ je Konto (Q5-04) */
  "konto.email": { max: 3, windowMinutes: 60 },
  /** P4-70: „Passwort vergessen“ je IP (Postfächer fluten, Konten aufzählen) */
  "passwort.reset.ip": { max: 10, windowMinutes: 60 },
  /** P4-70: Links je Konto */
  "passwort.reset.konto": { max: 3, windowMinutes: 60 },
  /** SEC-02: Codes von der gedruckten Code-Liste je Konto (Raten verhindern; ein Code hat ~49 bit) */
  "konto.codeliste": { max: 10, windowMinutes: 15 },
  /** Bestätigungslink durch die Verwaltung (Q5-24) je Zielkonto und Tag – sonst ließe sich ein Postfach fluten */
  "verwaltung.email": { max: 3, windowMinutes: 24 * 60 },
  /** Gebäude-Meldungen je Person (Security-Review Gate 4a N3) */
  "gebaeude.meldung": { max: 20, windowMinutes: 60 },
  /** Gefahr-Alarme (Mail + Gong an die Verwaltung) je Person */
  "gebaeude.gefahr": { max: 3, windowMinutes: 60 },
  /** Q5-15: Fehlversuche (unbekannte Abo-Links) je IP – Raten von Links; gültige zählen nur je Link (GATE-4f C-09) */
  "kalender.abo": { max: 120, windowMinutes: 15 },
  /** Q5-15: Abrufe je Abo-Link (Kalender-Apps fragen höchstens alle paar Minuten) */
  "kalender.abo.link": { max: 20, windowMinutes: 60 },
} as const satisfies Record<string, RateRule>;

export type RatePurpose = keyof typeof RATE_RULES;

const DEV_SECRET = "schulos-dev-rate-limit";

function keySecret(env: Record<string, string | undefined> = process.env): string {
  return env.BETTER_AUTH_SECRET || DEV_SECRET;
}

/** IPv4 bleibt (NAT teilt Adressen ohnehin), IPv6 wird auf das /64-Präfix gekürzt (ein Anschluss = ein Präfix). */
export function ipSubject(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1]!;
  if (!v.includes(":")) return v;
  const [head = "", tail = ""] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = v.includes("::") && tail ? tail.split(":") : [];
  const full = v.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${full
    .slice(0, 4)
    .map((x) => parseInt(x || "0", 16).toString(16))
    .join(":")}::/64`;
}

/** GATE-4c: gröberes Subjekt für ein IPv6-/64-Subjekt (`a:b:c:d::/64` → `a:b:c::/48`); IPv4 → null. */
export function ipv6Prefix48(subject: string): string | null {
  const m = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(subject);
  return m ? `${m[1]}::/48` : null;
}

/**
 * GATE-4c: E-Mail-Adresse für Rate-Limits zusammenfassen – Groß/Klein egal, Plus-Adressen (`name+1@…`) zählen wie
 * `name@…`. Nur für den Zähler; gespeichert und angeschrieben wird die Adresse wie eingegeben.
 */
export function emailSubject(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  const local = e.slice(0, at).split("+")[0] || e.slice(0, at);
  return `${local}@${e.slice(at + 1)}`;
}

/** Schlüssel ohne Klartext: Zweck + HMAC(Subjekt). */
export function rateKey(purpose: string, subject: string, secret = keySecret()): string {
  const mac = createHmac("sha256", secret).update(`${purpose}\0${subject.trim().toLowerCase()}`).digest("hex").slice(0, 40);
  return `${purpose}:${mac}`;
}

export interface RateResult {
  allowed: boolean;
  count: number;
  /** gesperrt bis (nur wenn nicht erlaubt) */
  retryAt: Date | null;
}

const minutes = (n: number) => sql.raw(`interval '${Math.trunc(n)} minutes'`);

/**
 * Einen Vorgang zählen und sagen, ob er erlaubt ist. Atomar: Fenster, Zähler und Sperre rechnet die DB im Upsert aus dem
 * aktuellen Zeilenstand (Regeln wie `afterHit`).
 */
export async function consumeRate(db: Db, purpose: RatePurpose, subject: string, now = new Date(), rule: RateRule = RATE_RULES[purpose]): Promise<RateResult> {
  const t = rateLimits;
  const nowSql = sql`excluded.window_started_at`;
  const W = minutes(rule.windowMinutes);
  const fresh = sql`(${t.windowStartedAt} <= ${nowSql} - ${W} and (${t.blockedUntil} is null or ${t.blockedUntil} <= ${nowSql}))`;
  const count = sql`(case when ${fresh} then 1 else ${t.count} + 1 end)`;
  const start = sql`(case when ${fresh} then ${nowSql} else ${t.windowStartedAt} end)`;
  const lockEnd = rule.lockMinutes !== undefined ? sql`${nowSql} + ${minutes(rule.lockMinutes)}` : sql`${start} + ${W}`;
  const blocked = sql`(case when ${count} > ${sql.raw(String(Math.trunc(rule.max)))} then ${lockEnd} end)`;
  const first = afterHit(undefined, rule, now);
  const [row] = await db
    .insert(t)
    .values({
      key: rateKey(purpose, subject),
      count: first.count,
      windowStartedAt: now,
      blockedUntil: first.blockedUntil,
      expiresAt: new Date(Math.max(now.getTime() + rule.windowMinutes * 60_000, first.blockedUntil?.getTime() ?? 0)),
    })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        count,
        windowStartedAt: start,
        blockedUntil: blocked,
        expiresAt: sql`greatest(${start} + ${W}, coalesce(${blocked}, ${start} + ${W}))`,
      },
    })
    .returning({ count: t.count, blockedUntil: t.blockedUntil });
  const allowed = row!.count <= rule.max;
  return { allowed, count: row!.count, retryAt: allowed ? null : row!.blockedUntil };
}

/** Nur nachsehen (nicht zählen): ist dieses Subjekt gerade gesperrt? */
export async function rateBlocked(db: Db, purpose: RatePurpose, subject: string, now = new Date()): Promise<Date | null> {
  const [row] = await db.select({ blockedUntil: rateLimits.blockedUntil }).from(rateLimits).where(eq(rateLimits.key, rateKey(purpose, subject)));
  return row?.blockedUntil && row.blockedUntil > now ? row.blockedUntil : null;
}

/** Zähler zurücksetzen (z. B. nach erfolgreicher Bestätigung). */
export async function resetRate(db: Db, purpose: RatePurpose, subject: string): Promise<void> {
  await db.delete(rateLimits).where(eq(rateLimits.key, rateKey(purpose, subject)));
}

/** Abgelaufene Zähler löschen (läuft im Mail-Takt mit; der Löschlauf nachts erledigt es ohnehin). */
export async function pruneRateLimits(db: Db, now = new Date()): Promise<number> {
  const rows = await db.delete(rateLimits).where(lt(rateLimits.expiresAt, now)).returning({ key: rateLimits.key });
  return rows.length;
}

const timeFmt = new Intl.DateTimeFormat("de-DE", { timeStyle: "short", timeZone: "Europe/Berlin" });

/** Hinweis in Alltagssprache. */
export function rateLimitMessage(retryAt: Date | null): string {
  return retryAt ? `Zu viele Anfragen in kurzer Zeit. Bitte ab ${timeFmt.format(retryAt)} Uhr noch einmal versuchen.` : "Zu viele Anfragen in kurzer Zeit. Bitte später noch einmal versuchen.";
}
