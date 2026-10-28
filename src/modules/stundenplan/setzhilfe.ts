// Setzhilfe (P2b-12): offene Stunden aus der Unterrichtsverteilung setzen, Freiraster mit Gründen, Verschieben/Tauschen.
// SP2-02: ein Lehrauftrag im Band wird mit allen Mitgliedern des Bands als eine Kopplung gesetzt (Fach, Lehrkraft, Raum je Teil);
// Verschieben/Tauschen bewegt die ganze Kopplung.
// SP3-02: alles wahlweise im gültigen Plan oder im Entwurf einer Planversion (`PlanSource`); im Entwurf tragen gesetzte Stunden ihren
// Lehrauftrag (`assignment_id`), offene Stunden zählen gegen den Entwurf.
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, rooms, subjects, users } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { afterOf, createLesson, defaultValidity, liveUnitPlan, saveCoupling, slotsOverlap, suggestRoom, updateLesson } from "./manage";
import { idWhere, lessonCols, LIVE, overlapWhere, requireWritable, type PlanSource } from "./plan-quelle";
import { timetableLessons, type LESSON_WEEKS } from "./schema";
import { applyLiveUnits, type LiveOptions } from "./sofortkorrektur";
import { distribution, type Assignment } from "./verteilung";
import { yearOfSource } from "./planungsjahr";
import { allPrefs, blockedReasons } from "./zeitwuensche";
import { dayLimitReasons, type DayLimits } from "./tagesgrenzen";
import { loadDayLimits } from "./jahrgangsregeln";
import { teacherLimitReasons, type TeacherLimits } from "./lehrkraftregeln";
import { loadTeacherLimits } from "./deputate";

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

