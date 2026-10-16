// Setzhilfe (P2b-12): offene Stunden aus der Unterrichtsverteilung setzen, Freiraster mit Gründen, Verschieben/Tauschen.
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, rooms, subjects, timetableLessons, users } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { createLesson, defaultValidity, saveCoupling, slotsOverlap, suggestRoom, updateLesson } from "./manage";
import type { LESSON_WEEKS } from "./schema";
import { distribution, planningYear, type Assignment } from "./verteilung";
import { allPrefs, blockedReasons } from "./zeitwuensche";

type Week = (typeof LESSON_WEEKS)[number];

/** Eine Stunde des Plans mit Anzeigenamen, wie das Freiraster sie braucht. */
export interface GridLesson {
  id: string;
  couplingId: string | null;
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  teacherId: string | null;
  teacherCode: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
  week: Week;
  validFrom: string;
  validUntil: string | null;
  /** fixiert für die automatische Planung */
  fixed?: boolean;
}

/** Ein Teil dessen, was gesetzt wird: Einzelstunde = 1 Teil, Kopplung = alle Teile. */
export interface UnitRow {
  groupId: string;
  teacherId: string | null;
  roomId: string | null;
  week: Week;
  validFrom: string;
  validUntil: string | null;
}

export type Cell =
  | { state: "current" }
  /** `rooms[i]` = Raum für Teil i (bei belegtem Wunschraum ein freier Raum gleicher Art oder keiner) */
  | { state: "free"; rooms: (string | null)[]; roomNote: string | null }
  | { state: "swap"; partnerIds: string[]; label: string }
  | { state: "blocked"; reasons: string[] };

interface Blocker {
  kind: "teacher" | "group" | "room";
  lesson: GridLesson;
  message: string;
}

const cellKey = (weekday: number, periodNr: number) => `${weekday}-${periodNr}`;

/** Was hindert `rows` daran, in diesem Slot zu liegen? Stunden aus `exclude` zählen nicht. */
function blockersAt(rows: UnitRow[], weekday: number, periodNr: number, lessons: GridLesson[], exclude: Set<string>, checkRooms: boolean): Blocker[] {
  const out: Blocker[] = [];
  for (const row of rows) {
    const slot = { ...row, weekday, periodNr };
    for (const l of lessons) {
      if (exclude.has(l.id) || !slotsOverlap(l, slot)) continue;
      if (row.teacherId && l.teacherId === row.teacherId) out.push({ kind: "teacher", lesson: l, message: `${l.teacherCode ?? "Lehrkraft"} unterrichtet ${l.groupName}` });
      if (l.groupId === row.groupId) out.push({ kind: "group", lesson: l, message: `${l.groupName} hat ${l.subjectName}` });
      if (checkRooms && row.roomId && l.roomId === row.roomId) out.push({ kind: "room", lesson: l, message: `Raum ${row.roomId} belegt (${l.groupName})` });
    }
  }
  return out;
}

const unique = (xs: string[]) => [...new Set(xs)];

/** Ist ein Raum im Slot frei (für alle Zeilen)? */
function roomFree(roomId: string, rows: UnitRow[], weekday: number, periodNr: number, lessons: GridLesson[], exclude: Set<string>) {
  return rows.every((row) => !lessons.some((l) => !exclude.has(l.id) && l.roomId === roomId && slotsOverlap(l, { ...row, weekday, periodNr })));
}

export interface GridInput {
  rows: UnitRow[];
  /** bestehende Stunden der Einheit (beim Verschieben), sonst leer */
  unitIds: string[];
  /** aktueller Slot beim Verschieben */
  current?: { weekday: number; periodNr: number };
  /** Gruppe, deren Stunden zum Tauschen angeboten werden (beim Verschieben) */
  swapGroupId?: string;
  lessons: GridLesson[];
  rooms: { id: string; kind: string; active: boolean }[];
  weekdays: number[];
  periods: number[];
  /** gesperrte Zeiten aus den Zeitwünschen (P2b-21): Gründe je Slot */
  blocked?: (weekday: number, periodNr: number) => string[];
}

/** Freiraster: je Slot frei (mit Raum), tauschbar oder belegt mit Gründen. */
export function placementGrid(input: GridInput): Map<string, Cell> {
  const grid = new Map<string, Cell>();
  for (const d of input.weekdays) for (const p of input.periods) grid.set(cellKey(d, p), placementCell(input, d, p));
  return grid;
}

