// Demo-Stundenplan (seit P2b-24): Unterrichtsverteilung aus der Stundentafel (Lehrkräfte nach Fach und Auslastung,
// Klassenleitung unterrichtet ihre Fächer in der eigenen Klasse), dann erzeugt der Solver den Plan.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import {
  curriculumHours,
  groupMembers,
  groups,
  periods,
  subjects,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableBands,
  timetableDeputies,
  timetableDuties,
  timetableDutyAreas,
  timetableLessons,
  timetableReductions,
  timetableSubstitutions,
  users,
} from "@/core/db/schema";
import { TEACHERS } from "@/core/seed/data";
import { toUsername } from "@/core/seed/rng";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, toBerlinDate, weekdayMon0 } from "@/core/time";
import { breaksFrom } from "./aufsichten";
import { lessonActiveOn } from "./service";
import { solve, validate } from "./solver";
import { solverInputFromDb } from "./solver-input";
import { proposedLessons, withCouplingIds } from "./solverlauf";
import { planningYear } from "./verteilung";

/** Doppelstunden in der Demo: Sport und Kunst (ab 2 Std.), Leistungskurse */
const DOUBLE_SUBJECTS = new Set(["SP", "KU"]);

/**
 * Demo-Raster: 1.–6. Stunde täglich, 7. Stunde (Ganztag) nur Mo/Di/Do, keine 8. Stunde – als Sperrzeiten für alle
 * Klassen und Kurse an den Solver gegeben (nicht gespeichert, damit die Zeitwünsche der Demo leer bleiben).
 */
function demoBlocked(periodNrs: number[]): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (let d = 0; d < 5; d++) for (const p of periodNrs) if (p > 7 || (p === 7 && ![0, 1, 3].includes(d))) m.set(`${d}-${p}`, null);
  return m;
}

