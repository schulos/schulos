// VT-04 (F-10-11): Vertretungsnachricht zur sinnvollen Zeit. Jede Änderung reiht die Betroffenen ein (eine offene Zeile je Person und
// Tag in `timetable_notification_queue`); gesendet wird zur geplanten Zeit – Vortags-Uhrzeit, Ruhezeit, „heute“ sofort (`sendezeit.ts`),
// getrennt einstellbar für Lehrkräfte und Lernende/Eltern. Die Nachricht wird erst beim Senden aus dem aktuellen Stand gebaut
// (`buildDayMessages`) → immer der Endstand, nie Zwischenstände. Senden und Einreihen laufen unter derselben Sperre je Tag wie bisher
// (GATE-031 C-07); der Minutentakt (`runSubstitutionQueue`, Job „vertretung-gong“ mit `runExclusive`) und „jetzt senden“ können
// darum gleichzeitig laufen, auch in zwei App-Prozessen, ohne doppelt zu senden: eine Zeile gilt als gesendet, sobald `sent_at` steht.
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { notifications, timetableNotificationQueue } from "@/core/db/schema";
import { audit } from "@/core/audit";
import { readModuleSetting, readModuleSettings } from "@/core/modules/settings";
import { notifyBundled } from "@/core/notifications";
import { fromBerlinLocal, isCalendarDate, toBerlinLocal } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { markerSince } from "./display";
import { isDraftDay } from "./freigabe";
import type { NotifyAudience } from "./schema";
import { lastEveLocal, plannedSendAt, type SendWindow } from "./sendezeit";
import {
  NOTIFY_EVE_TIME,
  NOTIFY_EVE_TIME_STUDENTS,
  QUIET_FROM,
  QUIET_FROM_STUDENTS,
  QUIET_UNTIL,
  QUIET_UNTIL_STUDENTS,
  SAME_AS_TEACHERS,
  SEND_TIME_SETTINGS,
  SUBSTITUTION_ACK,
} from "./settings";
import { buildDayMessages, bundleKey, type Affected } from "./vertretung-gong";

export const NOTIFY_AUDIENCE_LABELS: Record<NotifyAudience, string> = { lehrkraefte: "Lehrkräfte", lernende: "Schüler:innen und Eltern" };

/** Sendezeiten je Zielgruppe aus den Moduleinstellungen; „keine Ruhezeit“ → von = bis. */
export async function readSendWindows(db: Db): Promise<Record<NotifyAudience, SendWindow>> {
  const v = await readModuleSettings(db, SEND_TIME_SETTINGS);
  // Optionswerte „1800“ → „18:00“; „aus“ und „wie bei Lehrkräften“ bleiben
  const get = (d: { key: string }) => v.get(d.key)!.replace(/^(\d\d)(\d\d)$/, "$1:$2");
  const window = (eve: string, from: string, until: string): SendWindow => ({ eve, quietFrom: from === "aus" ? until : from, quietUntil: until });
  const teachers = { eve: get(NOTIFY_EVE_TIME), from: get(QUIET_FROM), until: get(QUIET_UNTIL) };
  const or = (value: string, fallback: string) => (value === SAME_AS_TEACHERS ? fallback : value);
  return {
    lehrkraefte: window(teachers.eve, teachers.from, teachers.until),
    lernende: window(or(get(NOTIFY_EVE_TIME_STUDENTS), teachers.eve), or(get(QUIET_FROM_STUDENTS), teachers.from), or(get(QUIET_UNTIL_STUDENTS), teachers.until)),
  };
}

