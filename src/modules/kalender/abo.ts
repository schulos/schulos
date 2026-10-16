// Kalender-Abo per widerrufbarem Link (Q5-15, I-12; SICHERHEIT.md S39). Eine Person legt für einen ihrer Kalender einen
// geheimen Link an und trägt ihn in ihrer Kalender-App ein; die App ruft ihn ohne Anmeldung ab und bekommt nur lesend die
// Termine dieses Kalenders.
//
// Regeln: Token wie bei der Schulanmeldung (32 Byte Zufall, nur SHA-256 gespeichert, Formprüfung vor der Abfrage,
// zeitkonstanter Vergleich; `src/core/public-token.ts`) – im Link steht nichts über die Person. Bei jedem Abruf wird alles neu
// geprüft wie bei einer Sitzung: Konto nutzbar (nicht gesperrt, kein offenes Startpasswort/Pflicht-2FA), Außenzugang nach Rolle
// und Gerätezertifikat (P4-40b – ein Abo-Link öffnet von außen nie mehr als eine Anmeldung), Kalender noch lesbar (Gruppe
// verlassen → 404). Rate-Limits je IP und je Link (P4-31). Anlegen und Widerrufen stehen im Audit-Log; Abrufe nicht (nur
// „zuletzt genutzt“, stundengenau), sonst entstünde ein Bewegungsprofil.
import { and, asc, count, eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { calendarFeedTokens, users } from "@/core/db/schema";
import { externalAccessFor } from "@/core/device-certs/service";
import { DENY_TEXT } from "@/core/device-certs/policy";
import { accessBlocked, loadPermissions, type PermissionSet } from "@/core/permissions";
import { hashPublicToken, isTokenShape, newPublicToken, sameHash } from "@/core/public-token";
import { consumeRate, rateBlocked } from "@/core/rate-limit";
import { readSchoolSettings } from "@/core/settings";
import { ValidationError } from "@/modules/verwaltung/users";
import { buildIcs } from "./ics";
import { listCalendarEvents, readableCalendars, type CalendarKey } from "./service";

export const FEED_MAX_PER_USER = 5;
export const FEED_LABEL_MAX = 60;
/** „zuletzt genutzt“ höchstens so oft aktualisieren (kein Abrufprotokoll) */
const TOUCH_EVERY_MS = 60 * 60_000;

export interface FeedRow {
  id: string;
  calendar: string;
  calendarLabel: string | null;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Eigene Abo-Links (ohne Token – der steht nur einmal nach dem Anlegen zur Verfügung). */
export async function listFeeds(db: Db, viewer: PermissionSet): Promise<FeedRow[]> {
  const [rows, calendars] = await Promise.all([
    db
      .select({ id: calendarFeedTokens.id, calendar: calendarFeedTokens.calendar, label: calendarFeedTokens.label, createdAt: calendarFeedTokens.createdAt, lastUsedAt: calendarFeedTokens.lastUsedAt })
      .from(calendarFeedTokens)
      .where(eq(calendarFeedTokens.userId, viewer.userId))
      .orderBy(asc(calendarFeedTokens.createdAt)),
    readableCalendars(db, viewer),
  ]);
  return rows.map((r) => ({ ...r, calendarLabel: calendars.find((c) => c.key === r.calendar)?.label ?? null }));
}

/** Legt einen Abo-Link an; der Token wird genau hier einmal zurückgegeben. */
export async function createFeed(db: Db, viewer: PermissionSet, input: { calendar: string; label: string }): Promise<{ id: string; token: string }> {
  const label = input.label.trim().replace(/\s+/g, " ");
  const fe: Record<string, string> = {};
  if (!label) fe.label = "Bezeichnung angeben, z. B. „Handy“";
  else if (label.length > FEED_LABEL_MAX) fe.label = `höchstens ${FEED_LABEL_MAX} Zeichen`;
  else if (/[\u0000-\u001f\u007f]/.test(label)) fe.label = "Steuerzeichen sind nicht erlaubt";
  const calendars = await readableCalendars(db, viewer);
  if (!calendars.some((c) => c.key === input.calendar)) fe.calendar = "Kalender wählen";
  const [{ n }] = (await db.select({ n: count() }).from(calendarFeedTokens).where(eq(calendarFeedTokens.userId, viewer.userId))) as [{ n: number }];
  if (Number(n) >= FEED_MAX_PER_USER) fe.label = `Höchstens ${FEED_MAX_PER_USER} Abo-Links – erst einen widerrufen`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const token = newPublicToken();
  const [row] = await db
    .insert(calendarFeedTokens)
    .values({ userId: viewer.userId, calendar: input.calendar, label, tokenHash: hashPublicToken(token) })
    .returning({ id: calendarFeedTokens.id });
  await audit(db, viewer.userId, "kalender.abo.anlegen", row!.id, { calendar: input.calendar.startsWith("group:") ? "group" : input.calendar });
  return { id: row!.id, token };
}

/** Widerruft einen eigenen Abo-Link (fremde IDs: kein Effekt). */
export async function revokeFeed(db: Db, viewer: PermissionSet, id: string): Promise<boolean> {
  const gone = await db
    .delete(calendarFeedTokens)
    .where(and(eq(calendarFeedTokens.id, id), eq(calendarFeedTokens.userId, viewer.userId)))
    .returning({ id: calendarFeedTokens.id });
  if (gone.length) await audit(db, viewer.userId, "kalender.abo.widerrufen", id, {});
  return gone.length > 0;
}

export type FeedResult =
  | { state: "ok"; ics: string }
  | { state: "not-found" }
  | { state: "limited" }
  | { state: "denied"; text: string };

/**
 * Abruf über den geheimen Link (ohne Sitzung). `headers` = Anfrage-Header nach dem Proxy (Zone aus den Caddy-Kennzeichen),
 * `ip` = gekürztes Subjekt (`publicIp`/`ipSubject`).
 */
export async function readFeed(db: Db, token: string, ctx: { ip: string; headers: Headers; now: Date }): Promise<FeedResult> {
  // GATE-4f C-09: je IP zählen nur Fehlversuche (Raten von Links) – gültige Links begrenzt das Limit je Link, sonst träfe es
  // Kalenderdienste, die viele Abos von wenigen Adressen abrufen. Eine gesperrte IP kommt auch mit gültigem Link nicht durch.
  if (await rateBlocked(db, "kalender.abo", ctx.ip, ctx.now)) return { state: "limited" };
  const miss = async (): Promise<FeedResult> => ((await consumeRate(db, "kalender.abo", ctx.ip, ctx.now)).allowed ? { state: "not-found" } : { state: "limited" });
  if (!isTokenShape(token)) return miss();
  const hash = hashPublicToken(token);
  const [row] = await db
    .select({ feed: calendarFeedTokens, role: users.role })
    .from(calendarFeedTokens)
    .innerJoin(users, eq(users.id, calendarFeedTokens.userId))
    .where(eq(calendarFeedTokens.tokenHash, hash));
  if (!row || !sameHash(row.feed.tokenHash, hash)) return miss();
  if (!(await consumeRate(db, "kalender.abo.link", hash, ctx.now)).allowed) return { state: "limited" };
  // wie eine Sitzung: von außen nur nach Rolle/Gerätezertifikat (S27/S28), Konto uneingeschränkt nutzbar
  const external = await externalAccessFor(db, ctx.headers, { id: row.feed.userId, role: row.role }, ctx.now);
  if (!external.allowed) return { state: "denied", text: DENY_TEXT[external.reason] };
  const perms = await loadPermissions(db, row.feed.userId);
  if (accessBlocked(perms)) return { state: "not-found" };
  const data = await listCalendarEvents(db, perms, row.feed.calendar as CalendarKey);
  if (!data) return { state: "not-found" };
  if (!row.feed.lastUsedAt || ctx.now.getTime() - row.feed.lastUsedAt.getTime() > TOUCH_EVERY_MS)
    await db.update(calendarFeedTokens).set({ lastUsedAt: ctx.now }).where(eq(calendarFeedTokens.id, row.feed.id));
  const school = (await readSchoolSettings(db)).name;
  return { state: "ok", ics: buildIcs(`${school} – ${data.calendar.label}`, data.events, ctx.now) };
}