export async function seedStundenplan(db: Db, now = new Date()) {
  const year = await planningYear(db);
  if (!year) return 0;
  const teacherRows = await db.select({ id: users.id, code: users.shortCode }).from(users).where(eq(users.role, "lehrkraft"));
  const byCode = new Map(teacherRows.map((t) => [t.code!, t.id]));
  const load = new Map<string, number>();
  const qualified = (subjectId: string) => TEACHERS.filter(([, , , subs]) => subs.includes(subjectId)).map(([, , code]) => byCode.get(code)!);
  /** Lehrkraft mit dem Fach und der geringsten Auslastung (Bevorzugte zuerst) */
  const assign = (subjectId: string, hours: number, prefer?: string) => {
    const pool = qualified(subjectId);
    const id = prefer && pool.includes(prefer) ? prefer : pool.reduce((best, t) => ((load.get(t) ?? 0) < (load.get(best) ?? 0) ? t : best));
    load.set(id, (load.get(id) ?? 0) + hours);
    return id;
  };

  const classRows = await db
    .select({ id: groups.id, grade: groups.gradeLevel, slug: groups.slug, leader: groupMembers.userId })
    .from(groups)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.role, "leader")))
    .where(eq(groups.kind, "klasse"));
  const sek1 = classRows.filter((c) => c.grade !== null && c.grade <= 10).sort((a, b) => a.slug.localeCompare(b.slug, "de", { numeric: true }));
  for (const [i, c] of sek1.entries())
    await db
      .update(groups)
      .set({ homeRoomId: `1${String(i + 1).padStart(2, "0")}` })
      .where(eq(groups.id, c.id));

  // Unterrichtsverteilung: Stundentafel je Klasse, Oberstufenkurse mit ihrer Kursleitung
  const tafel = await db
    .select()
    .from(curriculumHours)
    .innerJoin(subjects, eq(subjects.id, curriculumHours.subjectId))
    .orderBy(asc(curriculumHours.gradeLevel), asc(subjects.sortOrder));
  const rows: { id: string; groupId: string; subjectId: string; hours: number; doubles: number; teacherId: string }[] = [];
  for (const c of sek1) {
    for (const { curriculum_hours: t } of tafel.filter((x) => x.curriculum_hours.gradeLevel === c.grade)) {
      // Klassenleitung unterrichtet ihre Fächer in der eigenen Klasse; in der 7b gibt Jana Brandt Deutsch und Englisch
      const teacherId = assign(t.subjectId, t.hours, c.leader ?? undefined);
      rows.push({
        id: `la-${c.id}-${t.subjectId}`,
        groupId: c.id,
        subjectId: t.subjectId,
        hours: t.hours,
        doubles: DOUBLE_SUBJECTS.has(t.subjectId) && t.hours >= 2 ? 1 : 0,
        teacherId,
      });
    }
  }
  const courseRows = await db
    .select({ id: groups.id, subjectId: groups.subjectId, slug: groups.slug, leader: groupMembers.userId })
    .from(groups)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.role, "leader")))
    .where(inArray(groups.kind, ["kurs"]));
  for (const c of courseRows) {
    const lk = c.slug.includes("-lk");
    const hours = lk ? 5 : 3;
    load.set(c.leader, (load.get(c.leader) ?? 0) + hours);
    rows.push({ id: `la-${c.id}-${c.subjectId}`, groupId: c.id, subjectId: c.subjectId!, hours, doubles: lk ? 1 : 0, teacherId: c.leader });
  }
  // SP2-01/02: Beispiel-Band – drei Grundkurse der Q1 als Schiene (verschiedene Fächer und Lehrkräfte, je 3 Std., getrennte
  // Schüler:innen – Q-SP2-6). Der Solver setzt das Band als eine Einheit (eine Kopplung je Stunde); die Verteilung zeigt Soll/verplant.
  const schiene = new Set(rows.filter((r) => ["g-q1-e-gk1", "g-q1-d-gk1", "g-q1-bi-gk1"].includes(r.groupId) && r.hours === 3 && r.doubles === 0).map((r) => r.id));
  if (schiene.size > 1) await db.insert(timetableBands).values({ id: "band-q1-gk-a", schoolYearId: year.id, name: "Q1 GK-Schiene A", hours: 3, doubleLessons: 0 });
  await db.insert(timetableAssignments).values(
    rows.map((r) => ({
      id: r.id,
      schoolYearId: year.id,
      subjectId: r.subjectId,
      hours: r.hours,
      doubleLessons: r.doubles,
      bandId: schiene.size > 1 && schiene.has(r.id) ? "band-q1-gk-a" : null,
    })),
  );
  await db.insert(timetableAssignmentGroups).values(rows.map((r) => ({ assignmentId: r.id, groupId: r.groupId })));
  await db.insert(timetableAssignmentTeachers).values(rows.map((r) => ({ assignmentId: r.id, teacherId: r.teacherId })));

  // Der Solver erzeugt den Plan
  const input = await solverInputFromDb(db, year, toBerlinDate(now), { seed: 1 });
  const blocked = demoBlocked(input.periods);
  for (const g of new Set(input.units.flatMap((u) => u.groupIds))) input.prefs.set(`group:${g}`, blocked);
  const result = solve(input);
  if (result.unplaced.length)
    throw new Error(`Stundenplan-Seed: ${result.unplaced.length} Stunden passen nicht ins Raster, z. B. ${result.unplaced[0]!.label}`);
  const violations = validate(input, result.placements);
  if (violations.length) throw new Error(`Stundenplan-Seed: ${violations[0]}`);
  // Band-Stunden werden wie bei der Übernahme eine Kopplung je Stunde (SP2-02)
  const lessons = withCouplingIds(proposedLessons({ result, units: input.units, keptLessonIds: [], refYmd: year.startsOn }));
  await db.insert(timetableLessons).values(
    lessons.map((l) => ({
      groupId: l.groupId,
      weekday: l.weekday,
      periodNr: l.periodNr,
      subjectId: l.subjectId,
      teacherId: l.teacherId,
      roomId: l.roomId,
      couplingId: l.couplingId,
      validFrom: year.startsOn,
      validUntil: year.endsOn,
    })),
  );
  await seedDeputate(db, year.id);
  await seedAufsichten(db, year.id);
  await seedVertretungen(db, now);
  return lessons.length;
}

