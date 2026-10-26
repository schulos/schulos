// Vertretungen: Entfall, Vertretung durch andere Lehrkraft, Raumänderung – je Stunde und Tag.
import { and, asc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { bookingResources, bookings, exams, groupMembers, groups, periods, rooms, subjects, timetableLessons, timetableSubstitutionDays, timetableSubstitutions, users } from "@/core/db/schema";
import { OPEN_CALENDAR, dayOffLabel, dayOffOn, type SchoolCalendar } from "@/core/school/calendar";
import { addDays, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { SUBSTITUTION_KINDS, type SubstitutionKind, type TimetableLesson, type TimetableSubstitution } from "./schema";
import { groupPeriod, ownTeacherPeriod, roomUse, takesPlaceAsUsual } from "./belegung";
import { dayRuleBlocks } from "./vertretung-regeln";
import { mergeHosts, type MergeTarget } from "./vertretung-ziel";
import { absencesBetween, absentGroups, absentTeachers } from "./abwesenheit";
import { blockLabel, roomBlockAt } from "./raumsperren";
import { lessonActiveOn } from "./service";
import { dayChanges, notifySubstitutionDay } from "./vertretung-gong";
import { draftDays, startDraftIfNeeded } from "./freigabe";

type ExamKind = (typeof exams.$inferSelect)["kind"];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Art einer vorhandenen Änderung in Meldungen („… ist schon eine Vertretung eingetragen“). */
const CHANGE_WORD: Record<SubstitutionKind, string> = { cancel: "Entfall", substitute: "Vertretung", room: "Raumänderung", move: "Verlegung", merge: "Zusammenlegung" };

export interface SubstitutionInput {
  lessonId: string;
  date: string;
  kind: (typeof SUBSTITUTION_KINDS)[number];
  substituteId: string | null;
  roomId: string | null;
  note: string | null;
  /** SP-12 (Fachtausch): abweichendes Fach, nur bei `substitute`; leer bzw. gleiches Fach wie die Stunde = reguläres Fach */
  subjectId?: string | null;
  /** SP2-07 (Verlegung): Stunde desselben Tages, in die verlegt wird */
  targetPeriod?: number | null;
  /** SP2-07 (Verlegung): Unterricht der Gruppe aus der Zielstunde rückt in diese Stunde (Tausch) */
  swap?: boolean;
  /** SP2-07 (Zusammenlegung): Stunde zur selben Zeit, zu der die Gruppe geht */
  mergeLessonId?: string | null;
}

type DayRow = { l: TimetableLesson; s: TimetableSubstitution | undefined };
type DayLoader = (date: string, weekday: number) => Promise<DayRow[]>;

/** Stunden des Wochentags, die an `date` gelten, mit ihrer Änderung an dem Tag (SP2-07: auch verlegte in andere Stunden). */
async function dayLessons(db: Db, date: string, weekday: number): Promise<DayRow[]> {
  const own = (await db.select().from(timetableLessons).where(eq(timetableLessons.weekday, weekday))).filter((l) => lessonActiveOn(l, date));
  const subs = own.length
    ? await db
        .select()
        .from(timetableSubstitutions)
        .where(and(eq(timetableSubstitutions.date, date), inArray(timetableSubstitutions.lessonId, own.map((l) => l.id))))
    : [];
  const subOf = new Map(subs.map((s) => [s.lessonId, s]));
  return own.map((l) => ({ l, s: subOf.get(l.id) }));
}

/**
 * R1b/A13: `dayLessons` je (Datum, Wochentag) nur einmal laden – innerhalb einer Prüfung (z. B. Verlegung mit Tausch) ändert sich
 * nichts, geschrieben wird erst danach. Nie über Schreibvorgänge hinweg weiterverwenden.
 */
function dayCache(db: Db): DayLoader {
  const memo = new Map<string, Promise<DayRow[]>>();
  return (date, weekday) => {
    const key = `${date}:${weekday}`;
    let p = memo.get(key);
    if (!p) {
      p = dayLessons(db, date, weekday);
      memo.set(key, p);
    }
    return p;
  };
}

/**
 * Wer ist zu dieser Stunde wirklich beschäftigt? Eigene Stunden (sofern nicht entfallen/abgegeben/zusammengelegt, verlegte in
 * ihrer neuen Stunde) + übernommene Vertretungen. Stunden in `except` zählen nicht.
 */
async function busyTeachers(db: Db, date: string, weekday: number, periodNr: number, except: string[] = [], load: DayLoader = dayCache(db)): Promise<Set<string>> {
  const day = await load(date, weekday);
  // Abwesenheiten (P2b-18): abwesende Lehrkräfte stehen nicht zur Verfügung; fehlt die Gruppe, ist ihre Lehrkraft frei
  const absences = await absencesBetween(db, date, date);
  const goneGroups = absentGroups(absences, date, periodNr);
  const busy = absentTeachers(absences, date, periodNr);
  for (const { l, s } of day) {
    if (except.includes(l.id)) continue;
    if (l.teacherId && ownTeacherPeriod(l, s) === periodNr && !goneGroups.has(l.groupId)) busy.add(l.teacherId);
    if (s?.kind === "substitute" && s.substituteId && l.periodNr === periodNr) busy.add(s.substituteId);
  }
  return busy;
}

/** Ist der Raum zu dieser Stunde belegt (reguläre Stunden, die dort bleiben, hierher verlegte und gebuchte)? */
async function busyRooms(db: Db, date: string, weekday: number, periodNr: number, except: string[], load: DayLoader = dayCache(db)): Promise<Set<string>> {
  const busy = new Set<string>();
  for (const { l, s } of await load(date, weekday)) {
    if (except.includes(l.id)) continue;
    const use = roomUse(l, s);
    if (use?.periodNr === periodNr) busy.add(use.roomId);
  }
  // gebuchte Räume (Modul Buchungen) sind ebenfalls belegt
  const booked = await db
    .select({ roomId: bookingResources.roomId })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .where(and(eq(bookings.date, date), eq(bookings.periodNr, periodNr)));
  for (const b of booked) if (b.roomId) busy.add(b.roomId);
  return busy;
}

/** SP2-07: Gruppen, die zu dieser Stunde Unterricht haben (verlegte in ihrer neuen Stunde, zusammengelegte bei der anderen Stunde). */
async function busyGroups(db: Db, date: string, weekday: number, periodNr: number, except: string[], load: DayLoader = dayCache(db)): Promise<Set<string>> {
  const busy = new Set<string>();
  for (const { l, s } of await load(date, weekday)) if (!except.includes(l.id) && groupPeriod(l, s) === periodNr) busy.add(l.groupId);
  return busy;
}

/** Welcher Unterricht belegt diesen Raum zu dieser Stunde (Vertretungen/Verlegungen berücksichtigt)? Für Buchungen. */
export async function roomLessonAt(db: Db, roomId: string, date: string, periodNr: number): Promise<{ groupName: string; subjectName: string } | null> {
  const weekday = weekdayMon0(date);
  if (weekday > 4 || (await dayOffOn(db, date))) return null;
  // SP2-07: auch eine hierher verlegte Stunde belegt den Raum; zusammengelegte Gruppen sitzen im Raum der anderen Stunde
  const hit = (await dayLessons(db, date, weekday)).find(({ l, s }) => {
    const use = roomUse(l, s);
    return use?.periodNr === periodNr && use.roomId === roomId;
  });
  if (!hit) return null;
  const [r] = await db
    .select({ groupName: groups.name, subjectName: subjects.name })
    .from(groups)
    .innerJoin(subjects, eq(subjects.id, hit.l.subjectId))
    .where(eq(groups.id, hit.l.groupId));
  return r ?? null;
}

/**
 * Teile derselben Kopplung bei derselben Lehrkraft (Religion für 7a und 7b bei RIC), die an `date` stattfinden –
 * eine Vertretung, ein Entfall oder eine Raumänderung gilt für alle zusammen.
 */
export async function couplingSiblings(db: Db, l: TimetableLesson, date: string): Promise<TimetableLesson[]> {
  if (!l.couplingId || !l.teacherId) return [];
  const rows = await db
    .select()
    .from(timetableLessons)
    .where(and(eq(timetableLessons.couplingId, l.couplingId), eq(timetableLessons.teacherId, l.teacherId)));
  return rows.filter((r) => r.id !== l.id && lessonActiveOn(r, date));
}

/** Lehrkräfte mit Angabe, ob sie zu dieser Stunde frei sind (für die Auswahl „Vertretung durch“). */
export async function teacherAvailability(db: Db, lessonId: string, date: string) {
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, lessonId));
  if (!l) return [];
  const busy = await busyTeachers(db, date, l.weekday, l.periodNr, [lessonId, ...(await couplingSiblings(db, l, date)).map((x) => x.id)]);
  const all = await db.select({ id: users.id, name: users.name, code: users.shortCode }).from(users).where(eq(users.role, "lehrkraft")).orderBy(asc(users.shortCode));
  return all.filter((t) => t.id !== l.teacherId).map((t) => ({ ...t, free: !busy.has(t.id) }));
}