/** Ein Teil dessen, was gesetzt wird: Einzelstunde = 1 Teil, Kopplung/Band = alle Teile (je Teil eigenes Fach, SP2-02). */
export interface UnitRow {
  groupId: string;
  subjectId: string;
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

/**
 * SP2-03: Tagesgrenzen der Klassen, SP2-04: Tagesregeln der Lehrkräfte, die `rows` im Slot verletzten (Stunden aus `exclude` zählen
 * nicht; bei Bändern zählt jede Teil-Lehrkraft).
 */
function limitReasons(input: Pick<GridInput, "dayLimits" | "teacherLimits" | "lessons">, rows: Pick<UnitRow, "groupId" | "teacherId">[], exclude: Set<string>, weekday: number, periodNr: number): string[] {
  const classes = Boolean(input.dayLimits?.rules.size);
  const teachers = Boolean(input.teacherLimits?.rules.size);
  if (!classes && !teachers) return [];
  const others = input.lessons.filter((l) => !exclude.has(l.id));
  return [
    ...(classes
      ? dayLimitReasons(
          input.dayLimits!,
          rows.map((r) => r.groupId),
          others,
          weekday,
          [periodNr],
        )
      : []),
    ...(teachers
      ? teacherLimitReasons(
          input.teacherLimits!,
          rows.map((r) => r.teacherId),
          others,
          weekday,
          [periodNr],
        )
      : []),
  ];
}

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
  /** SP2-05: gesperrte Zeiten beliebiger Stunden – beim Tausch für die Stunden des Partners am bisherigen Slot */
  blockedFor?: (lessons: GridLesson[], weekday: number, periodNr: number) => string[];
  /** SP2-03: Tagesgrenzen und Ganztag je Klasse (Kurse des Jahrgangs zählen mit) */
  dayLimits?: DayLimits;
  /** SP2-04: Tagesregeln je Lehrkraft (höchstens Stunden am Tag, höchstens Anwesenheitstage) */
  teacherLimits?: TeacherLimits;
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
  const limits = limitReasons(input, rows, exclude, weekday, periodNr);
  if (limits.length) return { state: "blocked", reasons: unique([...hard.map((b) => b.message), ...limits]) };
  if (!hard.length) {
    // Räume je Teil: Wunschraum, sonst ein freier aktiver Raum derselben Art, sonst ohne Raum. Teile mit derselben Lehrkraft teilen
    // sich den Raum (eine Lehrkraft, mehrere Gruppen), ebenso Teile derselben Gruppe mit demselben Fach und Wunschraum (Teamteaching im
    // selben Raum); sonst bekommen verschiedene Lehrkräfte verschiedene Räume (SP2-02: Band, z. B. Religion/Philosophie einer Klasse).
    const notes: string[] = [];
    const taken = new Set<string>();
    const byTeacher = new Map<string, string | null>();
    const out: (string | null)[] = [];
    for (const [i, row] of rows.entries()) {
      if (!row.roomId) {
        out.push(null);
        continue;
      }
      if (row.teacherId && byTeacher.has(row.teacherId)) {
        out.push(byTeacher.get(row.teacherId)!);
        continue;
      }
      const team = rows.findIndex((x, j) => j < i && x.groupId === row.groupId && x.subjectId === row.subjectId && x.roomId === row.roomId);
      if (team >= 0) {
        if (row.teacherId) byTeacher.set(row.teacherId, out[team]!);
        out.push(out[team]!);
        continue;
      }
      let room: string | null;
      if (!taken.has(row.roomId) && roomFree(row.roomId, rows, weekday, periodNr, lessons, exclude)) room = row.roomId;
      else {
        const kind = input.rooms.find((r) => r.id === row.roomId)?.kind;
        const alt = input.rooms.find((r) => r.active && r.kind === kind && !taken.has(r.id) && !rows.some((x) => x.roomId === r.id) && roomFree(r.id, rows, weekday, periodNr, lessons, exclude));
        room = alt?.id ?? null;
        notes.push(alt ? `Raum ${row.roomId} belegt → ${alt.id}` : `Raum ${row.roomId} belegt → ohne Raum`);
      }
      if (room) taken.add(room);
      if (row.teacherId) byTeacher.set(row.teacherId, room);
      out.push(room);
    }
    return { state: "free", rooms: out, roomNote: notes.length ? notes.join(", ") : null };
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
      const swapLimits = [
        ...limitReasons(input, rows, both, weekday, periodNr),
        ...[...limitReasons(input, partner, both, current.weekday, current.periodNr), ...(input.blockedFor?.(partner, current.weekday, current.periodNr) ?? [])].map((r) => `Tausch: ${r}`),
      ];
      if (!there.length && !back.length && !swapLimits.length) {
        const first = partner[0]!;
        return { state: "swap", partnerIds: partner.map((l) => l.id), label: `${first.subjectName}${first.teacherCode ? ` (${first.teacherCode})` : ""}` };
      }
      return { state: "blocked", reasons: [...unique([...hard, ...there].map((b) => b.message)), ...unique(back.map((b) => `Tausch: ${b.message}`)), ...unique(swapLimits)] };
    }
  }
  return { state: "blocked", reasons };
}

// ---------------------------------------------------------------- Daten

/** Alle Stunden der Quelle (Vorgabe: gültiger Plan), die sich mit dem Zeitraum überschneiden, mit Namen fürs Raster. */
export async function gridLessons(db: Db, validFrom: string, validUntil: string | null, source: PlanSource = LIVE): Promise<GridLesson[]> {
  const t = lessonCols(source);
  const rows = await db
    .select({
      id: t.id,
      couplingId: t.couplingId,
      groupId: t.groupId,
      groupName: groups.name,
      subjectId: t.subjectId,
      subjectName: subjects.name,
      teacherId: t.teacherId,
      teacherCode: users.shortCode,
      roomId: t.roomId,
      weekday: t.weekday,
      periodNr: t.periodNr,
      week: t.week,
      validFrom: t.validFrom,
      validUntil: t.validUntil,
      fixed: t.fixed,
    })
    .from(t)
    .innerJoin(groups, eq(groups.id, t.groupId))
    .innerJoin(subjects, eq(subjects.id, t.subjectId))
    .leftJoin(users, eq(users.id, t.teacherId))
    .where(overlapWhere(source, validFrom, validUntil));
  return rows;
}