/** Beispiel-Deputate: Schulleitung, Koordination, Altersermäßigung, eine Teilzeitkraft. */
async function seedDeputate(db: Db, schoolYearId: string) {
  await db.insert(timetableDeputies).values({ schoolYearId, teacherId: "u-sophie.wagner", obligation: 14 });
  await db.insert(timetableReductions).values([
    { schoolYearId, teacherId: "u-petra.lindner", reason: "schulleitung", hours: 10 },
    { schoolYearId, teacherId: "u-tobias.kleine", reason: "koordination", hours: 3, note: "Stufenkoordination 8–10" },
    { schoolYearId, teacherId: "u-daniel.okafor", reason: "alter", hours: 1 },
    { schoolYearId, teacherId: "u-jana.brandt", reason: "ausbildung", hours: 1, note: "Mentorin LAA" },
  ]);
}

/** Pausenaufsichten: drei Bereiche, je Pause und Tag eine Lehrkraft je Bereich, reihum (P2b-20). */
async function seedAufsichten(db: Db, schoolYearId: string) {
  const areas = await db
    .insert(timetableDutyAreas)
    .values([
      { name: "Schulhof", sortOrder: 1 },
      { name: "Pausenhalle", sortOrder: 2 },
      { name: "Mensa", sortOrder: 3 },
    ])
    .returning({ id: timetableDutyAreas.id });
  const breaks = breaksFrom(await db.select().from(periods));
  const teachers = (await db.select({ id: users.id, code: users.shortCode }).from(users).where(eq(users.role, "lehrkraft"))).sort((a, b) =>
    a.code!.localeCompare(b.code!),
  );
  const rows: (typeof timetableDuties.$inferInsert)[] = [];
  let i = 0;
  for (let weekday = 0; weekday < 5; weekday++)
    for (const b of breaks)
      for (const a of areas) rows.push({ schoolYearId, areaId: a.id, weekday, afterPeriod: b.afterPeriod, teacherId: teachers[i++ % teachers.length]!.id });
  if (rows.length) await db.insert(timetableDuties).values(rows);
}

/** Zwei Beispiel-Änderungen am nächsten Schultag (wie im Mockup): Vertretung in der 7b, Entfall in der 9b. */
async function seedVertretungen(db: Db, now: Date) {
  const today = toBerlinDate(now);
  const date = (await loadSchoolCalendar(db)).nextSchoolDay(addDays(today, 1));
  const weekday = weekdayMon0(date);
  const lessons = (await db.select().from(timetableLessons).where(eq(timetableLessons.weekday, weekday))).filter((l) => lessonActiveOn(l, date));
  const at = (groupId: string, subjectId?: string) =>
    lessons.filter((l) => l.groupId === groupId && (!subjectId || l.subjectId === subjectId)).sort((a, b) => a.periodNr - b.periodNr);
  const lesson7b = at("g-7b", "M")[0] ?? at("g-7b")[0];
  const lesson9b = at("g-9b").at(-1);
  const rows: (typeof timetableSubstitutions.$inferInsert)[] = [];
  if (lesson7b) {
    const free = anyFreeTeacher(lessons, lesson7b.periodNr, "u-jana.brandt");
    const roomBusy = lessons.some((l) => l.periodNr === lesson7b.periodNr && l.roomId === "015");
    rows.push({
      lessonId: lesson7b.id,
      date,
      kind: "substitute",
      substituteId: free,
      roomId: roomBusy ? null : "015",
      note: "Material: Arbeitsheft S. 24",
      createdBy: "u-sabine.kowalski",
    });
  }
  if (lesson9b) rows.push({ lessonId: lesson9b.id, date, kind: "cancel", note: "Lehrkraft auf Fortbildung", createdBy: "u-sabine.kowalski" });
  if (rows.length) await db.insert(timetableSubstitutions).values(rows);
}

/** Lehrkraft ohne eigene Stunde zu dieser Zeit – bevorzugt `prefer` (für die Demo-Vertretung). */
function anyFreeTeacher(lessons: { periodNr: number; teacherId: string | null }[], periodNr: number, prefer: string): string | null {
  const busy = new Set(lessons.filter((l) => l.periodNr === periodNr).map((l) => l.teacherId));
  return [prefer, ...TEACHERS.map(([first, last]) => `u-${toUsername(first, last)}`)].find((id) => !busy.has(id)) ?? null;
}
