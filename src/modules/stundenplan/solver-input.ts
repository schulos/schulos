// Solver-Eingabe aus der Datenbank (P2b-22 Teil 2): Lehraufträge und Bänder (SP2-02) → Einheiten, Konfliktgruppen aus gemeinsamen
// Mitgliedern, Zeitwünsche, Räume, fixierte Stunden, große Pausen (SP-G-04a).
import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, groups, periods, rooms, subjects, users } from "@/core/db/schema";
import type { FixedLesson, SolverInput, SolverUnit, UnitPart } from "./solver";
import { longBreaksAfter } from "./solver-check";
import { distribution, planLessonsOn, type Distribution } from "./verteilung";
import { allPrefs } from "./zeitwuensche";
import { gridLessons, type GridLesson } from "./setzhilfe";
import { listGradeRules } from "./jahrgangsregeln";
import { dayRuleFor, type DayRule } from "./tagesgrenzen";
import { listTeacherRules } from "./deputate";
import { LIVE, type PlanSource } from "./plan-quelle";
import type { StartLesson } from "./warmstart";

export interface SolverInputOptions {
  /** Stunden, die bleiben, wo sie sind (fixiert); ihre Lehraufträge werden um diese Stunden gekürzt */
  fixedLessonIds?: string[];
  /** Stunden ohne Lehrauftrag bleiben als fixiert im Plan (Standard: ja) */
  keepUnmatched?: boolean;
  seed?: number;
  iterations?: number;
  /** SP3-02: Plan, gegen den gerechnet wird (fixierte/behaltene Stunden) – Vorgabe gültiger Plan, sonst der Entwurf einer Planversion */
  source?: PlanSource;
}

/** Gruppenarten, deren Stunden für die Klassen desselben Jahrgangs als belegt zählen (Kursband) – plus die Klassen selbst. */
const BAND_KINDS = new Set(["klasse", "kurs", "wahlpflicht", "foerderkurs"]);

/** Rein: Gruppen mit gemeinsamen Schüler:innen dürfen nicht parallel liegen. */
export function conflictsFrom(members: { groupId: string; userId: string }[]): Map<string, Set<string>> {
  const byUser = new Map<string, string[]>();
  for (const m of members) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m.groupId]);
  const out = new Map<string, Set<string>>();
  for (const gs of byUser.values()) {
    for (const a of gs)
      for (const b of gs) {
        if (a === b) continue;
        if (!out.has(a)) out.set(a, new Set());
        out.get(a)!.add(b);
      }
  }
  return out;
}

type UnitAssignment = Pick<Distribution["assignments"][number], "id" | "groups" | "hours" | "doubleLessons" | "subjectId" | "subjectName" | "teachers" | "roomId">;
type UnitBand = Pick<Distribution["bands"][number], "id" | "name" | "hours" | "doubleLessons" | "memberIds">;

export interface UnitInfo {
  roomKindOf: Map<string, string | null>;
  homeRoomOf: Map<string, string | null>;
  sizeOf: Map<string, number>;
  classIds: Set<string>;
  /** je Lehrauftrag schon fixierte Wochenstunden */
  fixedHours?: Map<string, number>;
}

/** Personen in den Gruppen (für die Raumgröße). */
const groupSize = (groupIds: string[], info: UnitInfo) => groupIds.reduce((s, g) => s + (info.sizeOf.get(g) ?? 0), 0);

/** Teile eines Lehrauftrags: ein Teil, bei mehreren Lehrkräften ein Teil je Lehrkraft (SP-G-02: geteilte Klasse, eigener Raum je Lehrkraft). */
function partsOf(a: UnitAssignment, info: UnitInfo): UnitPart[] {
  const groupIds = a.groups.map((g) => g.id);
  const single = groupIds.length === 1 && info.classIds.has(groupIds[0]!) ? (info.homeRoomOf.get(groupIds[0]!) ?? null) : null;
  const size = groupSize(groupIds, info);
  const teacherIds = a.teachers.map((t) => t.id);
  const need = { assignmentId: a.id, groupIds, subjectId: a.subjectId, roomId: a.roomId, roomKind: info.roomKindOf.get(a.subjectId) ?? null, homeRoomId: single };
  return teacherIds.length > 1 ? teacherIds.map((t) => ({ ...need, teacherIds: [t], size: Math.ceil(size / teacherIds.length) })) : [{ ...need, teacherIds, size }];
}

