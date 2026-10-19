// Zeitwünsche durch Lehrkräfte selbst (Q5-10, I-47): Die Planung öffnet ein Eingabefenster (von–bis); solange es offen ist,
// pflegt jede Lehrkraft ihre eigenen Zeitwünsche (`timetable_time_prefs`, Art „Lehrkraft“, nur die eigene Zeile). Die Planung
// sieht den Stand (wer hat abgegeben) und kann jederzeit überschreiben. Gong beim Öffnen an alle Lehrkräfte und kurz vor der
// Frist an die, die noch nicht abgegeben haben (Hintergrundjob, eine Nachricht je Person – gebündelt).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { appSettings, timetableTimePrefSubmissions, users } from "@/core/db/schema";
import { notifyBundled } from "@/core/notifications";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, isCalendarDate, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { planningYear } from "./verteilung";
import { savePrefs, type PrefGrid } from "./zeitwuensche";

export const PREF_WINDOW_KEY = "stundenplan.timepref_window";
const BUNDLE_KEY = "stundenplan:zeitwuensche";
export const OWN_PREFS_HREF = "/stundenplan/zeitwuensche";
/** Erinnerung so viele Tage vor dem letzten Tag (und am letzten Tag selbst, falls der Job vorher nicht lief) */
export const REMIND_DAYS_BEFORE = 2;

export interface PrefWindow {
  opensOn: string;
  /** letzter Tag (einschließlich) */
  closesOn: string;
  schoolYearId: string;
  /** Gong „Fenster offen“ verschickt am */
  announcedOn: string | null;
  /** Erinnerung vor der Frist verschickt am */
  remindedOn: string | null;
}

export type PrefWindowState = "none" | "planned" | "open" | "closed";

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", year: "numeric", timeZone: TZ });
export const formatDay = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

/** Rein: Zustand des Fensters an `today`. */
export function windowState(w: PrefWindow | null, today: string): PrefWindowState {
  if (!w) return "none";
  if (today < w.opensOn) return "planned";
  if (today > w.closesOn) return "closed";
  return "open";
}

export async function readPrefWindow(db: Db): Promise<PrefWindow | null> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, PREF_WINDOW_KEY));
  const v = row?.value as Partial<PrefWindow> | undefined;
  if (!v || typeof v.opensOn !== "string" || typeof v.closesOn !== "string" || typeof v.schoolYearId !== "string") return null;
  return { opensOn: v.opensOn, closesOn: v.closesOn, schoolYearId: v.schoolYearId, announcedOn: v.announcedOn ?? null, remindedOn: v.remindedOn ?? null };
}

async function writeWindow(db: Db, w: PrefWindow): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: PREF_WINDOW_KEY, value: w })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: w, updatedAt: new Date() } });
}

/** Ist das Fenster für das aktuelle Planungsjahr offen? (Ein Fenster aus einem anderen Schuljahr gilt als geschlossen.) */
export async function openWindow(db: Db, today: string): Promise<PrefWindow | null> {
  const w = await readPrefWindow(db);
  if (windowState(w, today) !== "open") return null;
  const year = await planningYear(db);
  return year && year.id === w!.schoolYearId ? w : null;
}

