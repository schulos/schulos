// Abwesenheiten von Lehrkräften und Gruppen (P2b-18): Lehrkraft fehlt → ihre Stunden sind offen; Gruppe fehlt →
// Stunden entfallen, die Lehrkraft ist frei (Freisetzung). Übersicht „Vertretungsbedarf“ je Tag.
import { and, asc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, periods, subjects, timetableAbsences, timetableLessons, timetableSubstitutions, users, type TimetableAbsence } from "@/core/db/schema";
import { addDays } from "@/core/time";
import { TIMETABLE_ABSENCE_REASONS, type TimetableAbsenceReason, type TimetableAbsenceState } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { lessonActiveOn } from "./service";
import type { SubstitutionKind } from "./schema";

export const ABSENCE_LABELS: Record<TimetableAbsenceReason, string> = {
  krank: "krank",
  fortbildung: "Fortbildung",
  dienstlich: "dienstlich",
  klassenfahrt: "Klassenfahrt",
  exkursion: "Exkursion",
  praktikum: "Praktikum",
  pruefung: "Prüfung",
  sonstiges: "sonstiger Grund",
};

/** Gründe je Ziel: Lehrkräfte z. B. krank/Fortbildung, Gruppen z. B. Exkursion/Praktikum. */
export const TEACHER_REASONS: TimetableAbsenceReason[] = ["krank", "fortbildung", "dienstlich", "klassenfahrt", "exkursion", "sonstiges"];
export const GROUP_REASONS: TimetableAbsenceReason[] = ["klassenfahrt", "exkursion", "praktikum", "pruefung", "sonstiges"];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface Absence {
  id: string;
  teacherId: string | null;
  groupId: string | null;
  /** Kürzel bzw. Gruppenname für die Anzeige */
  label: string;
  startsOn: string;
  endsOn: string;
  fromPeriod: number | null;
  toPeriod: number | null;
  reason: TimetableAbsenceReason;
  note: string | null;
  /** P4-74 */
  status?: TimetableAbsenceState;
  selfReported?: boolean;
}

/** Gilt die Abwesenheit am Tag `date` in Stunde `periodNr`? */
export function absenceCovers(a: Pick<Absence, "startsOn" | "endsOn" | "fromPeriod" | "toPeriod">, date: string, periodNr: number): boolean {
  if (date < a.startsOn || date > a.endsOn) return false;
  return a.fromPeriod === null || a.toPeriod === null || (periodNr >= a.fromPeriod && periodNr <= a.toPeriod);
}

export interface AbsenceInput {
  teacherId: string | null;
  groupId: string | null;
  startsOn: string;
  endsOn: string;
  fromPeriod: number | null;
  toPeriod: number | null;
  reason: string;
  note: string | null;
  /** P4-74: Selbstmeldung der Lehrkraft (Stand „beantragt“ bei Fortbildung/dienstlich) */
  status?: TimetableAbsenceState;
  selfReported?: boolean;
}

export async function createAbsence(db: Db, actorId: string, input: AbsenceInput): Promise<string> {
  const fe: Record<string, string> = {};
  const note = input.note?.trim() || null;
  if (Boolean(input.teacherId) === Boolean(input.groupId)) fe.target = "Lehrkraft oder Klasse/Kurs wählen";
  if (!YMD.test(input.startsOn)) fe.startsOn = "Datum angeben";
  if (!YMD.test(input.endsOn)) fe.endsOn = "Datum angeben";
  else if (YMD.test(input.startsOn) && input.endsOn < input.startsOn) fe.endsOn = "Ende liegt vor dem Beginn";
  const allowed = input.teacherId ? TEACHER_REASONS : GROUP_REASONS;
  if (!(TIMETABLE_ABSENCE_REASONS as readonly string[]).includes(input.reason) || !allowed.includes(input.reason as TimetableAbsenceReason))
    fe.reason = "Grund wählen";
  if (note && note.length > 80) fe.note = "höchstens 80 Zeichen";
  if ((input.fromPeriod === null) !== (input.toPeriod === null)) fe.toPeriod = "Beide Stunden angeben oder keine (ganzer Tag)";
  else if (input.fromPeriod !== null && input.toPeriod !== null) {
    const nrs = new Set((await db.select({ nr: periods.nr }).from(periods)).map((p) => p.nr));
    if (!nrs.has(input.fromPeriod) || !nrs.has(input.toPeriod)) fe.fromPeriod = "Stunde wählen";
    else if (input.toPeriod < input.fromPeriod) fe.toPeriod = "„bis“ liegt vor „von“";
  }
  if (input.teacherId) {
    const [t] = await db.select({ role: users.role }).from(users).where(eq(users.id, input.teacherId));
    if (t?.role !== "lehrkraft") fe.target = "Lehrkraft wählen";
  }
  if (input.groupId) {
    const [g] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId));
    if (!g) fe.target = "Klasse oder Kurs wählen";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db
    .insert(timetableAbsences)
    .values({
      teacherId: input.teacherId,
      groupId: input.groupId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      fromPeriod: input.fromPeriod,
      toPeriod: input.toPeriod,
      reason: input.reason as TimetableAbsenceReason,
      note,
      status: input.status ?? "aktiv",
      selfReported: input.selfReported ?? false,
      createdBy: actorId,
    })
    .returning({ id: timetableAbsences.id });
  // Grund bewusst nicht ins Protokoll (Gesundheitsbezug bei „krank“)
  await audit(db, actorId, "stundenplan.absence.create", input.groupId ?? input.teacherId, { from: input.startsOn, to: input.endsOn });
  return row!.id;
}