export function placementCell(input: GridInput, weekday: number, periodNr: number): Cell {
  const { rows, lessons, current } = input;
  if (current && current.weekday === weekday && current.periodNr === periodNr) return { state: "current" };
  const exclude = new Set(input.unitIds);
  const hard = blockersAt(rows, weekday, periodNr, lessons, exclude, false);
  const prefBlocks = input.blocked?.(weekday, periodNr) ?? [];
  if (prefBlocks.length) return { state: "blocked", reasons: unique([...hard.map((b) => b.message), ...prefBlocks]) };
  if (!hard.length) {
    // Räume: Wunschraum, sonst ein freier aktiver Raum derselben Art, sonst ohne Raum
    const resolved = new Map<string, string | null>();
    const notes: string[] = [];
    const taken = new Set<string>();
    for (const row of rows) {
      if (!row.roomId || resolved.has(row.roomId)) continue;
      if (roomFree(row.roomId, rows, weekday, periodNr, lessons, exclude)) {
        resolved.set(row.roomId, row.roomId);
        taken.add(row.roomId);
        continue;
      }
      const kind = input.rooms.find((r) => r.id === row.roomId)?.kind;
      const alt = input.rooms.find((r) => r.active && r.kind === kind && !taken.has(r.id) && !rows.some((x) => x.roomId === r.id) && roomFree(r.id, rows, weekday, periodNr, lessons, exclude));
      resolved.set(row.roomId, alt?.id ?? null);
      if (alt) taken.add(alt.id);
      notes.push(alt ? `Raum ${row.roomId} belegt → ${alt.id}` : `Raum ${row.roomId} belegt → ohne Raum`);
    }
    return { state: "free", rooms: rows.map((r) => (r.roomId ? resolved.get(r.roomId)! : null)), roomNote: notes.length ? notes.join(", ") : null };
  }

  const reasons = unique(hard.map((b) => b.message));
  // Tauschen: im Ziel-Slot liegt genau eine Stunde/Kopplung der eigenen Gruppe
  if (current && input.swapGroupId) {
    const own = hard.filter((b) => b.kind === "group" && b.lesson.groupId === input.swapGroupId).map((b) => b.lesson);
    const units = unique(own.map((l) => l.couplingId ?? l.id));
    if (units.length === 1) {
      const partner = lessons.filter((l) => (l.couplingId ?? l.id) === units[0]);
      const both = new Set([...input.unitIds, ...partner.map((l) => l.id)]);
      const there = blockersAt(rows, weekday, periodNr, lessons, both, true);
      const back = blockersAt(partner, current.weekday, current.periodNr, lessons, both, true);
      if (!there.length && !back.length) {
        const first = partner[0]!;
        return { state: "swap", partnerIds: partner.map((l) => l.id), label: `${first.subjectName}${first.teacherCode ? ` (${first.teacherCode})` : ""}` };
      }
      return { state: "blocked", reasons: [...unique([...hard, ...there].map((b) => b.message)), ...unique(back.map((b) => `Tausch: ${b.message}`))] };
    }
  }
  return { state: "blocked", reasons };
}

// ---------------------------------------------------------------- Daten

/** Alle Stunden, die sich mit dem Zeitraum überschneiden, mit Namen fürs Raster. */
export async function gridLessons(db: Db, validFrom: string, validUntil: string | null): Promise<GridLesson[]> {
  const rows = await db
    .select({ l: timetableLessons, groupName: groups.name, subjectName: subjects.name, teacherCode: users.shortCode })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(users, eq(users.id, timetableLessons.teacherId))
    .where(and(validUntil ? lte(timetableLessons.validFrom, validUntil) : undefined, or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, validFrom))));
  return rows.map((r) => ({
    id: r.l.id,
    couplingId: r.l.couplingId,
    groupId: r.l.groupId,
    groupName: r.groupName,
    subjectId: r.l.subjectId,
    subjectName: r.subjectName,
    teacherId: r.l.teacherId,
    teacherCode: r.teacherCode,
    roomId: r.l.roomId,
    weekday: r.l.weekday,
    periodNr: r.l.periodNr,
    week: r.l.week,
    validFrom: r.l.validFrom,
    validUntil: r.l.validUntil,
    fixed: r.l.fixed,
  }));
}

export interface OpenAssignment extends Assignment {
  planned: number;
  open: number;
}