/**
 * SP2-07: alle Teile derselben Kopplung, die an `date` stattfinden – auch mit anderer Lehrkraft (Band-Stunde, SP2-02: eine
 * `coupling_id` je Band-Stunde). Eine Verlegung bewegt immer die ganze Kopplung.
 */
export async function couplingParts(db: Db, l: TimetableLesson, date: string): Promise<TimetableLesson[]> {
  if (!l.couplingId) return [];
  const rows = await db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, l.couplingId));
  return rows.filter((r) => r.id !== l.id && lessonActiveOn(r, date));
}

/** Kürzel bzw. Name einer Lehrkraft für Meldungen. */
async function teacherLabel(db: Db, id: string): Promise<string> {
  const [t] = await db.select({ code: users.shortCode, name: users.name }).from(users).where(eq(users.id, id));
  return t?.code ?? t?.name ?? "Lehrkraft";
}

/** Gruppen-Namen für Meldungen. */
async function groupNames(db: Db, ids: readonly string[]): Promise<string> {
  if (ids.length === 0) return "";
  const rows = await db.select({ name: groups.name }).from(groups).where(inArray(groups.id, [...ids]));
  return rows.map((r) => r.name).join(", ");
}

/** SP2-07: Stunden, die an `date` in Stunde `periodNr` zu einer der Gruppen verlegt sind (außer `except`). */
async function movedInto(db: Db, date: string, weekday: number, periodNr: number, groupIds: readonly string[], except: readonly string[], load: DayLoader = dayCache(db)): Promise<TimetableLesson[]> {
  return (await load(date, weekday))
    .filter(({ l, s }) => s?.kind === "move" && s.targetPeriod === periodNr && groupIds.includes(l.groupId) && !except.includes(l.id))
    .map(({ l }) => l);
}

/**
 * SP2-07: Kann der Block `unit` (Stunden einer Kopplung) an `date` in Stunde `periodNr` liegen? Gruppen, Lehrkräfte und Räume
 * müssen dort frei sein (Stunden in `except` zählen nicht – beim Tausch die getauschten). Gibt den ersten Grund zurück.
 * R1b/A3: `roomOf` = Raum je Teil in der Zielstunde (ein anderer Raum gilt nicht für alle Teile eines Bands).
 */
