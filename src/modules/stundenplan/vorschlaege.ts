// Vertretungsvorschläge (P2b-19): freie Lehrkräfte mit Punkten und Begründung + Vertretungsstatistik.
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groups, schoolYears, subjects, timetableLessons, timetableSubstitutions, timetableTeacherSubjects, users } from "@/core/db/schema";
import { absencesBetween, absentGroups, absentTeachers } from "./abwesenheit";
import { lessonActiveOn } from "./service";
import { ownTeacherPeriod } from "./belegung";
import { standbyAt } from "./bereitschaft";
import { dayRuleBlocks } from "./vertretung-regeln";

/** Gewichte – bewusst einfach und erklärbar. */
export const WEIGHTS = {
  /** SP2-07: Bereitschaft zu dieser Stunde – steht immer oben */
  standby: 40,
  released: 30,
  knowsGroup: 20,
  knowsSubject: 15,
  /** SP-12: kennt die Klasse, aber nicht das Fach – kann stattdessen das eigene Fach geben */
  ownSubject: 10,
  gap: 10,
  edge: -10,
  dayOff: -25,
  perSubstitution: -2,
  twiceToday: -30,
} as const;

export interface Reason {
  label: string;
  points: number;
}

export interface Candidate {
  id: string;
  code: string | null;
  name: string;
  score: number;
  reasons: Reason[];
  /** SP-12 (Fachtausch): Fach, das die Lehrkraft regulär in der Gruppe gibt – Vorschlag „→ Mathe“ statt des ausgefallenen Fachs */
  suggestedSubject: { id: string; name: string } | null;
  /** SP2-07: hat zu dieser Stunde Bereitschaft */
  standby: boolean;
}

export interface ScoreInput {
  lesson: { groupId: string; subjectId: string; periodNr: number };
  /** freie Lehrkräfte (nicht belegt, nicht abwesend, nicht die eigene) */
  free: { id: string; code: string | null; name: string }[];
  /** Stunden, die die Lehrkräfte an diesem Tag sicher halten (ohne Entfall/abgegebene, inkl. übernommener Vertretungen) */
  dayPeriods: Map<string, number[]>;
  /** Lehrkräfte, deren Stunde zu dieser Zeit wegen einer abwesenden Klasse frei wird */
  released: Set<string>;
  /** Gruppen bzw. Fächer, die eine Lehrkraft regulär unterrichtet */
  teachesGroup: Map<string, Set<string>>;
  teachesSubject: Map<string, Set<string>>;
  /** SP-12: je Lehrkraft das Fach, das sie regulär in der Gruppe der Stunde gibt (bei mehreren das mit den meisten Wochenstunden) */
  ownSubjectInGroup?: Map<string, { id: string; name: string }>;
  /** Vertretungen bisher im Schuljahr bzw. heute */
  countYear: Map<string, number>;
  countToday: Map<string, number>;
  /** SP2-07: Lehrkräfte mit Bereitschaft zu dieser Stunde */
  standby?: Set<string>;
}

/**
 * Rein: bewertet freie Lehrkräfte; höchste Punktzahl zuerst, bei Gleichstand weniger Vertretungen, dann Kürzel. Fachtausch
 * („kann eigenes Fach geben“) nur, wenn keine freie Lehrkraft das ausgefallene Fach unterrichtet (SP-15, Q-SP-9-3).
 */
