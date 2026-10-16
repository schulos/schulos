// Eigene Fehlzeiten (Q5-13, I-08/I-21/I-22, F-03): Schüler:in und Eltern minderjähriger Kinder sehen die Fehlstunden und
// Verspätungen aus dem Klassenbuch mit Status. Die Klassenleitung entscheidet über Fehltage ohne Meldung („entschuldigt“ /
// „nicht entschuldigt“); erst die Entscheidung „nicht entschuldigt“ löst einen Gong an die Eltern aus – vorher steht in der
// Elternsicht nur „Fehlstunde ohne Meldung“. Ab N Tagen mit unentschuldigten Fehlstunden im Halbjahr (Moduleinstellung)
// bekommt die Klassenleitung einen Hinweis – keine Automatik Richtung Schulleitung/Behörde.
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit, auditRead } from "@/core/audit";
import { absenceReports, classbookAbsences, classbookEntries, groupMembers, groups, schoolYears, subjects, users } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { notify, notifyBundled } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { rangeLabel } from "./labels";
import { UNEXCUSED_HINT } from "./settings";
import { isSelfResponsible } from "@/core/school/majority";
import { canDecide, classOf, informedParents, isInformedParentOf } from "./zustaendig";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Status eines Fehltags: aus den Fehlstunden (nicht Verspätungen) des Tages und einer offenen Meldung. */
export type DayStatus = "ohne_meldung" | "gemeldet" | "entschuldigt" | "nicht_entschuldigt";
export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  ohne_meldung: "Fehlstunde ohne Meldung",
  gemeldet: "gemeldet",
  entschuldigt: "entschuldigt",
  nicht_entschuldigt: "nicht entschuldigt",
};

export interface AbsenceLesson {
  periodNr: number;
  subjectName: string;
  kind: "absent" | "late";
  minutesLate: number | null;
  excused: boolean | null;
}

export interface AbsenceDay {
  date: string;
  lessons: AbsenceLesson[];
  /** Fehlstunden (ohne Verspätungen) */
  absent: number;
  /** null = an dem Tag nur Verspätungen */
  status: DayStatus | null;
}

export interface AbsenceTotals {
  absent: number;
  excused: number;
  unexcused: number;
  open: number;
  lateCount: number;
  lateMinutes: number;
}

/** Rein: Status eines Tages. „nicht entschuldigt“ geht vor offen, offen vor „entschuldigt“. */
export function dayStatus(excused: readonly (boolean | null)[], reported: boolean): DayStatus | null {
  if (excused.length === 0) return null;
  if (excused.some((e) => e === false)) return "nicht_entschuldigt";
  if (excused.some((e) => e === null)) return reported ? "gemeldet" : "ohne_meldung";
  return "entschuldigt";
}

/** Rein: Fehlzeiten-Zeilen zu Tagen (neueste zuerst) und Summen. `reportedOn(date)` = offene Meldung deckt den Tag ab. */
export function buildDays(rows: readonly (AbsenceLesson & { date: string })[], reportedOn: (date: string) => boolean): { days: AbsenceDay[]; totals: AbsenceTotals } {
  const byDate = new Map<string, AbsenceLesson[]>();
  const totals: AbsenceTotals = { absent: 0, excused: 0, unexcused: 0, open: 0, lateCount: 0, lateMinutes: 0 };
  for (const { date, ...l } of rows) {
    byDate.set(date, [...(byDate.get(date) ?? []), l]);
    if (l.kind === "late") {
      totals.lateCount++;
      totals.lateMinutes += l.minutesLate ?? 0;
    } else {
      totals.absent++;
      if (l.excused === true) totals.excused++;
      else if (l.excused === false) totals.unexcused++;
      else totals.open++;
    }
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, lessons]) => {
      lessons.sort((a, b) => a.periodNr - b.periodNr);
      const absent = lessons.filter((l) => l.kind === "absent");
      return { date, lessons, absent: absent.length, status: dayStatus(absent.map((l) => l.excused), reportedOn(date)) };
    });
  return { days, totals };
}

async function absenceRows(db: Db, studentIds: readonly string[], from: string, to: string) {
  if (studentIds.length === 0) return [];
  return db
    .select({
      studentId: classbookAbsences.studentId,
      date: classbookEntries.date,
      periodNr: classbookEntries.periodNr,
      subjectName: subjects.name,
      kind: classbookAbsences.kind,
      minutesLate: classbookAbsences.minutesLate,
      excused: classbookAbsences.excused,
    })
    .from(classbookAbsences)
    .innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId))
    .innerJoin(subjects, eq(subjects.id, classbookEntries.subjectId))
    .where(and(inArray(classbookAbsences.studentId, [...studentIds]), gte(classbookEntries.date, from), lte(classbookEntries.date, to)));
}