export interface OpenAssignment extends Assignment {
  /** im Band: das am wenigsten verplante Mitglied (die Setzhilfe setzt das Band als Einheit) */
  planned: number;
  open: number;
  /** SP2-02: Band des Lehrauftrags mit allen Mitgliedern (mit Gruppe), in der Reihenfolge der Verteilung */
  band?: { id: string; name: string; members: Assignment[] };
}

/**
 * Lehraufträge der Gruppe im Planungsjahr mit noch offenen Wochenstunden (Stichtag heute). Ein Lehrauftrag im Band ist offen,
 * solange das Band offen ist (schwächstes Mitglied) – gesetzt wird dann das ganze Band. SP3-09a: im Entwurf die Lehraufträge seines
 * Schuljahrs (auch im Folgejahr).
 */
export async function openAssignments(db: Db, groupId: string, todayYmd: string, source: PlanSource = LIVE): Promise<OpenAssignment[]> {
  const year = await yearOfSource(db, source);
  if (!year) return [];
  const d = await distribution(db, year, todayYmd, { source });
  const byId = new Map(d.assignments.map((a) => [a.id, a]));
  const bandOf = new Map(d.bands.map((b) => [b.id, b]));
  const out: OpenAssignment[] = [];
  for (const a of d.assignments) {
    if (!a.groups.some((g) => g.id === groupId)) continue;
    const b = a.bandId ? bandOf.get(a.bandId) : undefined;
    if (b) {
      if (b.planned >= b.hours) continue;
      const members = b.memberIds.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => Boolean(m) && m!.groups.length > 0);
      out.push({ ...a, planned: b.planned, open: b.hours - b.planned, band: { id: b.id, name: b.name, members } });
    } else if (a.planned < a.hours) out.push({ ...a, open: a.hours - a.planned });
  }
  return out;
}

/** Teile, die ein Lehrauftrag beim Setzen erzeugt: jede Gruppe × jede Lehrkraft (Teamteaching), sein Fach, ein Raum. */
export function assignmentRows(a: Pick<Assignment, "groups" | "teachers" | "subjectId">, roomId: string | null, validity: { validFrom: string; validUntil: string | null }): UnitRow[] {
  const teachers = a.teachers.length ? a.teachers.map((t) => t.id) : [null];
  return a.groups.flatMap((g) => teachers.map((teacherId) => ({ groupId: g.id, subjectId: a.subjectId, teacherId, roomId, week: "all" as const, ...validity })));
}

export interface Placement {
  rows: UnitRow[];
  /** SP3-02: Lehrauftrag je Zeile (Reihenfolge wie `rows`) – im Entwurf als Herkunft der gesetzten Stunde */
  rowAssignments: string[];
  validity: { validFrom: string; validUntil: string | null };
  lessons: GridLesson[];
  rooms: { id: string; kind: string; active: boolean }[];
  blocked: (weekday: number, periodNr: number) => string[];
  dayLimits: DayLimits;
  teacherLimits: TeacherLimits;
}

/** Gesperrte Zeiten aller Beteiligten (Lehrkräfte, Gruppen, Räume, Fach) als Slot-Prüfung. */
async function prefBlocker(db: Db, targets: { kind: "teacher" | "group" | "room" | "subject"; id: string | null; label: string }[]) {
  const prefs = await allPrefs(db);
  return (weekday: number, periodNr: number) => blockedReasons(prefs, targets, weekday, periodNr);
}

/** Wunsch-Ziele von Stunden: Lehrkraft, Gruppe, Raum, Fach je Stunde. */
export function lessonPrefTargets(ls: GridLesson[]): { kind: "teacher" | "group" | "room" | "subject"; id: string | null; label: string }[] {
  return [
    ...ls.map((u) => ({ kind: "teacher" as const, id: u.teacherId, label: u.teacherCode ?? "Lehrkraft" })),
    ...ls.map((u) => ({ kind: "group" as const, id: u.groupId, label: u.groupName })),
    ...ls.map((u) => ({ kind: "room" as const, id: u.roomId, label: `Raum ${u.roomId}` })),
    ...ls.map((u) => ({ kind: "subject" as const, id: u.subjectId, label: u.subjectName })),
  ];
}