export function scoreCandidates(input: ScoreInput): Candidate[] {
  const { lesson } = input;
  const sameSubjectFree = input.free.some((t) => input.teachesSubject.get(t.id)?.has(lesson.subjectId));
  return input.free
    .map((t) => {
      const reasons: Reason[] = [];
      const standby = !!input.standby?.has(t.id);
      if (standby) reasons.push({ label: "Bereitschaft", points: WEIGHTS.standby });
      if (input.released.has(t.id)) reasons.push({ label: "frei durch Freisetzung", points: WEIGHTS.released });
      if (input.teachesGroup.get(t.id)?.has(lesson.groupId)) reasons.push({ label: "unterrichtet die Klasse", points: WEIGHTS.knowsGroup });
      const knowsSubject = !!input.teachesSubject.get(t.id)?.has(lesson.subjectId);
      if (knowsSubject) reasons.push({ label: "unterrichtet das Fach", points: WEIGHTS.knowsSubject });
      // SP-12: kennt die Klasse, aber nicht das ausgefallene Fach → kann das eigene Fach geben – SP-15: nur, wenn keine fachgleiche
      // Vertretung frei ist (das Fach der Stunde geht vor)
      const own = !sameSubjectFree && input.teachesGroup.get(t.id)?.has(lesson.groupId) && !knowsSubject ? (input.ownSubjectInGroup?.get(t.id) ?? null) : null;
      if (own) reasons.push({ label: `kann eigenes Fach geben: ${own.name}`, points: WEIGHTS.ownSubject });
      const day = input.dayPeriods.get(t.id) ?? [];
      // freigesetzt bzw. in Bereitschaft: die Lehrkraft ist zu dieser Stunde ohnehin in der Schule – keine Rand-/Frei-Abzüge
      if (!input.released.has(t.id) && !standby) {
        if (!day.length) reasons.push({ label: "hat sonst frei", points: WEIGHTS.dayOff });
        else if (day.some((p) => p < lesson.periodNr) && day.some((p) => p > lesson.periodNr)) reasons.push({ label: "Hohlstunde", points: WEIGHTS.gap });
        else reasons.push({ label: "Randstunde", points: WEIGHTS.edge });
      }
      const year = input.countYear.get(t.id) ?? 0;
      if (year > 0) reasons.push({ label: `${year} Vertretung${year === 1 ? "" : "en"} im Schuljahr`, points: WEIGHTS.perSubstitution * year });
      const today = input.countToday.get(t.id) ?? 0;
      if (today >= 2) reasons.push({ label: `heute schon ${today}× vertreten`, points: WEIGHTS.twiceToday });
      return { ...t, reasons, score: reasons.reduce((s, r) => s + r.points, 0), suggestedSubject: own, standby };
    })
    .sort(
      (a, b) =>
        Number(b.standby) - Number(a.standby) ||
        b.score - a.score || (input.countYear.get(a.id) ?? 0) - (input.countYear.get(b.id) ?? 0) || (a.code ?? a.name).localeCompare(b.code ?? b.name, "de"),
    );
}

async function yearOf(db: Db, date: string) {
  const ys = await db.select().from(schoolYears);
  return ys.find((y) => y.startsOn <= date && y.endsOn >= date) ?? null;
}