/** Offene Meldungen (Status „gemeldet“) je Schüler:in als Zeiträume. */
async function pendingReports(db: Db, studentIds: readonly string[], from: string, to: string) {
  if (studentIds.length === 0) return [];
  return db
    .select({ studentId: absenceReports.studentId, fromDate: absenceReports.fromDate, toDate: absenceReports.toDate })
    .from(absenceReports)
    .where(and(inArray(absenceReports.studentId, [...studentIds]), eq(absenceReports.status, "gemeldet"), lte(absenceReports.fromDate, to), gte(absenceReports.toDate, from)));
}

/** Beginn des laufenden Schuljahres (Fallback: ein halbes Jahr zurück). */
export async function schoolYearStart(db: Db, todayYmd: string): Promise<string> {
  const [y] = await db.select({ startsOn: schoolYears.startsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  return y && y.startsOn <= todayYmd ? y.startsOn : addDays(todayYmd, -183);
}

/** Beginn des laufenden Halbjahres (ohne gepflegte Halbjahre: Schuljahresbeginn; ohne Schuljahr: ein halbes Jahr zurück). */
export async function termStart(db: Db, todayYmd: string): Promise<string> {
  const [y] = await db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
  if (!y || y.startsOn > todayYmd) return addDays(todayYmd, -183);
  return y.term2StartsOn && y.term2StartsOn <= todayYmd ? y.term2StartsOn : y.startsOn;
}

/**
 * Fehlzeiten einer Schülerin/eines Schülers im laufenden Schuljahr – für die Person selbst bzw. Eltern minderjähriger Kinder
 * (eigenständige Schüler:innen: Eltern nur mit deren Einwilligung, Q5-05). Einsicht durch Eltern wird protokolliert (`lesen.fehlzeiten`).
 */
export async function ownAbsences(db: Db, viewer: PermissionSet, studentId: string, todayYmd: string) {
  const self = viewer.role === "schueler" && viewer.userId === studentId;
  const parent = !self && viewer.role === "eltern" && (await isInformedParentOf(db, viewer.userId, studentId));
  if (!self && !parent) throw new ForbiddenError("abwesenheiten.fehlzeiten");
  const from = await schoolYearStart(db, todayYmd);
  const [rows, reports] = await Promise.all([absenceRows(db, [studentId], from, todayYmd), pendingReports(db, [studentId], from, todayYmd)]);
  if (parent) await auditRead(db, viewer.userId, "lesen.fehlzeiten", studentId);
  return { from, ...buildDays(rows, (d) => reports.some((r) => r.fromDate <= d && d <= r.toDate)) };
}

export interface OpenDay {
  studentId: string;
  studentName: string;
  groupName: string;
  date: string;
  /** Fehlstunden ohne Entscheidung an dem Tag */
  hours: number;
}

/** so weit zurück zeigt die Klassenleitung Fehltage ohne Meldung */
export const OPEN_DAYS_WINDOW = 30;

/**
 * Klassenleitung: Tage mit Fehlstunden, über die noch niemand entschieden hat und für die keine Meldung vorliegt
 * (Meldungen entscheidet die Klassenleitung oben in der Liste der Meldungen). Älteste zuerst.
 */
export async function openDays(db: Db, viewer: PermissionSet, todayYmd: string): Promise<OpenDay[]> {
  const all = await db.select({ id: groups.id }).from(groups).where(eq(groups.kind, "klasse"));
  const classIds = hasPermission(viewer, "abwesenheiten.manage") ? all.map((g) => g.id) : all.map((g) => g.id).filter((id) => viewer.leaderOf.has(id));
  if (classIds.length === 0) return [];
  const students = await db
    .selectDistinct({ id: users.id, name: users.name, groupName: groups.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(inArray(groupMembers.groupId, classIds), eq(users.role, "schueler")));
  if (students.length === 0) return [];
  const from = addDays(todayYmd, -OPEN_DAYS_WINDOW);
  const ids = students.map((s) => s.id);
  const [rows, reports] = await Promise.all([
    db
      .select({ studentId: classbookAbsences.studentId, date: classbookEntries.date })
      .from(classbookAbsences)
      .innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId))
      .where(and(inArray(classbookAbsences.studentId, ids), eq(classbookAbsences.kind, "absent"), isNull(classbookAbsences.excused), gte(classbookEntries.date, from), lte(classbookEntries.date, todayYmd))),
    pendingReports(db, ids, from, todayYmd),
  ]);
  const byKey = new Map<string, OpenDay>();
  const info = new Map(students.map((s) => [s.id, s]));
  for (const r of rows) {
    if (reports.some((p) => p.studentId === r.studentId && p.fromDate <= r.date && r.date <= p.toDate)) continue;
    const key = `${r.studentId}|${r.date}`;
    const prev = byKey.get(key);
    if (prev) prev.hours++;
    else byKey.set(key, { studentId: r.studentId, studentName: info.get(r.studentId)!.name, groupName: info.get(r.studentId)!.groupName, date: r.date, hours: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.studentName.localeCompare(b.studentName, "de"));
}

/** Tage mit mindestens einer unentschuldigten Fehlstunde seit `from`. */
export async function unexcusedDayCount(db: Db, studentId: string, from: string, to: string): Promise<number> {
  const rows = await db
    .selectDistinct({ date: classbookEntries.date })
    .from(classbookAbsences)
    .innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId))
    .where(and(eq(classbookAbsences.studentId, studentId), eq(classbookAbsences.kind, "absent"), eq(classbookAbsences.excused, false), gte(classbookEntries.date, from), lte(classbookEntries.date, to)));
  return rows.length;
}

/**
 * Nach einer Entscheidung „nicht entschuldigt“: Gong an die Eltern minderjähriger Kinder (F-03; ohne die Personen in
 * `exclude`, z. B. die meldende Person, die schon benachrichtigt ist) und – ab der eingestellten Zahl Tage im Halbjahr – ein
 * Hinweis an die Klassenleitung (eine Nachricht je Schüler:in und Halbjahr, die mitzählt).
 */
export async function afterUnexcused(db: Db, studentId: string, label: string, todayYmd: string, exclude: readonly (string | null)[] = []): Promise<void> {
  const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, studentId));
  // Q5-05: eigenständige Schüler:innen erfahren es selbst (Eltern nur mit ihrer Einwilligung)
  const self = (await isSelfResponsible(db, studentId)) ? [studentId] : [];
  const parents = [...self, ...(await informedParents(db, studentId))].filter((p) => !exclude.includes(p));
  await notify(db, parents, {
    moduleId: "abwesenheiten",
    title: `${student?.name}: ${label} nicht entschuldigt`,
    body: "Die Klassenleitung hat die Fehlzeit als nicht entschuldigt eingetragen. Fragen bitte direkt an die Klassenleitung.",
    href: "/abwesenheiten",
  });
  const threshold = Number(await readModuleSetting(db, UNEXCUSED_HINT)) || 0;
  if (threshold === 0) return;
  const from = await termStart(db, todayYmd);
  const n = await unexcusedDayCount(db, studentId, from, todayYmd);
  if (n < threshold) return;
  const { leaderIds } = await classOf(db, studentId);
  await notifyBundled(
    db,
    leaderIds.map((userId) => ({
      userId,
      title: `${student?.name}: ${n} Tage mit unentschuldigten Fehlstunden im Halbjahr`,
      body: `Hinweis ab ${threshold} Tagen. Es geht keine Meldung an Schulleitung oder Behörden – was daraus folgt, entscheidet die Schule.`,
      href: "/abwesenheiten",
    })),
    { moduleId: "abwesenheiten", bundleKey: `abwesenheiten:fehltage:${studentId}:${from}` },
  );
}

