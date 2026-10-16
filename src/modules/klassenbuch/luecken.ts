// Klassenbuch-Lücken der eigenen Lehrkraft (Q5-06, I-16): gehaltene Stunden der letzten Schultage ohne Eintrag.
// Nur für die Person selbst – es gibt bewusst keine Liste je Lehrkraft für Schulleitung/Verwaltung (DATENSCHUTZ §5,
// keine Leistungskontrolle); die Klassenleitung sieht wie bisher die fehlenden Einträge ihrer Klasse im Wochenraster.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { notifyBundled } from "@/core/notifications";
import { loadSchoolCalendar, type SchoolCalendar } from "@/core/school/calendar";
import { addDays, toBerlinDate, toBerlinLocal, weekdayMon0 } from "@/core/time";
import { mySlots, type MySlot } from "./service";

/** so viele Schultage (einschließlich heute) zurück zählt „ohne Eintrag“ */
export const GAP_SCHOOL_DAYS = 10;
/** Gong-Schlüssel: je Lehrkraft eine Nachricht, die jede Woche ersetzt wird */
export const GAP_BUNDLE_KEY = "klassenbuch:luecken";

/** Erster Tag des Fensters: der `n`-te Schultag rückwärts ab `today` (heute zählt mit, wenn Schultag). Rein. */
export function gapWindowStart(cal: Pick<SchoolCalendar, "isSchoolDay">, today: string, n = GAP_SCHOOL_DAYS): string {
  let d = today;
  let seen = 0;
  // höchstens ein Jahr zurück (lange Ferien)
  for (let i = 0; i < 370; i++, d = addDays(d, -1)) {
    if (cal.isSchoolDay(d) && ++seen === n) return d;
  }
  return d;
}

/** Offen: kein Eintrag, Stunde liegt vor heute oder ist heute schon vorbei. Neueste zuerst. Rein. */
export function pickOpen(slots: readonly MySlot[], today: string, nowHm: string): MySlot[] {
  return slots
    .filter((s) => !s.hasEntry && (s.date < today || (s.date === today && s.endsAt <= nowHm)))
    .sort((a, b) => b.date.localeCompare(a.date) || a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de"));
}

/** Eigene Stunden ohne Eintrag in den letzten `GAP_SCHOOL_DAYS` Schultagen. `teacherId` ist immer die angemeldete Person. */
export async function openLessons(db: Db, teacherId: string, now = new Date()): Promise<MySlot[]> {
  const today = toBerlinDate(now);
  const from = gapWindowStart(await loadSchoolCalendar(db), today);
  let days = 1;
  for (let d = from; d < today; d = addDays(d, 1)) days++;
  return pickOpen(await mySlots(db, teacherId, from, days), today, toBerlinLocal(now).slice(11));
}

export function gapTitle(n: number): string {
  return `Klassenbuch: ${n} ${n === 1 ? "Stunde" : "Stunden"} ohne Eintrag`;
}

/**
 * Freitags-Gong (Job „klassenbuch-luecken“): jede aktive Lehrkraft mit offenen Stunden bekommt eine Nachricht nur für sich
 * (gebündelt: die der Vorwoche wird ersetzt). An anderen Tagen passiert nichts. Gibt die Zahl der Empfänger:innen zurück.
 */
export async function runGapReminders(db: Db, now = new Date()): Promise<number> {
  if (weekdayMon0(toBerlinDate(now)) !== 4) return 0;
  const teachers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")));
  const items: { userId: string; title: string; body: string; href: string }[] = [];
  for (const t of teachers) {
    const open = await openLessons(db, t.id, now);
    if (open.length === 0) continue;
    items.push({
      userId: t.id,
      title: gapTitle(open.length),
      body: `In den letzten ${GAP_SCHOOL_DAYS} Schultagen fehlen Einträge – nur für dich sichtbar.`,
      href: "/klassenbuch#offen",
    });
  }
  return notifyBundled(db, items, { moduleId: "klassenbuch", bundleKey: GAP_BUNDLE_KEY });
}
