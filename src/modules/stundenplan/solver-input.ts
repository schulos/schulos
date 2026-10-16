// Solver-Eingabe aus der Datenbank (P2b-22 Teil 2): Lehraufträge → Einheiten, Konfliktgruppen aus gemeinsamen
// Mitgliedern, Zeitwünsche, Räume, fixierte Stunden.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, groups, periods, rooms, subjects, users } from "@/core/db/schema";
import type { FixedLesson, SolverInput, SolverUnit } from "./solver";
import { distribution, planLessonsOn, type Distribution } from "./verteilung";
import { allPrefs } from "./zeitwuensche";
import { gridLessons } from "./setzhilfe";

export interface SolverInputOptions {
  /** Stunden, die bleiben, wo sie sind (fixiert); ihre Lehraufträge werden um diese Stunden gekürzt */
  fixedLessonIds?: string[];
  /** Stunden ohne Lehrauftrag bleiben als fixiert im Plan (Standard: ja) */
  keepUnmatched?: boolean;
  seed?: number;
  iterations?: number;
}

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

/** Rein: Lehraufträge → Einheiten (Doppelstunden als Zweier-Block), abzüglich schon fixierter Stunden. */
export function unitsFrom(
  d: Pick<Distribution, "assignments">,
  info: {
    roomKindOf: Map<string, string | null>;
    homeRoomOf: Map<string, string | null>;
    sizeOf: Map<string, number>;
    classIds: Set<string>;
    /** je Lehrauftrag schon fixierte Wochenstunden */
    fixedHours?: Map<string, number>;
  },
): SolverUnit[] {
  const out: SolverUnit[] = [];
  for (const a of d.assignments) {
    if (!a.groups.length) continue;
    const hours = Math.max(0, a.hours - (info.fixedHours?.get(a.id) ?? 0));
    const doubles = Math.min(a.doubleLessons, Math.floor(hours / 2));
    const groupIds = a.groups.map((g) => g.id);
    const label = `${a.groups.map((g) => g.name).join(" + ")} ${a.subjectName}${a.teachers.length ? ` (${a.teachers.map((t) => t.code ?? t.name).join(" + ")})` : ""}`;
    const single = groupIds.length === 1 && info.classIds.has(groupIds[0]!) ? (info.homeRoomOf.get(groupIds[0]!) ?? null) : null;
    const common = {
      assignmentId: a.id,
      label,
      groupIds,
      teacherIds: a.teachers.map((t) => t.id),
      subjectId: a.subjectId,
      roomId: a.roomId,
      roomKind: info.roomKindOf.get(a.subjectId) ?? null,
      homeRoomId: single,
      size: groupIds.reduce((s, g) => s + (info.sizeOf.get(g) ?? 0), 0),
    };
    for (let i = 0; i < doubles; i++) out.push({ ...common, id: `${a.id}#d${i}`, length: 2 });
    for (let i = 0; i < hours - doubles * 2; i++) out.push({ ...common, id: `${a.id}#e${i}`, length: 1 });
  }
  return out;
}

/** Komplette Solver-Eingabe für ein Schuljahr am Stichtag. */
export async function solverInputFromDb(
  db: Db,
  year: { id: string; startsOn: string; endsOn: string },
  todayYmd: string,
  opts: SolverInputOptions = {},
): Promise<SolverInput> {
  const d = await distribution(db, year, todayYmd);
  const [periodRows, roomRows, subjectRows, groupRows, memberRows, prefs, planned, grid] = await Promise.all([
    db.select({ nr: periods.nr }).from(periods).orderBy(periods.nr),
    db.select({ id: rooms.id, kind: rooms.kind, capacity: rooms.capacity, active: rooms.active }).from(rooms),
    db.select({ id: subjects.id, name: subjects.name, roomKind: subjects.roomKind }).from(subjects),
    db.select({ id: groups.id, name: groups.name, kind: groups.kind, homeRoomId: groups.homeRoomId }).from(groups),
    // nur Schüler:innen: Lehrkräfte sind oft Mitglied mehrerer Klassen, das macht Gruppen nicht unvereinbar
    db
      .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.role, "member"), eq(users.role, "schueler"))),
    allPrefs(db),
    planLessonsOn(db, d.refYmd),
    gridLessons(db, d.refYmd, d.refYmd),
  ]);
  const sizeOf = new Map<string, number>();
  for (const m of memberRows) sizeOf.set(m.groupId, (sizeOf.get(m.groupId) ?? 0) + 1);
  const classIds = new Set(groupRows.filter((g) => g.kind === "klasse").map((g) => g.id));

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
    // Kopplung: eine Stunde je Gruppe – nur die erste Gruppe zählt
    if (a.groups[0]!.id !== l.groupId) continue;
    fixedHours.set(a.id, (fixedHours.get(a.id) ?? 0) + l.weight);
  }

  const names = new Map<string, string>([
    ...groupRows.map((g) => [g.id, g.name] as [string, string]),
    ...subjectRows.map((s) => [s.id, s.name] as [string, string]),
    ...d.teachers.map((t) => [t.id, t.code ?? t.name] as [string, string]),
  ]);
  return {
    weekdays: [0, 1, 2, 3, 4],
    periods: periodRows.map((p) => p.nr),
    units: unitsFrom(d, {
      roomKindOf: new Map(subjectRows.map((s) => [s.id, s.roomKind])),
      homeRoomOf: new Map(groupRows.map((g) => [g.id, g.homeRoomId])),
      sizeOf,
      classIds,
      fixedHours,
    }),
    fixed,
    rooms: roomRows.filter((r) => r.active).map(({ id, kind, capacity }) => ({ id, kind, capacity })),
    prefs,
    conflicts: conflictsFrom(memberRows),
    classIds,
    names,
    seed: opts.seed,
    iterations: opts.iterations,
    keptLessonIds: fixedLessons.map((l) => l.id),
  };
}