export async function activeTeachers(db: Db): Promise<string[]> {
  return (await db.select({ id: users.id }).from(users).where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")))).map((r) => r.id);
}

/** Wer hat im Planungsjahr schon abgegeben? teacherId → Zeitpunkt. */
export async function submissions(db: Db): Promise<Map<string, Date>> {
  const year = await planningYear(db);
  if (!year) return new Map();
  const rows = await db.select().from(timetableTimePrefSubmissions).where(eq(timetableTimePrefSubmissions.schoolYearId, year.id));
  return new Map(rows.map((r) => [r.teacherId, r.submittedAt]));
}

async function announce(db: Db, w: PrefWindow, today: string, recipients: string[], reminder: boolean): Promise<number> {
  const n = await notifyBundled(
    db,
    recipients.map((userId) => ({
      userId,
      title: `${reminder ? "Erinnerung: " : ""}Zeitwünsche bis ${formatDay(w.closesOn)} abgeben`,
      body: "Trage deine Zeitwünsche für den nächsten Stundenplan selbst ein – die Stundenplanung sieht sie und plant damit.",
      href: OWN_PREFS_HREF,
    })),
    { moduleId: "stundenplan", bundleKey: BUNDLE_KEY },
  );
  await markWindow(db, w, reminder ? "remindedOn" : "announcedOn", today);
  return n;
}

/**
 * Vermerkt Ankündigung bzw. Erinnerung – nur dieses Feld und nur, wenn das Fenster noch dasselbe ist (GATE-4f C-08: kein
 * Zurückschreiben einer alten Momentaufnahme, wenn die Planung während des Versands Daten geändert hat). Gibt zurück, ob
 * vermerkt wurde.
 */
export async function markWindow(db: Db, w: PrefWindow, field: "announcedOn" | "remindedOn", today: string): Promise<boolean> {
  const rows = await db
    .update(appSettings)
    .set({ value: sql`${appSettings.value} || ${JSON.stringify({ [field]: today })}::jsonb`, updatedAt: new Date() })
    .where(
      and(
        eq(appSettings.key, PREF_WINDOW_KEY),
        sql`${appSettings.value}->>'opensOn' = ${w.opensOn}`,
        sql`${appSettings.value}->>'closesOn' = ${w.closesOn}`,
        sql`${appSettings.value}->>'schoolYearId' = ${w.schoolYearId}`,
      ),
    )
    .returning({ key: appSettings.key });
  return rows.length > 0;
}

/** Planung öffnet (bzw. ändert) das Eingabefenster; beginnt es heute oder früher, geht der Gong sofort raus. */
export async function setPrefWindow(db: Db, actorId: string, input: { opensOn: string; closesOn: string }, today: string): Promise<PrefWindow> {
  const fe: Record<string, string> = {};
  if (!isCalendarDate(input.opensOn)) fe.opensOn = "Ersten Tag angeben";
  if (!isCalendarDate(input.closesOn)) fe.closesOn = "Letzten Tag angeben";
  else if (input.closesOn < today) fe.closesOn = "Der letzte Tag liegt in der Vergangenheit";
  else if (isCalendarDate(input.opensOn) && input.closesOn < input.opensOn) fe.closesOn = "Der letzte Tag liegt vor dem ersten";
  const year = await planningYear(db);
  if (!year) fe.opensOn = "Zuerst ein Schuljahr anlegen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const prev = await readPrefWindow(db);
  const same = prev && prev.schoolYearId === year!.id && prev.opensOn === input.opensOn && prev.closesOn === input.closesOn;
  // neue Frist → neu ankündigen und neu erinnern
  const w: PrefWindow = {
    opensOn: input.opensOn,
    closesOn: input.closesOn,
    schoolYearId: year!.id,
    announcedOn: same ? prev.announcedOn : null,
    remindedOn: same ? prev.remindedOn : null,
  };
  await writeWindow(db, w);
  await audit(db, actorId, "stundenplan.timepref.window", year!.id, { opensOn: w.opensOn, closesOn: w.closesOn });
  if (windowState(w, today) === "open" && !w.announcedOn) {
    await announce(db, w, today, await activeTeachers(db), false);
    return { ...w, announcedOn: today };
  }
  return w;
}

/** Planung schließt das Fenster vorzeitig (bzw. räumt ein abgelaufenes ab). Abgegebene Wünsche bleiben. */
export async function closePrefWindow(db: Db, actorId: string): Promise<void> {
  const deleted = await db.delete(appSettings).where(eq(appSettings.key, PREF_WINDOW_KEY)).returning({ key: appSettings.key });
  if (deleted.length) await audit(db, actorId, "stundenplan.timepref.window", null, { closed: true });
}

/**
 * Täglicher Lauf: Fenster heute geöffnet → Gong an alle Lehrkräfte; ab `REMIND_DAYS_BEFORE` Tage vor dem letzten Tag einmal
 * eine Erinnerung an die, die noch nicht abgegeben haben. Gibt die Zahl der Nachrichten zurück.
 */
export async function runPrefWindowReminders(db: Db, now = new Date()): Promise<number> {
  const today = toBerlinDate(now);
  const w = await openWindow(db, today);
  if (!w) return 0;
  if (!w.announcedOn) return announce(db, w, today, await activeTeachers(db), false);
  if (w.remindedOn || today < addDays(w.closesOn, -REMIND_DAYS_BEFORE)) return 0;
  const done = await submissions(db);
  const open = (await activeTeachers(db)).filter((id) => !done.has(id));
  return announce(db, w, today, open, true);
}

/**
 * Lehrkraft speichert die eigenen Zeitwünsche – nur im offenen Fenster, nur die eigene Person (die id kommt aus der
 * Sitzung, nie aus dem Formular). Markiert die Abgabe, auch wenn alles „egal“ ist.
 */
export async function saveOwnPrefs(db: Db, viewer: PermissionSet, grid: PrefGrid, today: string): Promise<number> {
  if (viewer.role !== "lehrkraft") throw new ForbiddenError("stundenplan.timepref.own");
  const w = await openWindow(db, today);
  if (!w) throw new ValidationError({ grid: "Das Eingabefenster für Zeitwünsche ist geschlossen" });
  // GATE-4f C-07: nur die eigenen Wünsche – Vorgaben der Planung (z. B. Sperren) bleiben
  const n = await savePrefs(db, viewer.userId, "teacher", viewer.userId, grid, "lehrkraft");
  await db
    .insert(timetableTimePrefSubmissions)
    .values({ schoolYearId: w.schoolYearId, teacherId: viewer.userId })
    .onConflictDoUpdate({ target: [timetableTimePrefSubmissions.schoolYearId, timetableTimePrefSubmissions.teacherId], set: { submittedAt: new Date() } });
  return n;
}

/** Hat die Lehrkraft im laufenden Fenster schon abgegeben? (für „Offen für dich“) */
export async function ownSubmissionOpen(db: Db, teacherId: string, today: string): Promise<{ window: PrefWindow; submitted: boolean } | null> {
  const w = await openWindow(db, today);
  if (!w) return null;
  const rows = await db
    .select({ t: timetableTimePrefSubmissions.teacherId })
    .from(timetableTimePrefSubmissions)
    .where(and(eq(timetableTimePrefSubmissions.schoolYearId, w.schoolYearId), eq(timetableTimePrefSubmissions.teacherId, teacherId)));
  return { window: w, submitted: rows.length > 0 };
}