/** Alles, was das Freiraster zum Setzen eines Lehrauftrags braucht – im Band (SP2-02) für alle Mitglieder, mit Raumvorschlag je Teil. */
/** SP2-09 (rein): Zeitraum der Stunde ∩ Gültigkeit des Lehrauftrags. */
export function clipValidity(
  v: { validFrom: string; validUntil: string | null },
  a: { validFrom?: string | null; validUntil?: string | null },
): { validFrom: string; validUntil: string | null } {
  const validFrom = a.validFrom && a.validFrom > v.validFrom ? a.validFrom : v.validFrom;
  const validUntil = a.validUntil && (v.validUntil === null || a.validUntil < v.validUntil) ? a.validUntil : v.validUntil;
  return { validFrom, validUntil };
}

export async function assignmentPlacement(db: Db, a: Assignment & Pick<OpenAssignment, "band">, todayYmd: string, from?: string, source: PlanSource = LIVE): Promise<Placement> {
  const members = a.band?.members.length ? a.band.members : [a];
  const groupIds = unique(members.flatMap((m) => m.groups.map((g) => g.id)));
  const [validity, roomList, subjectRows, groupRows] = await Promise.all([
    defaultValidity(db, todayYmd, from),
    db.select({ id: rooms.id, kind: rooms.kind, active: rooms.active }).from(rooms).orderBy(rooms.id),
    db.select({ id: subjects.id, roomKind: subjects.roomKind }).from(subjects).where(inArray(subjects.id, unique(members.map((m) => m.subjectId)))),
    groupIds.length ? db.select({ id: groups.id, homeRoomId: groups.homeRoomId }).from(groups).where(inArray(groups.id, groupIds)) : Promise.resolve([]),
  ]);
  const roomFor = (m: Assignment) =>
    m.roomId ?? suggestRoom(subjectRows.find((s) => s.id === m.subjectId), groupRows.find((g) => g.id === m.groups[0]?.id)?.homeRoomId ?? null, roomList);
  // SP2-09: jede Stunde gilt höchstens so lange wie ihr Lehrauftrag (Band-Mitglieder je eigene Gültigkeit)
  const rows = members.flatMap((m) => assignmentRows(m, roomFor(m), clipValidity(validity, m)));
  const rowAssignments = members.flatMap((m) => assignmentRows(m, null, validity).map(() => m.id));
  const targets = new Map<string, { kind: "teacher" | "group" | "room" | "subject"; id: string | null; label: string }>();
  const target = (kind: "teacher" | "group" | "room" | "subject", id: string | null, label: string) => {
    if (id) targets.set(`${kind}:${id}`, { kind, id, label });
  };
  for (const m of members) {
    for (const t of m.teachers) target("teacher", t.id, t.code ?? t.name);
    for (const g of m.groups) target("group", g.id, g.name);
    target("subject", m.subjectId, m.subjectName);
  }
  for (const r of rows) target("room", r.roomId, `Raum ${r.roomId}`);
  const blocked = await prefBlocker(db, [...targets.values()]);
  return {
    rows,
    rowAssignments,
    validity,
    lessons: await gridLessons(db, validity.validFrom, validity.validUntil, source),
    rooms: roomList,
    blocked,
    dayLimits: await loadDayLimits(db),
    teacherLimits: await loadTeacherLimits(db, (await yearOfSource(db, source))?.id),
  };
}

const slotName = (weekday: number, periodNr: number) => `${["Mo", "Di", "Mi", "Do", "Fr"][weekday]} ${periodNr}. Stunde`;