/** Vertretungsvorschläge für eine Stunde an einem Tag (bestbewertete zuerst). */
export async function suggestSubstitutes(db: Db, lessonId: string, date: string): Promise<Candidate[]> {
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, lessonId));
  if (!l) return [];
  const year = await yearOf(db, date);
  const [all, teachers, absences, yearSubs] = await Promise.all([
    db.select().from(timetableLessons),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")),
    absencesBetween(db, date, date),
    db
      .select({ substituteId: timetableSubstitutions.substituteId, date: timetableSubstitutions.date })
      .from(timetableSubstitutions)
      .where(
        and(
          eq(timetableSubstitutions.kind, "substitute"),
          gte(timetableSubstitutions.date, year?.startsOn ?? date),
          lte(timetableSubstitutions.date, year?.endsOn ?? date),
        ),
      ),
  ]);
  const today = all.filter((x) => lessonActiveOn(x, date));
  const subsToday = today.length
    ? await db
        .select()
        .from(timetableSubstitutions)
        .where(
          and(
            eq(timetableSubstitutions.date, date),
            inArray(
              timetableSubstitutions.lessonId,
              today.map((x) => x.id),
            ),
          ),
        )
    : [];
  const subOf = new Map(subsToday.map((s) => [s.lessonId, s]));
  // Gekoppelte Teile derselben Lehrkraft gelten als „diese Stunde“
  const unit = new Set(today.filter((x) => x.id === l.id || (l.couplingId && x.couplingId === l.couplingId && x.teacherId === l.teacherId)).map((x) => x.id));

  const dayPeriods = new Map<string, number[]>();
  const busy = absentTeachers(absences, date, l.periodNr);
  const gone = absentGroups(absences, date, l.periodNr);
  const released = new Set<string>();
  const push = (t: string, p: number) => dayPeriods.set(t, [...(dayPeriods.get(t) ?? []), p]);
  for (const x of today) {
    const s = subOf.get(x.id);
    const groupGone = absentGroups(absences, date, x.periodNr).has(x.groupId);
    // SP2-07: verlegte Stunden zählen in ihrer neuen Stunde, zusammengelegte nicht
    const held = ownTeacherPeriod(x, s);
    if (x.teacherId && held !== null && !groupGone && !absentTeachers(absences, date, held).has(x.teacherId)) {
      push(x.teacherId, held);
      if (held === l.periodNr && !unit.has(x.id)) busy.add(x.teacherId);
    }
    if (s?.kind === "substitute" && s.substituteId) {
      push(s.substituteId, x.periodNr);
      if (x.periodNr === l.periodNr && !unit.has(x.id)) busy.add(s.substituteId);
    }
    if (x.teacherId && x.periodNr === l.periodNr && gone.has(x.groupId)) released.add(x.teacherId);
  }
  const teachesGroup = new Map<string, Set<string>>();
  const teachesSubject = new Map<string, Set<string>>();
  for (const x of all) {
    // regulär = Stunde gilt an diesem Datum (unabhängig vom Wochentag)
    if (!x.teacherId || x.validFrom > date || (x.validUntil !== null && x.validUntil < date)) continue;
    if (!teachesGroup.has(x.teacherId)) teachesGroup.set(x.teacherId, new Set());
    if (!teachesSubject.has(x.teacherId)) teachesSubject.set(x.teacherId, new Set());
    teachesGroup.get(x.teacherId)!.add(x.groupId);
    teachesSubject.get(x.teacherId)!.add(x.subjectId);
  }
  // SP2-12: Lehrfächer aus den Stammdaten zählen mit – wer Physik als Lehrfach hat, gilt auch ohne Physik-Stunde in diesem Plan als
  // fachgleiche Vertretung (und verdrängt damit den Fachtausch, SP-15)
  for (const r of await db.select().from(timetableTeacherSubjects)) {
    if (!teachesSubject.has(r.teacherId)) teachesSubject.set(r.teacherId, new Set());
    teachesSubject.get(r.teacherId)!.add(r.subjectId);
  }
  // SP-12: je Lehrkraft das Fach mit den meisten Wochenstunden in dieser Gruppe (A/B-Stunden zählen halb)
  const hoursInGroup = new Map<string, Map<string, number>>();
  for (const x of all) {
    if (!x.teacherId || x.groupId !== l.groupId || x.validFrom > date || (x.validUntil !== null && x.validUntil < date)) continue;
    const m = hoursInGroup.get(x.teacherId) ?? new Map<string, number>();
    m.set(x.subjectId, (m.get(x.subjectId) ?? 0) + (x.week === "all" ? 1 : 0.5));
    hoursInGroup.set(x.teacherId, m);
  }
  const subjectNames = new Map((await db.select({ id: subjects.id, name: subjects.name }).from(subjects)).map((x) => [x.id, x.name]));
  const ownSubjectInGroup = new Map<string, { id: string; name: string }>();
  for (const [teacherId, m] of hoursInGroup) {
    const [best] = [...m].sort((a, b) => b[1] - a[1] || (subjectNames.get(a[0]) ?? a[0]).localeCompare(subjectNames.get(b[0]) ?? b[0], "de"));
    if (best && best[0] !== l.subjectId) ownSubjectInGroup.set(teacherId, { id: best[0], name: subjectNames.get(best[0]) ?? best[0] });
  }
  const countYear = new Map<string, number>();
  const countToday = new Map<string, number>();
  for (const s of yearSubs) {
    if (!s.substituteId) continue;
    countYear.set(s.substituteId, (countYear.get(s.substituteId) ?? 0) + 1);
    if (s.date === date) countToday.set(s.substituteId, (countToday.get(s.substituteId) ?? 0) + 1);
  }
  const freeTeachers = teachers.filter((t) => t.id !== l.teacherId && !busy.has(t.id));
  // SP2-07: Tagesregeln (SP2-04) – wer mit der Vertretung darüber käme, wird nicht vorgeschlagen
  const ruleBlocked = await dayRuleBlocks(db, date, l.periodNr, freeTeachers.map((t) => t.id), dayPeriods);
  return scoreCandidates({
    lesson: { groupId: l.groupId, subjectId: l.subjectId, periodNr: l.periodNr },
    free: freeTeachers.filter((t) => !ruleBlocked.has(t.id)),
    standby: await standbyAt(db, date, l.periodNr),
    dayPeriods,
    released,
    teachesGroup,
    teachesSubject,
    ownSubjectInGroup,
    countYear,
    countToday,
  });
}