async function slotProblems(
  db: Db,
  date: string,
  unit: TimetableLesson[],
  periodNr: number,
  roomOf: (u: TimetableLesson) => string | null,
  except: string[],
  load: DayLoader,
): Promise<string | null> {
  const weekday = unit[0]!.weekday;
  const groupsBusy = await busyGroups(db, date, weekday, periodNr, except, load);
  const clash = [...new Set(unit.map((u) => u.groupId))].filter((g) => groupsBusy.has(g));
  if (clash.length) return `${await groupNames(db, clash)} hat in der ${periodNr}. Stunde Unterricht`;
  const teachersBusy = await busyTeachers(db, date, weekday, periodNr, except, load);
  for (const t of new Set(unit.map((u) => u.teacherId).filter((x): x is string => !!x)))
    if (teachersBusy.has(t)) return `${await teacherLabel(db, t)} ist in der ${periodNr}. Stunde nicht frei`;
  const roomsBusy = await busyRooms(db, date, weekday, periodNr, except, load);
  for (const room of new Set(unit.map(roomOf).filter((x): x is string => !!x))) {
    if (roomsBusy.has(room)) return `Raum ${room} ist in der ${periodNr}. Stunde belegt`;
    const blk = await roomBlockAt(db, room, date, periodNr);
    if (blk) return `Raum ${room}: ${blockLabel(blk)}`;
  }
  return null;
}

/**
 * SP2-07: Stunden zur selben Zeit, zu denen die Gruppe zusammengelegt werden kann (andere Gruppe, findet wie geplant statt,
 * hat eine Lehrkraft, die nicht abwesend ist) – für die Auswahl „Zusammenlegen mit“.
 */
export async function mergeOptions(db: Db, lessonId: string, date: string): Promise<{ lessonId: string; label: string }[]> {
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, lessonId));
  if (!l || !lessonActiveOn(l, date)) return [];
  const unit = [l, ...(await couplingSiblings(db, l, date))];
  const unitGroups = new Set(unit.map((x) => x.groupId));
  const absent = absentTeachers(await absencesBetween(db, date, date), date, l.periodNr);
  const candidates = (await dayLessons(db, date, l.weekday)).filter(
    ({ l: x, s }) => x.periodNr === l.periodNr && !unitGroups.has(x.groupId) && takesPlaceAsUsual(s) && !!(s?.kind === "substitute" ? s.substituteId : x.teacherId),
  );
  if (candidates.length === 0) return [];
  const teacher = alias(users, "teacher");
  const info = await db
    .select({ id: timetableLessons.id, groupName: groups.name, subjectName: subjects.name, teacherCode: teacher.shortCode })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(teacher, eq(teacher.id, timetableLessons.teacherId))
    .where(inArray(timetableLessons.id, candidates.map((c) => c.l.id)));
  const codes = new Map((await db.select({ id: users.id, code: users.shortCode }).from(users).where(eq(users.role, "lehrkraft"))).map((u) => [u.id, u.code]));
  return candidates
    .flatMap(({ l: x, s }) => {
      const who = s?.kind === "substitute" ? s.substituteId! : x.teacherId!;
      if (absent.has(who)) return [];
      const i = info.find((r) => r.id === x.id)!;
      const room = s?.roomId ?? x.roomId;
      return [{ lessonId: x.id, label: [i.groupName, i.subjectName, codes.get(who) ?? i.teacherCode, room && `R ${room}`].filter(Boolean).join(" · ") }];
    })
    .sort((a, b) => a.label.localeCompare(b.label, "de", { numeric: true }));
}