/** Lehraufträge der Gruppe im Planungsjahr mit noch offenen Wochenstunden (Stichtag heute). */
export async function openAssignments(db: Db, groupId: string, todayYmd: string): Promise<OpenAssignment[]> {
  const year = await planningYear(db);
  if (!year) return [];
  const d = await distribution(db, year, todayYmd);
  return d.assignments
    .filter((a) => a.groups.some((g) => g.id === groupId) && a.planned < a.hours)
    .map((a) => ({ ...a, open: a.hours - a.planned }));
}

/** Teile, die ein Lehrauftrag beim Setzen erzeugt: jede Gruppe × jede Lehrkraft (Kopplung/Teamteaching), ein Raum. */
export function assignmentRows(a: Pick<Assignment, "groups" | "teachers">, roomId: string | null, validity: { validFrom: string; validUntil: string | null }): UnitRow[] {
  const teachers = a.teachers.length ? a.teachers.map((t) => t.id) : [null];
  return a.groups.flatMap((g) => teachers.map((teacherId) => ({ groupId: g.id, teacherId, roomId, week: "all" as const, ...validity })));
}

export interface Placement {
  rows: UnitRow[];
  validity: { validFrom: string; validUntil: string | null };
  lessons: GridLesson[];
  rooms: { id: string; kind: string; active: boolean }[];
  blocked: (weekday: number, periodNr: number) => string[];
}

/** Gesperrte Zeiten aller Beteiligten (Lehrkräfte, Gruppen, Räume, Fach) als Slot-Prüfung. */
async function prefBlocker(db: Db, targets: { kind: "teacher" | "group" | "room" | "subject"; id: string | null; label: string }[]) {
  const prefs = await allPrefs(db);
  return (weekday: number, periodNr: number) => blockedReasons(prefs, targets, weekday, periodNr);
}

/** Alles, was das Freiraster zum Setzen eines Lehrauftrags braucht. */
export async function assignmentPlacement(db: Db, a: Assignment, todayYmd: string, from?: string): Promise<Placement> {
  const [validity, roomList, [subject], [home]] = await Promise.all([
    defaultValidity(db, todayYmd, from),
    db.select({ id: rooms.id, kind: rooms.kind, active: rooms.active }).from(rooms).orderBy(rooms.id),
    db.select({ roomKind: subjects.roomKind }).from(subjects).where(eq(subjects.id, a.subjectId)),
    db.select({ homeRoomId: groups.homeRoomId }).from(groups).where(eq(groups.id, a.groups[0]?.id ?? "")),
  ]);
  const roomId = a.roomId ?? suggestRoom(subject, home?.homeRoomId ?? null, roomList);
  const blocked = await prefBlocker(db, [
    ...a.teachers.map((t) => ({ kind: "teacher" as const, id: t.id, label: t.code ?? t.name })),
    ...a.groups.map((g) => ({ kind: "group" as const, id: g.id, label: g.name })),
    { kind: "room" as const, id: roomId, label: `Raum ${roomId}` },
    { kind: "subject" as const, id: a.subjectId, label: a.subjectName },
  ]);
  return { rows: assignmentRows(a, roomId, validity), validity, lessons: await gridLessons(db, validity.validFrom, validity.validUntil), rooms: roomList, blocked };
}

const slotName = (weekday: number, periodNr: number) => `${["Mo", "Di", "Mi", "Do", "Fr"][weekday]} ${periodNr}. Stunde`;

/** Setzt eine Stunde eines Lehrauftrags in den Slot (bei mehreren Gruppen/Lehrkräften als Kopplung). */
export async function placeAssignment(db: Db, actorId: string, assignmentId: string, groupId: string, weekday: number, periodNr: number, todayYmd: string, from?: string): Promise<void> {
  const a = (await openAssignments(db, groupId, from ?? todayYmd)).find((x) => x.id === assignmentId);
  if (!a) throw new ValidationError({ assignment: "Für diesen Lehrauftrag ist keine Stunde mehr offen" });
  const pl = await assignmentPlacement(db, a, todayYmd, from);
  const cell = placementCell({ ...pl, unitIds: [], weekdays: [weekday], periods: [periodNr] }, weekday, periodNr);
  if (cell.state !== "free") throw new ValidationError({ slot: `${slotName(weekday, periodNr)}: ${cell.state === "blocked" ? cell.reasons.join(", ") : "belegt"}` });
  const slot = { weekday, periodNr, week: "all" as const, ...pl.validity };
  if (pl.rows.length === 1) {
    const r = pl.rows[0]!;
    await createLesson(db, actorId, { ...slot, groupId: r.groupId, subjectId: a.subjectId, teacherId: r.teacherId, roomId: cell.rooms[0]! });
  } else {
    await saveCoupling(db, actorId, null, { ...slot, parts: pl.rows.map((r, i) => ({ groupId: r.groupId, subjectId: a.subjectId, teacherId: r.teacherId, roomId: cell.rooms[i]! })) });
  }
}