const unique = <T>(xs: T[]) => [...new Set(xs)];
const memberLabel = (a: UnitAssignment) => `${a.groups.map((g) => g.name).join(" + ")} ${a.subjectName}${a.teachers.length ? ` (${a.teachers.map((t) => t.code ?? t.name).join(" + ")})` : ""}`;

/** Einheiten (Doppelstunden als Zweier-Block, dann Einzelstunden) aus den gemeinsamen Angaben. */
function pushUnits(out: SolverUnit[], idPrefix: string, hours: number, doubleLessons: number, common: Omit<SolverUnit, "id" | "length">) {
  const doubles = Math.min(doubleLessons, Math.floor(hours / 2));
  for (let i = 0; i < doubles; i++) out.push({ ...common, id: `${idPrefix}#d${i}`, length: 2 });
  for (let i = 0; i < hours - doubles * 2; i++) out.push({ ...common, id: `${idPrefix}#e${i}`, length: 1 });
}

/**
 * Rein: Lehraufträge und Bänder → Einheiten (Doppelstunden als Zweier-Block), abzüglich schon fixierter Stunden.
 * Lehrauftrag: ein Teil je Lehrkraft (Q-SP-13, SP-G-02). Band (SP2-02): **eine** Einheit je Wochenstunde des Bands mit einem Teil je
 * Mitglied (bei Teamteaching je Lehrkraft) – eigenes Fach, eigene Lehrkraft, eigener Raum je Teil; Gruppen und Lehrkräfte der
 * Einheit sind die aller Teile. Fixierte Stunden zählen je Mitglied: geplant wird, was dem am weitesten fixierten Mitglied noch
 * fehlt (kein Mitglied bekommt mehr als das Soll des Bands; Mitglieder mit weniger fixierten Stunden bleiben offen – die
 * Verteilung zeigt es). Mitglieder ohne Gruppe und leere Bänder ergeben keine Einheit; ein Band mit nur einem Mitglied wird wie
 * ein Lehrauftrag gesetzt (Einheiten-id nach dem Band, damit Vorschau und Übernahme eine Kopplung je Band-Stunde erzeugen).
 */
export function unitsFrom(d: { assignments: UnitAssignment[]; bands?: UnitBand[] }, info: UnitInfo): SolverUnit[] {
  const out: SolverUnit[] = [];
  const byId = new Map(d.assignments.map((a) => [a.id, a]));
  const inBand = new Set<string>();
  for (const b of d.bands ?? []) {
    const members = b.memberIds
      .map((id) => byId.get(id))
      .filter((a): a is UnitAssignment => Boolean(a) && a!.groups.length > 0)
      .sort((x, y) => (x.groups[0]?.name ?? "").localeCompare(y.groups[0]?.name ?? "", "de", { numeric: true }) || x.id.localeCompare(y.id));
    for (const m of b.memberIds) inBand.add(m);
    if (!members.length) continue;
    const parts = members.flatMap((a) => partsOf(a, info));
    const fixed = Math.max(0, ...members.map((a) => info.fixedHours?.get(a.id) ?? 0));
    const first = parts[0]!;
    const groupIds = unique(parts.flatMap((p) => p.groupIds));
    pushUnits(out, b.id, Math.max(0, b.hours - fixed), b.doubleLessons, {
      assignmentId: members[0]!.id,
      label: `${b.name}: ${members.map(memberLabel).join(" + ")}`,
      groupIds,
      teacherIds: unique(parts.flatMap((p) => p.teacherIds)),
      subjectId: first.subjectId,
      roomId: first.roomId,
      roomKind: parts.find((p) => p.roomKind)?.roomKind ?? null,
      homeRoomId: parts.length === 1 ? first.homeRoomId : null,
      size: groupSize(groupIds, info),
      parts,
    });
  }
  for (const a of d.assignments) {
    if (!a.groups.length || inBand.has(a.id)) continue;
    const parts = partsOf(a, info);
    const first = parts[0]!;
    pushUnits(out, a.id, Math.max(0, a.hours - (info.fixedHours?.get(a.id) ?? 0)), a.doubleLessons, {
      assignmentId: a.id,
      label: memberLabel(a),
      groupIds: first.groupIds,
      teacherIds: a.teachers.map((t) => t.id),
      subjectId: a.subjectId,
      roomId: a.roomId,
      roomKind: first.roomKind,
      homeRoomId: first.homeRoomId,
      size: groupSize(first.groupIds, info),
      parts,
    });
  }
  return out;
}