/** Setzt eine Stunde eines Lehrauftrags in den Slot – bei mehreren Lehrkräften oder im Band (alle Mitglieder) als Kopplung. */
export async function placeAssignment(
  db: Db,
  actorId: string,
  assignmentId: string,
  groupId: string,
  weekday: number,
  periodNr: number,
  todayYmd: string,
  from?: string,
  source: PlanSource = LIVE,
  opts: LiveOptions = {},
): Promise<void> {
  await requireWritable(db, source);
  const a = (await openAssignments(db, groupId, from ?? todayYmd, source)).find((x) => x.id === assignmentId);
  if (!a) throw new ValidationError({ assignment: "Für diesen Lehrauftrag ist keine Stunde mehr offen" });
  const pl = await assignmentPlacement(db, a, todayYmd, from, source);
  const cell = placementCell({ ...pl, unitIds: [], weekdays: [weekday], periods: [periodNr] }, weekday, periodNr);
  if (cell.state !== "free") throw new ValidationError({ slot: `${slotName(weekday, periodNr)}: ${cell.state === "blocked" ? cell.reasons.join(", ") : "belegt"}` });
  // SP2-09: Gültigkeit des Lehrauftrags; Kopplungen haben eine gemeinsame – weichen Band-Mitglieder ab, gilt der Zeitraum der Setzhilfe
  const r0 = pl.rows[0]!;
  const same = pl.rows.every((r) => r.validFrom === r0.validFrom && r.validUntil === r0.validUntil);
  const slot = { weekday, periodNr, week: "all" as const, ...(same ? { validFrom: r0.validFrom, validUntil: r0.validUntil } : pl.validity) };
  if (pl.rows.length === 1) {
    const r = pl.rows[0]!;
    await createLesson(db, actorId, { ...slot, groupId: r.groupId, subjectId: r.subjectId, teacherId: r.teacherId, roomId: cell.rooms[0]!, assignmentId: pl.rowAssignments[0] ?? null }, source, opts);
  } else {
    await saveCoupling(
      db,
      actorId,
      null,
      { ...slot, parts: pl.rows.map((r, i) => ({ groupId: r.groupId, subjectId: r.subjectId, teacherId: r.teacherId, roomId: cell.rooms[i]!, assignmentId: pl.rowAssignments[i] ?? null })) },
      source,
      opts,
    );
  }
}

export interface MoveUnit {
  lessons: GridLesson[];
  /** Teile der Einheit (Einzelstunde oder alle Teile der Kopplung) */
  unit: GridLesson[];
  rooms: { id: string; kind: string; active: boolean }[];
  blocked: (weekday: number, periodNr: number) => string[];
  /** SP2-05: gesperrte Zeiten anderer Stunden (Tausch-Partner) */
  blockedFor?: (lessons: GridLesson[], weekday: number, periodNr: number) => string[];
  dayLimits?: DayLimits;
  teacherLimits?: TeacherLimits;
}

/** Die Stunde (bzw. ihre Kopplung) und alle Stunden der Quelle, die sich mit ihrer Gültigkeit überschneiden. */
export async function movePlacement(db: Db, lessonId: string, source: PlanSource = LIVE): Promise<MoveUnit | null> {
  const t = lessonCols(source);
  const [l] = await db.select({ id: t.id, couplingId: t.couplingId, validFrom: t.validFrom, validUntil: t.validUntil }).from(t).where(idWhere(source, lessonId));
  if (!l) return null;
  const [lessons, roomList] = await Promise.all([
    gridLessons(db, l.validFrom, l.validUntil, source),
    db.select({ id: rooms.id, kind: rooms.kind, active: rooms.active }).from(rooms).orderBy(rooms.id),
  ]);
  const unit = lessons.filter((x) => (l.couplingId ? x.couplingId === l.couplingId : x.id === l.id));
  const prefs = await allPrefs(db);
  const targets = lessonPrefTargets(unit);
  const blocked = (weekday: number, periodNr: number) => blockedReasons(prefs, targets, weekday, periodNr);
  const blockedFor = (ls: GridLesson[], weekday: number, periodNr: number) => unique(blockedReasons(prefs, lessonPrefTargets(ls), weekday, periodNr));
  return { lessons, unit, rooms: roomList, blocked, blockedFor, dayLimits: await loadDayLimits(db), teacherLimits: await loadTeacherLimits(db, (await yearOfSource(db, source))?.id) };
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
    blockedFor: m.blockedFor,
    dayLimits: m.dayLimits,
    teacherLimits: m.teacherLimits,
  };
}