export async function deleteAbsence(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableAbsences).where(eq(timetableAbsences.id, id)).returning();
  if (!old) return;
  // SP2-16b: eingetragene Vertretungen bleiben stehen, werden aber zur Prüfung markiert
  const flagged = await flagAfterAbsenceEnd(db, old, old.startsOn);
  await audit(db, actorId, "stundenplan.absence.delete", old.groupId ?? old.teacherId, { from: old.startsOn, to: old.endsOn, flagged: flagged || undefined });
}

const ddmm = (ymd: string) => `${ymd.slice(8)}.${ymd.slice(5, 7)}.`;

/**
 * SP2-16b: Abwesenheit verkürzen (früher zurück) – neues Ende vor dem bisherigen, nicht vor dem Beginn. Eingetragene Änderungen
 * nach dem neuen Ende bleiben stehen und werden zur Prüfung markiert. Gibt die Zahl der markierten Änderungen zurück.
 */
export async function shortenAbsence(db: Db, actorId: string, id: string, endsOn: string): Promise<number> {
  const [old] = await db.select().from(timetableAbsences).where(eq(timetableAbsences.id, id));
  if (!old) throw new ValidationError({ endsOn: "Diese Abwesenheit gibt es nicht (mehr)" });
  if (!YMD.test(endsOn)) throw new ValidationError({ endsOn: "Neues Ende angeben" });
  if (endsOn < old.startsOn) throw new ValidationError({ endsOn: "Das neue Ende liegt vor dem Beginn – sonst die Abwesenheit aufheben" });
  if (endsOn >= old.endsOn) throw new ValidationError({ endsOn: `Das neue Ende muss früher liegen als bisher (${ddmm(old.endsOn)})` });
  await db.update(timetableAbsences).set({ endsOn }).where(eq(timetableAbsences.id, id));
  const flagged = await flagAfterAbsenceEnd(db, old, addDays(endsOn, 1));
  // Grund bewusst nicht ins Protokoll (Gesundheitsbezug bei „krank“)
  await audit(db, actorId, "stundenplan.absence.shorten", old.groupId ?? old.teacherId, { from: old.startsOn, to: endsOn, before: old.endsOn, flagged: flagged || undefined });
  return flagged;
}

/**
 * SP2-16b (Q-SP2-16 = b, Projektleitung 2026-10-26): Die Abwesenheit `old` gilt ab `from` nicht mehr (verkürzt, aufgehoben,
 * zurückgezogen). Eingetragene Änderungen an Stunden, die sie abdeckte und die keine andere wirksame Abwesenheit abdeckt, bleiben
 * stehen und werden als „Abwesenheit beendet – prüfen“ markiert: bei einer Lehrkraft alle Arten außer der Raumänderung, bei einer
 * Klasse der Entfall. Gibt die Zahl der markierten Änderungen zurück.
 */