/** Was vor dem Start zu prüfen ist (L-02, SP-G-13, A/B): Fehler verhindern den Lauf, Warnungen kommen ins Protokoll. */
export interface InputCheck {
  errors: Record<string, string>;
  warnings: string[];
}

/**
 * Rein: Prüfung der Eingabe vor dem Lauf. Fehler: kein Zeitraster, keine Lehraufträge mit Gruppe, keine aktiven Räume.
 * Warnungen: Kurse mit Lehrauftrag ohne Mitglieder (der Solver kennt dann keine Schülerkonflikte, SP-G-13) und nicht fixierte
 * A/B-Wochen-Stunden mit Lehrauftrag (der Solver plant nur „jede Woche“ – die Übernahme würde sie ersetzen).
 */
export function checkInput(x: {
  periods: number;
  assignments: Pick<Distribution["assignments"][number], "id" | "groups">[];
  activeRooms: number;
  /** Gruppen mit Mitgliedern (Schüler:innen) */
  groupsWithMembers: Set<string>;
  groupKind: Map<string, string>;
  groupName: Map<string, string>;
  /** Stunden des Plans am Stichtag, die der Solver ersetzen würde (nicht fixiert, mit Lehrauftrag) */
  replaceable: Pick<GridLesson, "week" | "groupName" | "subjectName">[];
  /** SP2-02: Bänder – Mitglieder mit gemeinsamen Schüler:innen liegen parallel (Q-SP2-6: erlaubt, aber ein Hinweis) */
  bands?: Pick<Distribution["bands"][number], "name" | "memberIds">[];
  /** Gruppen mit gemeinsamen Schüler:innen (wie `conflictsFrom`) */
  conflicts?: Map<string, Set<string>>;
}): InputCheck {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  if (!x.periods) errors.periods = "Zuerst ein Zeitraster anlegen (Verwaltung → Stammdaten)";
  const withGroups = x.assignments.filter((a) => a.groups.length);
  if (!withGroups.length) errors.assignments = "Zuerst Lehraufträge in der Unterrichtsverteilung anlegen";
  if (!x.activeRooms) errors.rooms = "Zuerst aktive Räume anlegen (Verwaltung → Stammdaten)";
  const empty = [...new Set(withGroups.flatMap((a) => a.groups.map((g) => g.id)))].filter((g) => !x.groupsWithMembers.has(g) && x.groupKind.get(g) !== "klasse").sort((a, b) => (x.groupName.get(a) ?? a).localeCompare(x.groupName.get(b) ?? b, "de"));
  if (empty.length)
    warnings.push(
      `${empty.length} ${empty.length === 1 ? "Kurs" : "Kurse"} mit Lehrauftrag ohne Mitglieder (${empty
        .slice(0, 5)
        .map((g) => x.groupName.get(g) ?? g)
        .join(", ")}${empty.length > 5 ? ", …" : ""}) – Konflikte mit anderen Kursen sind unbekannt, die Kurse können parallel zu Kursen derselben Schüler:innen liegen`,
    );
  const ab = x.replaceable.filter((l) => l.week !== "all");
  if (ab.length) {
    const names = [...new Set(ab.map((l) => `${l.groupName} ${l.subjectName}`))].sort((a, b) => a.localeCompare(b, "de"));
    warnings.push(
      `${ab.length} A/B-Wochen-Stunden mit Lehrauftrag sind nicht fixiert (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}) – der Solver plant nur „jede Woche“; bei der Übernahme werden sie ersetzt. Fixieren, wenn sie bleiben sollen`,
    );
  }
  const shared = bandsWithSharedStudents(x.bands ?? [], x.assignments, x.conflicts ?? new Map());
  if (shared.length) {
    const names = shared.map((b) => b.name).sort((a, b) => a.localeCompare(b, "de"));
    warnings.push(
      `${names.length} ${names.length === 1 ? "Band" : "Bänder"} mit gemeinsamen Schüler:innen in mehreren Mitgliedern (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}) – die Mitglieder eines Bands liegen zur selben Zeit, diese Schüler:innen können nur einen der Kurse besuchen`,
    );
  }
  return { errors, warnings };
}

