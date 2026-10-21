// SP2-07 (SP-G-08): Bereitschaft – Lehrkräfte, die zu einer Stunde der Woche als Vertretungsreserve eingeteilt sind. Sie stehen
// bei den Vertretungsvorschlägen oben. Personaldienst wie der Aufsichtsplan: Pflege und Einsicht nur mit `stundenplan.substitute`
// (geprüft in Seite und Server Action), keine Anzeige im Vertretungsplan, auf Monitoren oder im Gong.
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { periods, schoolYears, timetableLessons, timetableStandby, users } from "@/core/db/schema";
import { weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";

export interface StandbyEntry {
  id: string;
  weekday: number;
  periodNr: number;
  teacherId: string;
  teacherCode: string | null;
  teacherName: string;
}

/** Schuljahr, in dem `date` liegt. */
async function yearOf(db: Db, date: string) {
  const [y] = await db
    .select({ id: schoolYears.id, startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn })
    .from(schoolYears)
    .where(and(lte(schoolYears.startsOn, date), gte(schoolYears.endsOn, date)));
  return y ?? null;
}

/** Alle Bereitschaften eines Schuljahres, nach Tag, Stunde und Kürzel. */
export async function listStandby(db: Db, schoolYearId: string): Promise<StandbyEntry[]> {
  return db
    .select({
      id: timetableStandby.id,
      weekday: timetableStandby.weekday,
      periodNr: timetableStandby.periodNr,
      teacherId: timetableStandby.teacherId,
      teacherCode: users.shortCode,
      teacherName: users.name,
    })
    .from(timetableStandby)
    .innerJoin(users, eq(users.id, timetableStandby.teacherId))
    .where(eq(timetableStandby.schoolYearId, schoolYearId))
    .orderBy(asc(timetableStandby.weekday), asc(timetableStandby.periodNr), asc(users.shortCode));
}

/** Lehrkräfte mit Bereitschaft an `date` in Stunde `periodNr`. */
export async function standbyAt(db: Db, date: string, periodNr: number): Promise<Set<string>> {
  const year = await yearOf(db, date);
  if (!year) return new Set();
  const rows = await db
    .select({ teacherId: timetableStandby.teacherId })
    .from(timetableStandby)
    .where(and(eq(timetableStandby.schoolYearId, year.id), eq(timetableStandby.weekday, weekdayMon0(date)), eq(timetableStandby.periodNr, periodNr)));
  return new Set(rows.map((r) => r.teacherId));
}

export interface StandbyInput {
  schoolYearId: string;
  teacherId: string;
  weekday: number;
  periodNr: number;
}

/** Bereitschaft eintragen. Eine Lehrkraft mit eigenem Unterricht zu der Zeit kann keine Bereitschaft haben. */
export async function addStandby(db: Db, actorId: string, input: StandbyInput): Promise<string> {
  const fe: Record<string, string> = {};
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, input.schoolYearId));
  if (!year) fe.schoolYearId = "Schuljahr gibt es nicht";
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 4) fe.weekday = "Wochentag wählen";
  const [p] = Number.isInteger(input.periodNr) ? await db.select({ nr: periods.nr }).from(periods).where(eq(periods.nr, input.periodNr)) : [];
  if (!p) fe.periodNr = "Stunde wählen";
  const [t] = input.teacherId ? await db.select({ role: users.role, code: users.shortCode }).from(users).where(eq(users.id, input.teacherId)) : [];
  if (t?.role !== "lehrkraft") fe.teacherId = "Lehrkraft wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  // eigener Unterricht zu der Zeit, der im Schuljahr gilt
  const own = await db
    .select({ id: timetableLessons.id })
    .from(timetableLessons)
    .where(
      and(
        eq(timetableLessons.teacherId, input.teacherId),
        eq(timetableLessons.weekday, input.weekday),
        eq(timetableLessons.periodNr, input.periodNr),
        lte(timetableLessons.validFrom, year!.endsOn),
        or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, year!.startsOn)),
      ),
    );
  if (own.length) throw new ValidationError({ teacherId: `${t!.code ?? "Die Lehrkraft"} unterrichtet zu dieser Zeit` });
  const [row] = await db
    .insert(timetableStandby)
    .values({ ...input, createdBy: actorId })
    .onConflictDoNothing()
    .returning({ id: timetableStandby.id });
  if (!row) throw new ValidationError({ teacherId: "Die Bereitschaft ist schon eingetragen" });
  await audit(db, actorId, "stundenplan.standby.add", input.teacherId, { weekday: input.weekday, period: input.periodNr });
  return row.id;
}

export async function removeStandby(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableStandby).where(eq(timetableStandby.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.standby.remove", old.teacherId, { weekday: old.weekday, period: old.periodNr });
}