/**
 * Verschiebt eine Stunde/Kopplung in einen freien Slot oder tauscht sie mit der Stunde der Gruppe dort. SP3-05: im gültigen Plan als
 * Sofort-Korrektur (laufende Stunden ab dem nächsten Schultag, beim Tauschen beide Einheiten in einer Aktion).
 */
export async function moveLesson(db: Db, actorId: string, lessonId: string, groupId: string, weekday: number, periodNr: number, source: PlanSource = LIVE, opts: LiveOptions = {}): Promise<"moved" | "swapped"> {
  await requireWritable(db, source);
  const m = await movePlacement(db, lessonId, source);
  if (!m || !m.unit.length) throw new ValidationError({ id: "Stunde gibt es nicht mehr" });
  const cell = placementCell(moveGridInput(m, groupId, [weekday], [periodNr]), weekday, periodNr);
  const first = m.unit[0]!;
  if (cell.state === "current") return "moved";
  if (cell.state === "blocked") throw new ValidationError({ slot: `${slotName(weekday, periodNr)}: ${cell.reasons.join(", ")}` });
  if (cell.state === "free") {
    const slot = { weekday, periodNr, week: first.week, validFrom: first.validFrom, validUntil: first.validUntil };
    if (!first.couplingId) {
      await updateLesson(db, actorId, first.id, { ...slot, groupId: first.groupId, subjectId: first.subjectId, teacherId: first.teacherId, roomId: cell.rooms[0]! }, source, opts);
    } else {
      await saveCoupling(
        db,
        actorId,
        first.couplingId,
        {
          ...slot,
          parts: m.unit.map((u, i) => ({ id: u.id, groupId: u.groupId, subjectId: u.subjectId, teacherId: u.teacherId, roomId: cell.rooms[i]! })),
        },
        source,
        opts,
      );
    }
    return "moved";
  }
  // Tauschen: beide Einheiten wechseln den Slot, Räume bleiben
  const partner = m.lessons.find((l) => l.id === cell.partnerIds[0])!;
  if (source.kind === "live") {
    const rows = await db.select().from(timetableLessons).where(inArray(timetableLessons.id, [...m.unit.map((u) => u.id), ...cell.partnerIds]));
    const unitRows = rows.filter((r) => m.unit.some((u) => u.id === r.id));
    const partnerRows = rows.filter((r) => cell.partnerIds.includes(r.id));
    const at = (rs: typeof rows, d: number, p: number) => rs.map((r) => ({ ...afterOf(r), weekday: d, periodNr: p }));
    let a = await liveUnitPlan(db, unitRows, at(unitRows, weekday, periodNr), Boolean(first.couplingId), opts);
    let b = await liveUnitPlan(db, partnerRows, at(partnerRows, first.weekday, first.periodNr), Boolean(partner.couplingId), opts);
    // beide Einheiten zum selben Zeitpunkt: läuft eine schon, werden beide ab dem Stichtag geteilt (sonst lägen bis dahin zwei Stunden im Slot)
    if (a.plan.mode !== b.plan.mode) {
      a = await liveUnitPlan(db, unitRows, at(unitRows, weekday, periodNr), Boolean(first.couplingId), opts, true);
      b = await liveUnitPlan(db, partnerRows, at(partnerRows, first.weekday, first.periodNr), Boolean(partner.couplingId), opts, true);
    }
    await applyLiveUnits(db, actorId, [a.plan, b.plan], { ...opts, today: a.today });
  } else
    await db.transaction(async (tx) => {
      const t = lessonCols(source);
      for (const u of m.unit) await tx.update(t).set({ weekday, periodNr }).where(idWhere(source, u.id));
      for (const id of cell.partnerIds) await tx.update(t).set({ weekday: first.weekday, periodNr: first.periodNr }).where(idWhere(source, id));
    });
  await audit(db, actorId, source.kind === "draft" ? "stundenplan.draft.lesson.swap" : "stundenplan.lesson.swap", groupId, {
    ...(source.kind === "draft" ? { draft: source.versionId } : {}),
    lesson: first.id,
    with: partner.id,
    from: slotName(first.weekday, first.periodNr),
    to: slotName(weekday, periodNr),
  });
  return "swapped";
}