/**
 * Rein (Q-SP2-6): Bänder, in denen zwei Mitglieder Gruppen mit gemeinsamen Schüler:innen haben – sie liegen im Band parallel.
 * Liefert je Band die betroffenen Gruppenpaare (ids), für Hinweise in Vorprüfung und Diagnose.
 */
export function bandsWithSharedStudents<B extends { memberIds: string[] }>(
  bands: B[],
  assignments: Pick<Distribution["assignments"][number], "id" | "groups">[],
  conflicts: Map<string, Set<string>>,
): (B & { pairs: [string, string][] })[] {
  const groupOf = new Map(assignments.map((a) => [a.id, a.groups.map((g) => g.id)]));
  const out: (B & { pairs: [string, string][] })[] = [];
  for (const b of bands) {
    const groups = [...new Set(b.memberIds.flatMap((id) => groupOf.get(id) ?? []))];
    const pairs: [string, string][] = [];
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) if (conflicts.get(groups[i]!)?.has(groups[j]!)) pairs.push([groups[i]!, groups[j]!]);
    if (pairs.length) out.push({ ...b, pairs });
  }
  return out;
}

/**
 * Komplette Solver-Eingabe für ein Schuljahr am Stichtag – mit den Warnungen der Eingabeprüfung (`check`) und den Stunden, die ein Lauf
 * ersetzen würde (`current`, SQ-02: Startlösung des Warmstarts).
 */