const lockDay = (tx: Db, date: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bundleKey(date)}))`);

/**
 * Tagesnachricht an alle, die eine Änderung betrifft: `students` und `teachers` werden eingereiht (die handelnde Person nicht) und zur
 * geplanten Zeit benachrichtigt; was schon fällig ist (heute, nach der Vortags-Uhrzeit, rückwirkend), geht gleich in derselben
 * Transaktion raus. Gibt die eingereihten Personen zurück.
 */
export async function notifySubstitutionDay(
  db: Db,
  actorId: string,
  date: string,
  /** Betroffene – oder eine Funktion, die sie erst unter der Tagessperre ermittelt (Veröffentlichen, GATE-4f C-01) */
  affected: Affected | ((tx: Db) => Promise<Affected>),
  /** Q5-11: läuft unter derselben Tagessperre vorher (Veröffentlichen); `false` → keine Nachricht */
  guard?: (tx: Db) => Promise<boolean>,
  now: Date = new Date(),
): Promise<string[]> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await lockDay(tx, date);
    if (guard && !(await guard(tx))) return [];
    // Q5-11: Entwurf → niemand erfährt etwas, bis der Tag veröffentlicht ist (geprüft unter der Sperre: wer während des
    // Veröffentlichens speichert, sieht danach „veröffentlicht“ und meldet selbst)
    if (await isDraftDay(tx, date)) return [];
    const queued = await enqueueLocked(tx, actorId, date, typeof affected === "function" ? await affected(tx) : affected, now);
    await sendDueLocked(tx, date, now);
    return queued;
  });
}

/** Einreihen unter der Tagessperre. Ist die Person schon offen eingereiht, bleibt ihr Eintrag (früherer Zeitpunkt, `plannedSendAt` ist monoton). */
async function enqueueLocked(tx: Db, actorId: string, date: string, affected: Affected, now: Date): Promise<string[]> {
  const who = new Map<string, NotifyAudience>();
  for (const s of affected.students) who.set(s, "lernende");
  // wer (auch) Lehrkraft der Stunde ist, bekommt die Lehrkräfte-Nachricht
  for (const t of affected.teachers) who.set(t, "lehrkraefte");
  who.delete(actorId);
  if (who.size === 0) return [];
  const windows = await readSendWindows(tx);
  await tx
    .insert(timetableNotificationQueue)
    .values([...who].map(([userId, audience]) => ({ date, userId, audience, queuedAt: now, dueAt: plannedSendAt(date, now, windows[audience]) })))
    .onConflictDoNothing();
  return [...who.keys()];
}

/**
 * Senden unter der Tagessperre: fällige offene Einträge des Tages (bzw. mit `force` alle offenen einer Zielgruppe, „jetzt senden“) →
 * Tagesnachricht aus dem aktuellen Stand, Einträge als gesendet markieren. Entwurfstage warten. Keine Nachricht bekommt, wessen
 * Nachricht sich nicht geändert hat, und wer „keine Änderungen mehr“ bekäme, ohne je eine Nachricht zu dem Tag bekommen zu haben
 * (Änderung und Rücknahme vor dem Versand – ein Zwischenstand). Gibt die Zahl der Nachrichten zurück (mit Eltern).
 */
async function sendDueLocked(tx: Db, date: string, now: Date, opts: { force?: NotifyAudience } = {}): Promise<number> {
  if (await isDraftDay(tx, date)) return 0;
  const due = await tx
    .select({ id: timetableNotificationQueue.id, userId: timetableNotificationQueue.userId, audience: timetableNotificationQueue.audience })
    .from(timetableNotificationQueue)
    .where(
      and(
        eq(timetableNotificationQueue.date, date),
        isNull(timetableNotificationQueue.sentAt),
        opts.force ? eq(timetableNotificationQueue.audience, opts.force) : lte(timetableNotificationQueue.dueAt, now),
      ),
    );
  if (due.length === 0) return 0;
  const affected = {
    students: due.filter((r) => r.audience === "lernende").map((r) => r.userId),
    teachers: due.filter((r) => r.audience === "lehrkraefte").map((r) => r.userId),
  };
  const items = await buildDayMessages(tx, date, affected, { ackReminder: (await readModuleSetting(tx, SUBSTITUTION_ACK)) === "an" });
  const key = bundleKey(date);
  const before = items.length
    ? await tx
        .select({ userId: notifications.userId, title: notifications.title, body: notifications.body })
        .from(notifications)
        .where(and(eq(notifications.bundleKey, key), inArray(notifications.userId, items.map((i) => i.userId))))
    : [];
  const prev = new Map(before.map((n) => [n.userId, n]));
  const send = items.filter((i) => {
    const p = prev.get(i.userId);
    if (!p) return i.changes > 0;
    return p.title !== i.title || (p.body ?? null) !== i.body;
  });
  if (send.length) await notifyBundled(tx, send, { moduleId: "stundenplan", bundleKey: key });
  await tx
    .update(timetableNotificationQueue)
    .set({ sentAt: now })
    .where(inArray(timetableNotificationQueue.id, due.map((r) => r.id)));
  return send.length;
}

/** Minutentakt (Job „vertretung-gong“): alle fälligen Tage senden. */
export async function runSubstitutionQueue(db: Db, now: Date = new Date()): Promise<{ days: number; sent: number }> {
  const rows = await db
    .selectDistinct({ date: timetableNotificationQueue.date })
    .from(timetableNotificationQueue)
    .where(and(isNull(timetableNotificationQueue.sentAt), lte(timetableNotificationQueue.dueAt, now)));
  let sent = 0;
  for (const { date } of rows.sort((a, b) => a.date.localeCompare(b.date)))
    sent += await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      await lockDay(tx, date);
      return sendDueLocked(tx, date, now);
    });
  return { days: rows.length, sent };
}

/** „jetzt senden“ (Planung, `stundenplan.substitute` prüft die Action): alle offenen Einträge eines Tages und einer Zielgruppe sofort, auch in der Ruhezeit. */
export async function sendNow(db: Db, actorId: string, date: string, audience: NotifyAudience, now: Date = new Date()): Promise<number> {
  if (!isCalendarDate(date)) throw new ValidationError({ date: "Datum angeben" });
  if (audience !== "lehrkraefte" && audience !== "lernende") throw new ValidationError({ audience: "Zielgruppe angeben" });
  const sent = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await lockDay(tx, date);
    return sendDueLocked(tx, date, now, { force: audience });
  });
  await audit(db, actorId, "stundenplan.substitution.notify_now", null, { date, audience, recipients: sent });
  return sent;
}

export interface PlannedNotification {
  date: string;
  audience: NotifyAudience;
  /** offene Personen (ohne Eltern – die folgen den Lernenden) */
  people: number;
  /** früheste geplante Sendezeit */
  dueAt: Date;
}

/** Offene Nachrichten je Tag und Zielgruppe – „geplant für …“ auf der Planungsseite. */
export async function plannedNotifications(db: Db): Promise<PlannedNotification[]> {
  const rows = await db
    .select({ date: timetableNotificationQueue.date, audience: timetableNotificationQueue.audience, dueAt: timetableNotificationQueue.dueAt })
    .from(timetableNotificationQueue)
    .where(isNull(timetableNotificationQueue.sentAt))
    .orderBy(asc(timetableNotificationQueue.date), asc(timetableNotificationQueue.audience), asc(timetableNotificationQueue.dueAt));
  const out = new Map<string, PlannedNotification>();
  for (const r of rows) {
    const k = `${r.date}|${r.audience}`;
    const p = out.get(k);
    if (p) p.people++;
    else out.set(k, { date: r.date, audience: r.audience, people: 1, dueAt: r.dueAt });
  }
  return [...out.values()];
}

/** Nach einer Änderung der Sendezeiten: offene Einträge neu planen (aus Tag und erstem Einreihen, wie beim Einreihen). */
export async function reschedulePending(db: Db): Promise<number> {
  const windows = await readSendWindows(db);
  const rows = await db.select().from(timetableNotificationQueue).where(isNull(timetableNotificationQueue.sentAt));
  let changed = 0;
  for (const r of rows) {
    const due = plannedSendAt(r.date, r.queuedAt, windows[r.audience]);
    if (due.getTime() === r.dueAt.getTime()) continue;
    await db.update(timetableNotificationQueue).set({ dueAt: due }).where(eq(timetableNotificationQueue.id, r.id));
    changed++;
  }
  return changed;
}

/**
 * VT-04: Stichzeitpunkt der Marker „neu/geändert“ – letzter Vortags-Termin nach der Einstellung (Lehrkräfte), bzw. der tatsächliche
 * Versand der zu diesem Termin geplanten Nachrichten, wenn der Takt etwas später lief.
 */
export async function markerSinceDb(db: Db, now: Date = new Date()): Promise<{ since: Date; label: string }> {
  const { eve } = (await readSendWindows(db)).lehrkraefte;
  const eveAt = fromBerlinLocal(lastEveLocal(toBerlinLocal(now), eve));
  const [first] = await db
    .select({ sentAt: timetableNotificationQueue.sentAt })
    .from(timetableNotificationQueue)
    .where(and(eq(timetableNotificationQueue.dueAt, eveAt), isNotNull(timetableNotificationQueue.sentAt)))
    .orderBy(asc(timetableNotificationQueue.sentAt))
    .limit(1);
  return markerSince(now, { eve, dispatched: first?.sentAt ?? null });
}