export async function saveSubstitution(db: Db, actorId: string, input: SubstitutionInput): Promise<string> {
  const fe: Record<string, string> = {};
  if (!YMD.test(input.date)) fe.date = "Datum angeben";
  if (!SUBSTITUTION_KINDS.includes(input.kind)) fe.kind = "Art wählen";
  const [lesson] = await db
    .select({ l: timetableLessons, subjectName: subjects.name, groupName: groups.name })
    .from(timetableLessons)
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .where(eq(timetableLessons.id, input.lessonId));
  if (!lesson) fe.lessonId = "Stunde gibt es nicht";
  else if (YMD.test(input.date) && !lessonActiveOn(lesson.l, input.date)) fe.date = "An diesem Tag findet die Stunde nicht statt";
  else if (YMD.test(input.date)) {
    const off = await dayOffOn(db, input.date);
    if (off) fe.date = `Kein Unterricht: ${dayOffLabel(off)}`;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const l = lesson!.l;
  // SP2-07: eine Verlegung bewegt die ganze Kopplung (Band-Stunde mit allen Lehrkräften), alles andere gilt für die Teile derselben Lehrkraft
  const siblings = input.kind === "move" ? await couplingParts(db, l, input.date) : await couplingSiblings(db, l, input.date);
  const all = [l, ...siblings];
  const except = all.map((x) => x.id);
  const unitGroups = [...new Set(all.map((x) => x.groupId))];
  const load = dayCache(db);

  const sub = {
    ...input,
    note: input.note?.trim() || null,
    subjectId: input.subjectId || null,
    targetPeriod: input.kind === "move" ? (input.targetPeriod ?? null) : null,
    mergeLessonId: input.kind === "merge" ? input.mergeLessonId || null : null,
  };
  // SP-12: ein anderes Fach gibt es nur bei einer Vertretung; das reguläre Fach wird nicht gespeichert
  if (sub.kind !== "substitute" || sub.subjectId === l.subjectId) sub.subjectId = null;
  let subjectName: string | null = null;
  if (sub.subjectId) {
    const [subj] = await db.select({ name: subjects.name }).from(subjects).where(eq(subjects.id, sub.subjectId));
    if (!subj) fe.subjectId = "Fach gibt es nicht";
    else subjectName = subj.name;
  }
  if (sub.kind === "cancel" || sub.kind === "merge") {
    sub.substituteId = null;
    sub.roomId = null;
  }
  if (sub.kind === "room" || sub.kind === "move") sub.substituteId = null;
  if (sub.kind === "move" && sub.roomId === l.roomId) sub.roomId = null;
  // R1b/A3: ein anderer Raum bei der Verlegung gilt für die Teile im Raum der bearbeiteten Stunde (dieselbe Lehrkraft bzw.
  // Teamteaching); die übrigen Teile eines Bands behalten ihren Raum
  const movesRoom = (x: TimetableLesson) => sub.kind === "move" && !!sub.roomId && x.roomId === l.roomId;
  const roomInTarget = (x: TimetableLesson) => (movesRoom(x) ? sub.roomId : x.roomId);
  const weekday = l.weekday;
  if (sub.kind === "substitute") {
    if (!sub.substituteId) fe.substituteId = "Vertretungslehrkraft wählen";
    else {
      const [t] = await db.select({ role: users.role }).from(users).where(eq(users.id, sub.substituteId));
      if (t?.role !== "lehrkraft") fe.substituteId = "Vertretungslehrkraft wählen";
      else if (sub.substituteId === l.teacherId) fe.substituteId = "Das ist die eigene Lehrkraft der Stunde";
      else if (absentTeachers(await absencesBetween(db, sub.date, sub.date), sub.date, l.periodNr).has(sub.substituteId)) fe.substituteId = "Die Lehrkraft ist zu dieser Zeit abwesend";
      else if ((await busyTeachers(db, sub.date, weekday, l.periodNr, except, load)).has(sub.substituteId)) fe.substituteId = "Die Lehrkraft unterrichtet zu dieser Zeit selbst";
      else {
        // SP2-07: Tagesregel der Vertretung (SP2-04) – gezählt die Stunden, die sie an dem Tag tatsächlich hält
        const substituteId = sub.substituteId;
        const held = (await load(sub.date, weekday))
          .filter(({ l: x }) => !except.includes(x.id))
          .flatMap(({ l: x, s }) => [x.teacherId === substituteId ? ownTeacherPeriod(x, s) : null, s?.kind === "substitute" && s.substituteId === substituteId ? x.periodNr : null])
          .filter((p): p is number => p !== null);
        const rule = (await dayRuleBlocks(db, sub.date, l.periodNr, [substituteId], new Map([[substituteId, held]]))).get(substituteId);
        if (rule) fe.substituteId = `Die Lehrkraft hat eine ${rule}`;
      }
    }
  }
  // SP2-07 Verlegung: Stunde desselben Tages; beim Tausch rückt der Unterricht der Gruppe aus der Zielstunde in diese Stunde
  let swapped: TimetableLesson[] = [];
  if (sub.kind === "move") {
    const target = sub.targetPeriod;
    const [p] = target !== null && Number.isInteger(target) ? await db.select({ nr: periods.nr }).from(periods).where(eq(periods.nr, target)) : [];
    if (!p || target === null) fe.targetPeriod = "Stunde wählen, in die verlegt wird";
    else if (target === l.periodNr) fe.targetPeriod = "Das ist die eigene Stunde";
    else {
      if (input.swap) {
        const day = await load(sub.date, weekday);
        const subOf = new Map(day.map(({ l: x, s }) => [x.id, s]));
        // Unterricht der Gruppe in der Zielstunde (dorthin verlegten prüft unten die Belegung, von dort weg verlegter zählt nicht)
        const inTarget = day.filter(({ l: x, s }) => x.periodNr === target && unitGroups.includes(x.groupId) && !except.includes(x.id) && s?.kind !== "move");
        // R1b/A4: getauscht wird nur Unterricht ohne Änderung – ein Entfall käme sonst zurück, eine Vertretung verlöre still ihre Lehrkraft
        swapped = inTarget.filter(({ s }) => !s).map(({ l: x }) => x);
        // auch deren Kopplungsteile wandern mit
        for (const x of [...swapped]) for (const y of await couplingParts(db, x, sub.date)) if (!swapped.some((z) => z.id === y.id)) swapped.push(y);
        const changed = swapped.map((x) => subOf.get(x.id)).find((s) => !!s) ?? inTarget.find(({ s }) => s && s.kind !== "cancel")?.s;
        if (changed) fe.targetPeriod = `In der ${target}. Stunde ist schon eine ${CHANGE_WORD[changed.kind]} eingetragen – erst aufheben, dann tauschen`;
        else if (swapped.length === 0 && inTarget.length) fe.targetPeriod = `In der ${target}. Stunde entfällt der Unterricht der Gruppe – ohne „Tauschen“ verlegen`;
        else if (swapped.length === 0) fe.targetPeriod = `In der ${target}. Stunde hat die Gruppe keinen Unterricht zum Tauschen`;
      }
      if (!fe.targetPeriod) {
        const ignore = [...except, ...swapped.map((x) => x.id)];
        const problem = await slotProblems(db, sub.date, all, target, roomInTarget, ignore, load);
        if (problem) fe.targetPeriod = problem;
        else if (swapped.length) {
          const back = await slotProblems(db, sub.date, swapped, l.periodNr, (x) => x.roomId, ignore, load);
          if (back) fe.targetPeriod = `Tausch: ${back}`;
        }
      }
    }
  }
  // SP2-07 Zusammenlegung: die Gruppe geht zu einer anderen Stunde derselben Zeit, deren Lehrkraft mitbetreut
  let hostTeacher: string | null = null;
  if (sub.kind === "merge") {
    const [h] = sub.mergeLessonId ? await db.select().from(timetableLessons).where(eq(timetableLessons.id, sub.mergeLessonId)) : [];
    if (!h || !lessonActiveOn(h, sub.date) || h.periodNr !== l.periodNr || except.includes(h.id)) fe.mergeLessonId = "Stunde zur selben Zeit wählen";
    else if (unitGroups.includes(h.groupId)) fe.mergeLessonId = "Das ist dieselbe Gruppe";
    else {
      const [hs] = await db
        .select()
        .from(timetableSubstitutions)
        .where(and(eq(timetableSubstitutions.lessonId, h.id), eq(timetableSubstitutions.date, sub.date)));
      if (!takesPlaceAsUsual(hs)) fe.mergeLessonId = "Diese Stunde findet an dem Tag nicht wie geplant statt";
      else {
        const teacherId = hs?.kind === "substitute" ? hs.substituteId : h.teacherId;
        if (!teacherId) fe.mergeLessonId = "Die Stunde hat keine Lehrkraft, die mitbetreuen kann";
        else if (absentTeachers(await absencesBetween(db, sub.date, sub.date), sub.date, l.periodNr).has(teacherId)) fe.mergeLessonId = "Die Lehrkraft dieser Stunde ist abwesend";
        else hostTeacher = teacherId;
      }
    }
  }
  if (sub.kind === "room" && !sub.roomId) fe.roomId = "Neuen Raum wählen";
  if (sub.roomId && sub.kind !== "cancel" && sub.kind !== "merge") {
    const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, sub.roomId));
    if (!r) fe.roomId = "Raum gibt es nicht";
    else if (sub.kind === "move") {
      // Verlegung: Raum geprüft in der Zielstunde (oben); R1b/A3: nicht in den Raum eines anderen Teils, der dort bleibt
      if (all.some((x) => !movesRoom(x) && x.roomId === sub.roomId)) fe.roomId = `Raum ${sub.roomId} nutzt schon ein anderer Teil der Stunde`;
    } else if (sub.roomId === l.roomId) sub.roomId = null;
    else if ((await busyRooms(db, sub.date, weekday, l.periodNr, except, load)).has(sub.roomId)) fe.roomId = `Raum ${sub.roomId} ist zu dieser Zeit belegt`;
    else {
      const blk = await roomBlockAt(db, sub.roomId, sub.date, l.periodNr);
      if (blk) fe.roomId = `Raum ${sub.roomId}: ${blockLabel(blk)}`;
    }
  }
  if (sub.kind === "room" && !sub.roomId && !fe.roomId) fe.roomId = "Der Raum ist derselbe wie sonst";
  // SP2-07: findet die Stunde zu ihrer Zeit statt, darf dort keine andere Stunde der Gruppe hinverlegt sein …
  if (takesPlaceAsUsual(sub) && !fe.kind) {
    const moved = await movedInto(db, sub.date, weekday, l.periodNr, unitGroups, except, load);
    if (moved.length) fe.kind = "In diese Stunde ist schon eine andere Stunde der Gruppe verlegt – erst die Verlegung aufheben";
  }
  // … und findet sie nicht statt, dürfen keine Gruppen zu ihr zusammengelegt sein
  if (!takesPlaceAsUsual(sub) && !fe.kind) {
    const merged = await db
      .select({ groupId: timetableLessons.groupId })
      .from(timetableSubstitutions)
      .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
      .where(and(eq(timetableSubstitutions.date, sub.date), inArray(timetableSubstitutions.mergeLessonId, except)));
    if (merged.length) fe.kind = `${await groupNames(db, merged.map((m) => m.groupId))} ist zu dieser Stunde zusammengelegt – erst die Zusammenlegung aufheben`;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);

  // bisherige Änderung (Vertretung wechselt → die bisherige Vertretung erfährt es auch; Mitbetreuung ebenso)
  const touched = [...except, ...swapped.map((x) => x.id)];
  const previous = await db
    .select({ substituteId: timetableSubstitutions.substituteId, mergeLessonId: timetableSubstitutions.mergeLessonId })
    .from(timetableSubstitutions)
    .where(and(eq(timetableSubstitutions.date, sub.date), inArray(timetableSubstitutions.lessonId, touched)));
  const previousHosts = await hostTeachers(db, sub.date, previous.map((p) => p.mergeLessonId).filter((x): x is string => !!x));
  // gekoppelte Teile derselben Lehrkraft (bei Verlegung alle Teile) bekommen dieselbe Änderung
  const ids: string[] = [];
  // SP2-16b: erneutes Speichern bestätigt die Änderung („Abwesenheit beendet – prüfen“ fällt weg)
  const row = {
    kind: sub.kind,
    substituteId: sub.substituteId,
    roomId: sub.roomId,
    note: sub.note,
    subjectId: sub.subjectId,
    targetPeriod: sub.targetPeriod,
    mergeLessonId: sub.mergeLessonId,
    absenceEndedAt: null,
  };
  await db.transaction(async (tx) => {
    // Q5-11: im Modus „Freigabe“ wird ein neuer Tag zum Entwurf (dann gibt es unten keinen Gong) – in derselben Transaktion
    // wie die Änderung, damit ein gescheitertes Speichern keinen leeren Entwurf hinterlässt (GATE-4f C-11)
    await startDraftIfNeeded(tx as unknown as Db, actorId, sub.date);
    const write = async (lessonId: string, values: typeof row) => {
      const [r] = await tx
        .insert(timetableSubstitutions)
        .values({ ...values, lessonId, date: sub.date, createdBy: actorId })
        .onConflictDoUpdate({
          target: [timetableSubstitutions.lessonId, timetableSubstitutions.date],
          set: { ...values, createdBy: actorId, createdAt: new Date() },
        })
        .returning({ id: timetableSubstitutions.id });
      return r!.id;
    };
    for (const x of all) ids.push(await write(x.id, sub.kind === "move" ? { ...row, roomId: movesRoom(x) ? sub.roomId : null } : row));
    // SP2-07 Tausch: der Unterricht aus der Zielstunde rückt in diese Stunde (Raum wie sonst)
    for (const x of swapped)
      await write(x.id, { kind: "move", substituteId: null, roomId: null, note: sub.note, subjectId: null, targetPeriod: l.periodNr, mergeLessonId: null, absenceEndedAt: null });
  });
  await audit(db, actorId, "stundenplan.substitution.save", l.groupId, {
    lesson: l.id,
    date: sub.date,
    kind: sub.kind,
    coupled: siblings.length || undefined,
    subject: subjectName ? `${subjectName} statt ${lesson!.subjectName}` : undefined,
    target: sub.targetPeriod ?? undefined,
    swapped: swapped.length || undefined,
    merge: sub.mergeLessonId ?? undefined,
  });

  // Gong an alle Betroffenen (Q5-03): eine Nachricht je Person und Tag – Schüler:innen, Lehrkraft, Vertretung (auch die
  // bisherige, wenn sie wechselt), mitbetreuende Lehrkraft, Eltern nach Moduleinstellung
  await notifySubstitutionDay(db, actorId, sub.date, {
    students: await studentsOf(db, [...all, ...swapped].map((x) => x.groupId)),
    teachers: [...all, ...swapped]
      .map((x) => x.teacherId)
      .concat([sub.substituteId, hostTeacher, ...previous.map((p) => p.substituteId), ...previousHosts])
      .filter((x): x is string => !!x),
  });
  return ids[0]!;
}