export async function solverInputFromDb(
  db: Db,
  year: { id: string; startsOn: string; endsOn: string },
  todayYmd: string,
  opts: SolverInputOptions = {},
): Promise<SolverInput & { check: InputCheck; current: StartLesson[] }> {
  const source = opts.source ?? LIVE;
  const d = await distribution(db, year, todayYmd, { source });
  const [periodRows, roomRows, subjectRows, groupRows, memberRows, prefs, planned, grid, gradeRules, teacherRules] = await Promise.all([
    db.select({ nr: periods.nr, startsAt: periods.startsAt, endsAt: periods.endsAt }).from(periods).orderBy(periods.nr),
    db.select({ id: rooms.id, kind: rooms.kind, capacity: rooms.capacity, active: rooms.active }).from(rooms),
    db.select({ id: subjects.id, name: subjects.name, roomKind: subjects.roomKind }).from(subjects),
    db.select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel, homeRoomId: groups.homeRoomId }).from(groups),
    // nur Schüler:innen: Lehrkräfte sind oft Mitglied mehrerer Klassen, das macht Gruppen nicht unvereinbar
    db
      .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.role, "member"), eq(users.role, "schueler"))),
    allPrefs(db),
    planLessonsOn(db, d.refYmd, source),
    gridLessons(db, d.refYmd, d.refYmd, source),
    listGradeRules(db),
    // SP2-04: Tagesregeln je Lehrkraft des Schuljahres
    listTeacherRules(db, year.id),
  ]);
  const sizeOf = new Map<string, number>();
  for (const m of memberRows) sizeOf.set(m.groupId, (sizeOf.get(m.groupId) ?? 0) + 1);
  const classIds = new Set(groupRows.filter((g) => g.kind === "klasse").map((g) => g.id));
  // Jahrgang je Klasse und Kurs (SP2-02): Kurs-Stunden eines Jahrgangs zählen für dessen Klassen als belegt (wie in der Diagnose)
  const gradeOf = new Map(groupRows.filter((g) => g.gradeLevel !== null && BAND_KINDS.has(g.kind)).map((g) => [g.id, g.gradeLevel!]));
  // SP2-03: Tagesgrenzen je Klasse aus der Regel ihres Jahrgangs, wirksam im Zeitraster (Mittagspause im Raster oder Mittagsstunde)
  const ruleByGrade = new Map(gradeRules.map((r) => [r.grade, dayRuleFor(r, periodRows)] as const));
  const dayRules = new Map<string, DayRule>();
  for (const g of groupRows) {
    const rule = g.kind === "klasse" && g.gradeLevel !== null ? ruleByGrade.get(g.gradeLevel) : undefined;
    if (rule) dayRules.set(g.id, rule);
  }

  // fixiert: ausdrücklich gewählte Stunden und (standardmäßig) Stunden ohne Lehrauftrag
  const fixedIds = new Set([...(opts.fixedLessonIds ?? []), ...grid.filter((l) => l.fixed).map((l) => l.id)]);
  if (opts.keepUnmatched ?? true) for (const l of d.unmatched) fixedIds.add(l.id);
  // A-/B-Wochen-Stunden belegen ihren Slot sicherheitshalber jede Woche
  const fixedLessons = grid.filter((l) => fixedIds.has(l.id));
  const fixed: FixedLesson[] = fixedLessons.map((l) => ({
    groupId: l.groupId,
    teacherId: l.teacherId,
    roomId: l.roomId,
    subjectId: l.subjectId,
    weekday: l.weekday,
    periodNr: l.periodNr,
  }));
  // fixierte Stunden zählen auf ihren Lehrauftrag (gleiches Fach + Gruppe, bevorzugt gleiche Lehrkraft)
  const fixedHours = new Map<string, number>();
  for (const l of planned.filter((x) => fixedIds.has(x.id))) {
    const a =
      d.assignments.find(
        (x) => x.subjectId === l.subjectId && x.groups.some((g) => g.id === l.groupId) && (!l.teacherId || x.teachers.some((t) => t.id === l.teacherId)),
      ) ?? d.assignments.find((x) => x.subjectId === l.subjectId && x.groups.some((g) => g.id === l.groupId));
    if (!a) continue;
    fixedHours.set(a.id, (fixedHours.get(a.id) ?? 0) + l.weight);
  }
  const conflicts = conflictsFrom(memberRows);

  const names = new Map<string, string>([
    ...groupRows.map((g) => [g.id, g.name] as [string, string]),
    ...subjectRows.map((s) => [s.id, s.name] as [string, string]),
    ...d.teachers.map((t) => [t.id, t.code ?? t.name] as [string, string]),
  ]);
  const activeRooms = roomRows.filter((r) => r.active);
  const check = checkInput({
    periods: periodRows.length,
    assignments: d.assignments,
    activeRooms: activeRooms.length,
    groupsWithMembers: new Set(sizeOf.keys()),
    groupKind: new Map(groupRows.map((g) => [g.id, g.kind])),
    groupName: new Map(groupRows.map((g) => [g.id, g.name])),
    replaceable: grid.filter((l) => !fixedIds.has(l.id)),
    bands: d.bands,
    conflicts,
  });
  return {
    weekdays: [0, 1, 2, 3, 4],
    periods: periodRows.map((p) => p.nr),
    breakAfter: longBreaksAfter(periodRows),
    units: unitsFrom({ assignments: d.assignments, bands: d.bands }, {
      roomKindOf: new Map(subjectRows.map((s) => [s.id, s.roomKind])),
      homeRoomOf: new Map(groupRows.map((g) => [g.id, g.homeRoomId])),
      sizeOf,
      classIds,
      fixedHours,
    }),
    fixed,
    rooms: activeRooms.map(({ id, kind, capacity }) => ({ id, kind, capacity })),
    prefs,
    conflicts,
    classIds,
    gradeOf,
    dayRules,
    teacherRules,
    names,
    seed: opts.seed,
    iterations: opts.iterations,
    keptLessonIds: fixedLessons.map((l) => l.id),
    check,
    // SQ-02: Stunden, die der Lauf ersetzen darf – Startlösung für „ab aktuellem Entwurf verbessern“
    current: grid.filter((l) => !fixedIds.has(l.id)).map((l) => ({ groupId: l.groupId, subjectId: l.subjectId, teacherId: l.teacherId, roomId: l.roomId, weekday: l.weekday, periodNr: l.periodNr })),
  };
}