// ---------------------------------------------------------------- Statistik

export interface SubstitutionStats {
  from: string;
  to: string;
  /** SP-12: `ownSubject` = davon mit eigenem (abweichendem) Fach – rein informativ */
  teachers: { id: string; code: string | null; name: string; substitutions: number; ownSubject: number; given: number; cancelled: number }[];
  groups: { id: string; name: string; substituted: number; ownSubject: number; cancelled: number }[];
}

/**
 * Zähler im Zeitraum: je Lehrkraft gehaltene Vertretungen, abgegebene Stunden (vertreten) und Entfall ihrer Stunden;
 * je Gruppe vertretene und entfallene Stunden.
 */
export async function substitutionStats(db: Db, from: string, to: string): Promise<SubstitutionStats> {
  const rows = await db
    .select({
      kind: timetableSubstitutions.kind,
      substituteId: timetableSubstitutions.substituteId,
      teacherId: timetableLessons.teacherId,
      groupId: timetableLessons.groupId,
      subjectId: timetableSubstitutions.subjectId,
    })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .where(and(gte(timetableSubstitutions.date, from), lte(timetableSubstitutions.date, to)));
  const [teacherRows, groupRows] = await Promise.all([
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")),
    db.select({ id: groups.id, name: groups.name }).from(groups),
  ]);
  const t = new Map(teacherRows.map((x) => [x.id, { ...x, substitutions: 0, ownSubject: 0, given: 0, cancelled: 0 }]));
  const g = new Map<string, { id: string; name: string; substituted: number; ownSubject: number; cancelled: number }>();
  const groupName = new Map(groupRows.map((x) => [x.id, x.name]));
  for (const r of rows) {
    // SP2-07: Verlegung ist weder Vertretung noch Entfall; Zusammenlegung zählt als vertreten (ohne Vertretungslehrkraft)
    if (r.kind === "room" || r.kind === "move") continue;
    if (!g.has(r.groupId)) g.set(r.groupId, { id: r.groupId, name: groupName.get(r.groupId) ?? r.groupId, substituted: 0, ownSubject: 0, cancelled: 0 });
    const gs = g.get(r.groupId)!;
    if (r.kind === "cancel") {
      gs.cancelled++;
      if (r.teacherId && t.has(r.teacherId)) t.get(r.teacherId)!.cancelled++;
    } else {
      gs.substituted++;
      if (r.subjectId) gs.ownSubject++;
      if (r.substituteId && t.has(r.substituteId)) {
        t.get(r.substituteId)!.substitutions++;
        if (r.subjectId) t.get(r.substituteId)!.ownSubject++;
      }
      if (r.teacherId && t.has(r.teacherId)) t.get(r.teacherId)!.given++;
    }
  }
  return {
    from,
    to,
    teachers: [...t.values()]
      .filter((x) => x.substitutions + x.given + x.cancelled > 0)
      .sort((a, b) => b.substitutions - a.substitutions || (a.code ?? a.name).localeCompare(b.code ?? b.name, "de")),
    groups: [...g.values()].sort(
      (a, b) => b.substituted + b.cancelled - (a.substituted + a.cancelled) || a.name.localeCompare(b.name, "de", { numeric: true }),
    ),
  };
}