/** R1b/A10: Zusammenlegung in eine Stunde, die gleich gelöscht wird (vorher ermitteln – danach ist `merge_lesson_id` leer). */
export interface ReleasedMerge {
  date: string;
  groupId: string;
  teacherId: string | null;
  hostTeachers: string[];
}

/** R1b/A10: Zusammenlegungen ab `fromDate` in die Stunden `hostIds` – mit den Betroffenen für die Benachrichtigung. */
export async function mergesInto(db: Db, hostIds: readonly string[], fromDate: string): Promise<ReleasedMerge[]> {
  if (hostIds.length === 0) return [];
  const rows = await db
    .select({ date: timetableSubstitutions.date, host: timetableSubstitutions.mergeLessonId, groupId: timetableLessons.groupId, teacherId: timetableLessons.teacherId })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .where(and(inArray(timetableSubstitutions.mergeLessonId, [...hostIds]), gte(timetableSubstitutions.date, fromDate)));
  const out: ReleasedMerge[] = [];
  for (const r of rows) out.push({ date: r.date, groupId: r.groupId, teacherId: r.teacherId, hostTeachers: await hostTeachers(db, r.date, [r.host!]) });
  return out;
}

/**
 * R1b/A10: die aufnehmende Stunde ist gelöscht – die Zusammenlegung bleibt ohne Ziel stehen („aufgehoben“, Bedarf wieder offen).
 * Gong je Tag an Schüler:innen der Gruppe, ihre Lehrkraft und die bisher mitbetreuende Lehrkraft.
 */