export interface MoveUnit {
  lessons: GridLesson[];
  /** Teile der Einheit (Einzelstunde oder alle Teile der Kopplung) */
  unit: GridLesson[];
  rooms: { id: string; kind: string; active: boolean }[];
  blocked: (weekday: number, periodNr: number) => string[];
}

/** Die Stunde (bzw. ihre Kopplung) und alle Stunden, die sich mit ihrer Gültigkeit überschneiden. */
export async function movePlacement(db: Db, lessonId: string): Promise<MoveUnit | null> {
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, lessonId));
  if (!l) return null;
  const [lessons, roomList] = await Promise.all([
    gridLessons(db, l.validFrom, l.validUntil),
    db.select({ id: rooms.id, kind: rooms.kind, active: rooms.active }).from(rooms).orderBy(rooms.id),
  ]);
  const unit = lessons.filter((x) => (l.couplingId ? x.couplingId === l.couplingId : x.id === l.id));
  const blocked = await prefBlocker(db, [
    ...unit.map((u) => ({ kind: "teacher" as const, id: u.teacherId, label: u.teacherCode ?? "Lehrkraft" })),
    ...unit.map((u) => ({ kind: "group" as const, id: u.groupId, label: u.groupName })),
    ...unit.map((u) => ({ kind: "room" as const, id: u.roomId, label: `Raum ${u.roomId}` })),
    ...unit.map((u) => ({ kind: "subject" as const, id: u.subjectId, label: u.subjectName })),
  ]);
  return { lessons, unit, rooms: roomList, blocked };
}

export function moveGridInput(m: MoveUnit, swapGroupId: string, weekdays: number[], periods: number[]): GridInput {
  const first = m.unit[0]!;
  return {
    rows: m.unit,
    unitIds: m.unit.map((u) => u.id),
    current: { weekday: first.weekday, periodNr: first.periodNr },
    swapGroupId,
    lessons: m.lessons,
    rooms: m.rooms,
    weekdays,
    periods,
    blocked: m.blocked,
  };
}

/** Verschiebt eine Stunde/Kopplung in einen freien Slot oder tauscht sie mit der Stunde der Gruppe dort. */
export async function moveLesson(db: Db, actorId: string, lessonId: string, groupId: string, weekday: number, periodNr: number): Promise<"moved" | "swapped"> {
  const m = await movePlacement(db, lessonId);
  if (!m || !m.unit.length) throw new ValidationError({ id: "Stunde gibt es nicht mehr" });
  const cell = placementCell(moveGridInput(m, groupId, [weekday], [periodNr]), weekday, periodNr);
  const first = m.unit[0]!;
  if (cell.state === "current") return "moved";
  if (cell.state === "blocked") throw new ValidationError({ slot: `${slotName(weekday, periodNr)}: ${cell.reasons.join(", ")}` });
  if (cell.state === "free") {
    const slot = { weekday, periodNr, week: first.week, validFrom: first.validFrom, validUntil: first.validUntil };
    if (!first.couplingId) {
      await updateLesson(db, actorId, first.id, { ...slot, groupId: first.groupId, subjectId: first.subjectId, teacherId: first.teacherId, roomId: cell.rooms[0]! });
    } else {
      await saveCoupling(db, actorId, first.couplingId, {
        ...slot,
        parts: m.unit.map((u, i) => ({ id: u.id, groupId: u.groupId, subjectId: u.subjectId, teacherId: u.teacherId, roomId: cell.rooms[i]! })),
      });
    }
    return "moved";
  }
  // Tauschen: beide Einheiten wechseln den Slot, Räume bleiben
  const partner = m.lessons.find((l) => l.id === cell.partnerIds[0])!;
  await db.transaction(async (tx) => {
    for (const u of m.unit) await tx.update(timetableLessons).set({ weekday, periodNr }).where(eq(timetableLessons.id, u.id));
    for (const id of cell.partnerIds) await tx.update(timetableLessons).set({ weekday: first.weekday, periodNr: first.periodNr }).where(eq(timetableLessons.id, id));
  });
  await audit(db, actorId, "stundenplan.lesson.swap", groupId, {
    lesson: first.id,
    with: partner.id,
    from: slotName(first.weekday, first.periodNr),
    to: slotName(weekday, periodNr),
  });
  return "swapped";
}