export async function flagAfterAbsenceEnd(db: Db, old: TimetableAbsence, from: string): Promise<number> {
  if (old.status !== "aktiv") return 0;
  const start = from > old.startsOn ? from : old.startsOn;
  if (start > old.endsOn) return 0;
  const target = old.teacherId ? eq(timetableLessons.teacherId, old.teacherId) : eq(timetableLessons.groupId, old.groupId!);
  const rows = await db
    .select({ id: timetableSubstitutions.id, date: timetableSubstitutions.date, kind: timetableSubstitutions.kind, periodNr: timetableLessons.periodNr })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .where(and(gte(timetableSubstitutions.date, start), lte(timetableSubstitutions.date, old.endsOn), target));
  if (rows.length === 0) return 0;
  const others = (await absencesBetween(db, start, old.endsOn)).filter((a) => a.id !== old.id && (old.teacherId ? a.teacherId === old.teacherId : a.groupId === old.groupId));
  const hit = rows.filter(
    (r) => (old.teacherId ? r.kind !== "room" : r.kind === "cancel") && absenceCovers(old, r.date, r.periodNr) && !others.some((a) => absenceCovers(a, r.date, r.periodNr)),
  );
  if (hit.length)
    await db
      .update(timetableSubstitutions)
      .set({ absenceEndedAt: new Date() })
      .where(
        inArray(
          timetableSubstitutions.id,
          hit.map((r) => r.id),
        ),
      );
  return hit.length;
}

export interface EndedAbsenceReview {
  id: string;
  date: string;
  periodNr: number;
  kind: SubstitutionKind;
  groupName: string;
  subjectName: string;
  teacherCode: string | null;
  substituteCode: string | null;
}

/** SP2-16b: zur Prüfung markierte Änderungen ab `from` („Abwesenheit beendet – prüfen“), nach Tag, Stunde und Gruppe. */
export async function endedAbsenceReviews(db: Db, from: string): Promise<EndedAbsenceReview[]> {
  const substitute = alias(users, "substitute");
  const rows = await db
    .select({
      id: timetableSubstitutions.id,
      date: timetableSubstitutions.date,
      periodNr: timetableLessons.periodNr,
      kind: timetableSubstitutions.kind,
      groupName: groups.name,
      subjectName: subjects.name,
      teacherCode: users.shortCode,
      substituteCode: substitute.shortCode,
    })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(users, eq(users.id, timetableLessons.teacherId))
    .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
    .where(and(isNotNull(timetableSubstitutions.absenceEndedAt), gte(timetableSubstitutions.date, from)));
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de", { numeric: true }));
}

/**
 * Abwesenheiten, die `date` berühren (bzw. im Zeitraum [from, to] liegen). Nur wirksame („aktiv“) – beantragte und abgelehnte
 * Selbstmeldungen (P4-74/I-26) zählen nicht für Vertretungsbedarf, Vorschläge und Aufsichten.
 */
export async function absencesBetween(db: Db, fromYmd: string, toYmd: string, opts: { states?: TimetableAbsenceState[] } = {}): Promise<Absence[]> {
  const rows = await db
    .select({ a: timetableAbsences, code: users.shortCode, name: users.name, groupName: groups.name })
    .from(timetableAbsences)
    .leftJoin(users, eq(users.id, timetableAbsences.teacherId))
    .leftJoin(groups, eq(groups.id, timetableAbsences.groupId))
    .where(and(lte(timetableAbsences.startsOn, toYmd), gte(timetableAbsences.endsOn, fromYmd), inArray(timetableAbsences.status, opts.states ?? ["aktiv"])))
    .orderBy(asc(timetableAbsences.startsOn), asc(timetableAbsences.createdAt));
  return rows.map(({ a, code, name, groupName }) => ({
    id: a.id,
    teacherId: a.teacherId,
    groupId: a.groupId,
    label: a.teacherId ? (code ?? name ?? a.teacherId) : (groupName ?? a.groupId!),
    startsOn: a.startsOn,
    endsOn: a.endsOn,
    fromPeriod: a.fromPeriod,
    toPeriod: a.toPeriod,
    reason: a.reason,
    note: a.note,
    status: a.status,
    selfReported: a.selfReported,
  }));
}

/** Rein: Lehrkräfte, die am Tag in dieser Stunde abwesend sind. */
export function absentTeachers(absences: Absence[], date: string, periodNr: number): Set<string> {
  return new Set(absences.filter((a) => a.teacherId && absenceCovers(a, date, periodNr)).map((a) => a.teacherId!));
}

/** Rein: Gruppen, die am Tag in dieser Stunde abwesend sind. */
export function absentGroups(absences: Absence[], date: string, periodNr: number): Set<string> {
  return new Set(absences.filter((a) => a.groupId && absenceCovers(a, date, periodNr)).map((a) => a.groupId!));
}

// ---------------------------------------------------------------- Vertretungsbedarf