export async function notifyReleasedMerges(db: Db, actorId: string, released: readonly ReleasedMerge[]): Promise<void> {
  for (const date of [...new Set(released.map((r) => r.date))].sort()) {
    const day = released.filter((r) => r.date === date);
    await notifySubstitutionDay(db, actorId, date, {
      students: await studentsOf(db, day.map((r) => r.groupId)),
      teachers: day.flatMap((r) => [r.teacherId, ...r.hostTeachers]).filter((x): x is string => !!x),
    });
  }
}

/** SP2-07: wer betreut in diesen Stunden an `date` (eigene Lehrkraft bzw. Vertretung)? */
async function hostTeachers(db: Db, date: string, lessonIds: readonly string[]): Promise<string[]> {
  if (lessonIds.length === 0) return [];
  const rows = await db
    .select({ teacherId: timetableLessons.teacherId, kind: timetableSubstitutions.kind, substituteId: timetableSubstitutions.substituteId })
    .from(timetableLessons)
    .leftJoin(timetableSubstitutions, and(eq(timetableSubstitutions.lessonId, timetableLessons.id), eq(timetableSubstitutions.date, date)))
    .where(inArray(timetableLessons.id, [...lessonIds]));
  return rows.map((r) => (r.kind === "substitute" ? r.substituteId : r.teacherId)).filter((x): x is string => !!x);
}

/** SP2-16b: markierte Änderung behalten („Abwesenheit beendet – prüfen“ fällt weg, auch bei den Teilen derselben Kopplung). */
export async function keepReviewedSubstitution(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.id, id));
  if (!old || !old.absenceEndedAt) return;
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, old.lessonId));
  const parts = l ? (old.kind === "move" ? await couplingParts(db, l, old.date) : await couplingSiblings(db, l, old.date)) : [];
  await db
    .update(timetableSubstitutions)
    .set({ absenceEndedAt: null })
    .where(and(eq(timetableSubstitutions.date, old.date), inArray(timetableSubstitutions.lessonId, [old.lessonId, ...parts.map((p) => p.id)])));
  await audit(db, actorId, "stundenplan.substitution.save", l?.groupId ?? null, { lesson: old.lessonId, date: old.date, kind: old.kind, kept: true });
}

/**
 * SP2-16b: alle markierten Änderungen ab `from` entfernen (wie „Aufheben“ je Änderung, mit Gong). Was nicht geht (etwa weil in die
 * Stunde inzwischen etwas verlegt ist), bleibt markiert und wird genannt.
 */