/**
 * Klassenleitung entscheidet über einen Fehltag ohne Meldung: setzt alle Fehlstunden des Tages auf entschuldigt bzw. nicht
 * entschuldigt. „Nicht entschuldigt“ informiert die Eltern minderjähriger Kinder (F-03).
 */
export async function decideDay(db: Db, viewer: PermissionSet, studentId: string, date: string, excused: boolean, todayYmd: string): Promise<void> {
  if (!(await canDecide(db, viewer, studentId))) throw new ForbiddenError("abwesenheiten.decide");
  if (!YMD.test(date) || date > todayYmd) throw new ValidationError({ date: "Tag prüfen" });
  const rows = await db
    .select({ id: classbookAbsences.id })
    .from(classbookAbsences)
    .innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId))
    .where(and(eq(classbookAbsences.studentId, studentId), eq(classbookAbsences.kind, "absent"), eq(classbookEntries.date, date)));
  if (rows.length === 0) throw new ValidationError({ date: "An dem Tag ist keine Fehlstunde eingetragen" });
  await db.update(classbookAbsences).set({ excused }).where(inArray(classbookAbsences.id, rows.map((r) => r.id)));
  await audit(db, viewer.userId, "abwesenheiten.decide_day", studentId, { date, excused, hours: rows.length });
  if (!excused) {
    await afterUnexcused(db, studentId, rangeLabel(date, date), todayYmd, [viewer.userId]);
  }
}