export interface NeedLesson {
  lessonId: string;
  periodNr: number;
  groupId: string;
  groupName: string;
  subjectName: string;
  teacherId: string | null;
  teacherCode: string | null;
  roomId: string | null;
}

export interface DayNeeds {
  /** Stunden abwesender Lehrkräfte; `status` = schon geregelt? */
  /** `substituteAbsent`: die eingetragene Vertretungslehrkraft ist selbst abwesend – die Stunde ist wieder offen */
  open: (NeedLesson & { absence: Absence; status: "open" | Exclude<SubstitutionKind, "room">; substituteAbsent?: string })[];
  /** Stunden abwesender Gruppen: entfallen, die Lehrkraft ist frei */
  released: (NeedLesson & { absence: Absence; cancelled: boolean })[];
}

/** Rein: ordnet die Stunden eines Tages den Abwesenheiten zu. Fehlt die Gruppe, zählt die Stunde als Freisetzung (auch wenn die Lehrkraft fehlt). */
export function classifyNeeds(
  lessons: NeedLesson[],
  subs: Map<string, SubstitutionKind>,
  absences: Absence[],
  date: string,
  /** lessonId → vertretende Lehrkraft (für „Vertretung fällt aus“) */
  substitutes: Map<string, string> = new Map(),
): DayNeeds {
  const out: DayNeeds = { open: [], released: [] };
  for (const l of lessons) {
    const groupAbsence = absences.find((a) => a.groupId === l.groupId && absenceCovers(a, date, l.periodNr));
    if (groupAbsence) {
      out.released.push({ ...l, absence: groupAbsence, cancelled: subs.get(l.lessonId) === "cancel" });
      continue;
    }
    const teacherAbsence = l.teacherId ? absences.find((a) => a.teacherId === l.teacherId && absenceCovers(a, date, l.periodNr)) : undefined;
    const s = subs.get(l.lessonId);
    const sub = s === "substitute" ? substitutes.get(l.lessonId) : undefined;
    const subAbsence = sub ? absences.find((a) => a.teacherId === sub && absenceCovers(a, date, l.periodNr)) : undefined;
    if (subAbsence) out.open.push({ ...l, absence: teacherAbsence ?? subAbsence, status: "open", substituteAbsent: subAbsence.label });
    else if (teacherAbsence) out.open.push({ ...l, absence: teacherAbsence, status: s && s !== "room" ? s : "open" });
  }
  const order = (a: NeedLesson, b: NeedLesson) => a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de", { numeric: true });
  out.open.sort(order);
  out.released.sort(order);
  return out;
}

/** Vertretungsbedarf eines Tages aus den Abwesenheiten. */
export async function needsOn(db: Db, date: string): Promise<DayNeeds & { absences: Absence[] }> {
  const absences = await absencesBetween(db, date, date);
  if (!absences.length) return { open: [], released: [], absences };
  const rows = await db
    .select({ l: timetableLessons, groupName: groups.name, subjectName: subjects.name, teacherCode: users.shortCode })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(users, eq(users.id, timetableLessons.teacherId));
  const active = rows.filter((r) => lessonActiveOn(r.l, date));
  const subs = active.length
    ? await db
        .select({
          lessonId: timetableSubstitutions.lessonId,
          kind: timetableSubstitutions.kind,
          substituteId: timetableSubstitutions.substituteId,
          mergeLessonId: timetableSubstitutions.mergeLessonId,
        })
        .from(timetableSubstitutions)
        .where(
          and(
            eq(timetableSubstitutions.date, date),
            inArray(
              timetableSubstitutions.lessonId,
              active.map((r) => r.l.id),
            ),
          ),
        )
    : [];
  const needs = classifyNeeds(
    active.map((r) => ({
      lessonId: r.l.id,
      periodNr: r.l.periodNr,
      groupId: r.l.groupId,
      groupName: r.groupName,
      subjectName: r.subjectName,
      teacherId: r.l.teacherId,
      teacherCode: r.teacherCode,
      roomId: r.l.roomId,
    })),
    // R1b/A10: eine Zusammenlegung ohne aufnehmende Stunde (gelöscht) regelt nichts – der Bedarf ist wieder offen
    new Map(subs.filter((s) => s.kind !== "merge" || s.mergeLessonId).map((s) => [s.lessonId, s.kind])),
    absences,
    date,
    new Map(subs.filter((s) => s.substituteId).map((s) => [s.lessonId, s.substituteId!])),
  );
  return { ...needs, absences };
}