export async function removeReviewedSubstitutions(db: Db, actorId: string, from: string): Promise<{ removed: number; failed: { date: string; reason: string }[] }> {
  const rows = await db
    .select({ id: timetableSubstitutions.id, date: timetableSubstitutions.date })
    .from(timetableSubstitutions)
    .where(and(isNotNull(timetableSubstitutions.absenceEndedAt), gte(timetableSubstitutions.date, from)));
  let removed = 0;
  const failed: { date: string; reason: string }[] = [];
  for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) {
    // Teile derselben Kopplung verschwinden mit der ersten
    const [still] = await db.select({ id: timetableSubstitutions.id }).from(timetableSubstitutions).where(eq(timetableSubstitutions.id, r.id));
    if (!still) continue;
    try {
      await deleteSubstitution(db, actorId, r.id);
      removed++;
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      failed.push({ date: r.date, reason: Object.values(err.fieldErrors)[0] ?? "geht nicht" });
    }
  }
  return { removed, failed };
}

/** Löscht die Änderung – bei Kopplungen auch die der anderen Teile derselben Lehrkraft (Verlegung: aller Teile) am selben Tag. */
export async function deleteSubstitution(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.id, id));
  if (!old) return;
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, old.lessonId));
  const siblings = l ? (old.kind === "move" ? await couplingParts(db, l, old.date) : await couplingSiblings(db, l, old.date)) : [];
  // SP2-07: kehrt die Stunde an ihren Platz zurück, darf dort keine andere Stunde der Gruppe hinverlegt sein – außer dem Tauschpartner
  // aus der Zielstunde, der mit zurückgenommen wird
  if (l && !takesPlaceAsUsual(old)) {
    const unit = [l, ...siblings];
    const moved = await movedInto(db, old.date, l.weekday, l.periodNr, [...new Set(unit.map((x) => x.groupId))], unit.map((x) => x.id));
    const partners = old.kind === "move" ? moved.filter((x) => x.periodNr === old.targetPeriod) : [];
    if (moved.length > partners.length) throw new ValidationError({ kind: "In diese Stunde ist eine andere Stunde der Gruppe verlegt – erst die Verlegung aufheben" });
    // R1b/A5: der Tauschpartner wanderte mit seinen Kopplungsteilen (auch anderer Gruppen) – die kommen mit zurück
    const day = partners.length ? await dayLessons(db, old.date, l.weekday) : [];
    for (const p of partners)
      for (const y of await couplingParts(db, p, old.date)) {
        const ys = day.find((d) => d.l.id === y.id)?.s;
        if (ys?.kind === "move" && ys.targetPeriod === l.periodNr && !partners.some((z) => z.id === y.id)) partners.push(y);
      }
    siblings.push(...partners.filter((p) => !siblings.some((x) => x.id === p.id)));
  }
  await db.delete(timetableSubstitutions).where(eq(timetableSubstitutions.id, id));
  if (siblings.length)
    await db
      .delete(timetableSubstitutions)
      .where(and(eq(timetableSubstitutions.date, old.date), inArray(timetableSubstitutions.lessonId, siblings.map((x) => x.id))));
  await audit(db, actorId, "stundenplan.substitution.delete", old.lessonId, { date: old.date, kind: old.kind });
  // Q5-03: Zurücknehmen ist auch eine Änderung (Entfall fällt weg → das Kind kommt doch nicht früher) – Tagesnachricht erneuern
  if (l)
    await notifySubstitutionDay(db, actorId, old.date, {
      students: await studentsOf(db, [l, ...siblings].map((x) => x.groupId)),
      teachers: [l.teacherId, old.substituteId, ...siblings.map((x) => x.teacherId), ...(await hostTeachers(db, old.date, old.mergeLessonId ? [old.mergeLessonId] : []))].filter(
        (x): x is string => !!x,
      ),
    });
}

/**
 * Q5-11: Entwurf eines Tages veröffentlichen – ab jetzt sehen alle die Änderungen, und jede betroffene Person bekommt die
 * gebündelte Tagesnachricht (Q5-03). Gibt `null` zurück, wenn der Tag kein Entwurf (mehr) ist, sonst die Zahl der Empfänger.
 */
export async function publishDay(db: Db, actorId: string, date: string): Promise<number | null> {
  if (!YMD.test(date)) throw new ValidationError({ date: "Datum angeben" });
  let published = false;
  let changeCount = 0;
  const recipients = await notifySubstitutionDay(
    db,
    actorId,
    date,
    // GATE-4f C-01: Empfänger erst unter der Tagessperre ermitteln – wer während des Veröffentlichens speichert, ist dabei
    async (tx) => {
      const changes = await dayChanges(tx, date);
      changeCount = changes.length;
      return {
        students: await studentsOf(tx, [...new Set(changes.map((c) => c.groupId))]),
        teachers: [...new Set(changes.flatMap((c) => [c.teacherId, c.substituteId]).filter((x): x is string => !!x))],
      };
    },
    async (tx) => {
      const rows = await tx
        .update(timetableSubstitutionDays)
        .set({ publishedAt: new Date(), publishedBy: actorId })
        .where(and(eq(timetableSubstitutionDays.date, date), isNull(timetableSubstitutionDays.publishedAt)))
        .returning({ date: timetableSubstitutionDays.date });
      published = rows.length > 0;
      return published;
    },
  );
  if (!published) return null;
  await audit(db, actorId, "stundenplan.substitution.publish", null, { date, changes: changeCount, recipients: recipients.length });
  return recipients.length;
}

/** Schüler:innen der Gruppen (Empfänger des Vertretungs-Gongs). */
async function studentsOf(db: Db, groupIds: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, [...groupIds]), eq(users.role, "schueler")));
  return [...new Set(rows.map((r) => r.id))];
}

export interface DaySubstitution {
  id: string;
  lessonId: string;
  date: string;
  kind: SubstitutionKind;
  /** SP2-07 Verlegung: Eintrag in der neuen Stunde (`periodNr`) – aus welcher Stunde; sonst null */
  movedFrom: number | null;
  /** SP2-07 Verlegung: Eintrag in der bisherigen Stunde – in welche Stunde; sonst null */
  movedTo: number | null;
  /** SP2-07 Zusammenlegung: Gruppe, Lehrkraft (Kürzel) und Raum der Stunde, zu der die Gruppe geht */
  mergeWith: MergeTarget | null;
  periodNr: number;
  groupId: string;
  groupName: string;
  gradeLevel: number | null;
  /** tatsächliches Fach (SP-12: bei Fachtausch das Fach der Vertretung) */
  subjectName: string;
  color: string;
  /** SP-12: reguläres Fach, wenn die Vertretung ein anderes gibt – sonst null */
  insteadOf: string | null;
  teacherCode: string | null;
  substituteCode: string | null;
  substituteName: string | null;
  roomId: string | null;
  newRoomId: string | null;
  note: string | null;
  /** Q5-11: Tag ist noch Entwurf (nur mit `drafts: true` enthalten) */
  draft: boolean;
  /** SP2-16b: die Abwesenheit, wegen der die Änderung eingetragen ist, wurde verkürzt/aufgehoben – prüfen (nur Vertretungsplanung zeigt es) */
  absenceEnded: boolean;
}

/**
 * Alle Änderungen an einem oder mehreren Tagen (Vertretungsplan, Monitor, Verwaltung). Q5-11: Tage im Entwurf nur mit
 * `drafts: true` (Vertretungsplanung mit `stundenplan.substitute`) – alle anderen sehen den veröffentlichten Stand.
 */
export async function substitutionsOn(db: Db, dates: string[], opts: { drafts?: boolean } = {}): Promise<DaySubstitution[]> {
  if (dates.length === 0) return [];
  const drafts = await draftDays(db, dates);
  const visible = opts.drafts ? dates : dates.filter((d) => !drafts.has(d));
  if (visible.length === 0) return [];
  const teacher = alias(users, "teacher");
  const substitute = alias(users, "substitute");
  const alt = alias(subjects, "alt_subject");
  const rows = await db
    .select({
      s: timetableSubstitutions,
      l: timetableLessons,
      groupName: groups.name,
      gradeLevel: groups.gradeLevel,
      subjectName: subjects.name,
      color: subjects.color,
      teacherCode: teacher.shortCode,
      substituteCode: substitute.shortCode,
      substituteName: substitute.name,
      altName: alt.name,
      altColor: alt.color,
    })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(teacher, eq(teacher.id, timetableLessons.teacherId))
    .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
    .leftJoin(alt, eq(alt.id, timetableSubstitutions.subjectId))
    .where(inArray(timetableSubstitutions.date, visible));
  const hosts = await mergeHosts(
    db,
    rows.filter((r) => r.s.kind === "merge" && r.s.mergeLessonId).map((r) => ({ lessonId: r.s.mergeLessonId!, date: r.s.date })),
  );
  return rows
    .flatMap((r) => {
      const e: DaySubstitution = {
        id: r.s.id,
        lessonId: r.l.id,
        date: r.s.date,
        kind: r.s.kind,
        periodNr: r.l.periodNr,
        movedFrom: null,
        movedTo: null,
        mergeWith: r.s.kind === "merge" && r.s.mergeLessonId ? (hosts.get(`${r.s.mergeLessonId}:${r.s.date}`) ?? null) : null,
        groupId: r.l.groupId,
        groupName: r.groupName,
        gradeLevel: r.gradeLevel,
        subjectName: r.altName ?? r.subjectName,
        color: r.altColor ?? r.color,
        insteadOf: r.altName ? r.subjectName : null,
        teacherCode: r.teacherCode,
        substituteCode: r.substituteCode,
        substituteName: r.substituteName,
        roomId: r.l.roomId,
        newRoomId: r.s.roomId,
        note: r.s.note,
        draft: drafts.has(r.s.date),
        absenceEnded: r.s.absenceEndedAt !== null,
      };
      // SP2-07: eine Verlegung steht zweimal im Plan – in der neuen Stunde und als „verlegt“ in der bisherigen
      if (r.s.kind === "move" && r.s.targetPeriod !== null)
        return [
          { ...e, movedTo: r.s.targetPeriod },
          { ...e, periodNr: r.s.targetPeriod, movedFrom: r.l.periodNr },
        ];
      return [e];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.groupName.localeCompare(b.groupName, "de", { numeric: true }) || a.periodNr - b.periodNr);
}

/**
 * SP-12: Arbeiten der Gruppen an einem Tag (Fach + Art) – für den Hinweis im Vertretungsformular, wenn das gewählte Fach
 * an dem Tag eine Klassenarbeit/Klausur hat. Nur für die Vertretungsplanung; liefert keine Titel oder Lehrkräfte.
 */
export async function examSubjectsOn(db: Db, groupIds: readonly string[], date: string): Promise<Map<string, { subjectId: string; subjectName: string; kind: ExamKind }[]>> {
  const out = new Map<string, { subjectId: string; subjectName: string; kind: ExamKind }[]>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({ groupId: exams.groupId, subjectId: exams.subjectId, subjectName: subjects.name, kind: exams.kind })
    .from(exams)
    .innerJoin(subjects, eq(subjects.id, exams.subjectId))
    .where(and(inArray(exams.groupId, [...groupIds]), eq(exams.date, date)));
  for (const r of rows) out.set(r.groupId, [...(out.get(r.groupId) ?? []), { subjectId: r.subjectId, subjectName: r.subjectName, kind: r.kind }]);
  return out;
}

/** Die beiden Tage des Vertretungsplans: heute (sonst der nächste Schultag) und der Schultag danach. */
export function planDays(today: string, cal: SchoolCalendar = OPEN_CALENDAR): [string, string] {
  const first = cal.nextSchoolDay(today);
  return [first, cal.nextSchoolDay(addDays(first, 1))];
}
