// Stundenplan-Pflege (Verwaltung): Stunden anlegen/ändern/löschen mit Kollisionsprüfung.
// SP3-02: jede Pflege-Funktion arbeitet wahlweise im gültigen Plan (Vorgabe) oder im Entwurf einer Planversion (`PlanSource`). Im Entwurf
// gibt es keine Vertretungen, Zusammenlegungen und keine Historie – Änderungen sind „in place“ und wirken erst mit dem Veröffentlichen
// (SP3-04); Kollisionen zählen nur innerhalb derselben Version.
// SP3-05: im gültigen Plan ist jede Änderung eine Sofort-Korrektur (`sofortkorrektur.ts`) – laufende Stunden werden ab dem nächsten Schultag
// geteilt statt in place geändert (Klassenbuch, Vertretungen und Material davor bleiben), mit Protokoll und Gong; in place bleibt nur, was
// keinen Vergangenheitsbezug hat.
import { and, asc, eq, gte, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, periods, rooms, schoolYears, subjects, users, type TimetableLesson } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { LESSON_WEEKS } from "./schema";
import { PLANNED_GROUP_KINDS } from "./verteilung";
import { de } from "@/core/db/sort";
import { toBerlinDate } from "@/core/time";
import { idWhere, insertLessonRows, lessonCols, LIVE, requireWritable, versionWhere, type PlanSource } from "./plan-quelle";
import { applyLiveUnits, checkReason, correctionFrom, planUnit, toBefore, withoutPast, type LiveOptions, type UnitAfter, type UnitPlan } from "./sofortkorrektur";
import { timetableLessons } from "./schema";

export const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr"] as const;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface LessonInput {
  groupId: string;
  weekday: number;
  periodNr: number;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  week: (typeof LESSON_WEEKS)[number];
  validFrom: string;
  validUntil: string | null;
  /** SP3-02: nur im Entwurf – Lehrauftrag, aus dem die Setzhilfe die Stunde gesetzt hat (Herkunft für Diff/Deputat) */
  assignmentId?: string | null;
}

export interface Collision {
  kind: "teacher" | "room" | "group";
  lessonId: string;
  message: string;
}

type Slot = Pick<TimetableLesson, "weekday" | "periodNr" | "week" | "validFrom" | "validUntil">;

/** Überschneiden sich zwei Stunden zeitlich (gleicher Slot, Gültigkeit und A/B-Woche)? */
export function slotsOverlap(a: Slot, b: Slot): boolean {
  if (a.weekday !== b.weekday || a.periodNr !== b.periodNr) return false;
  if (a.week !== "all" && b.week !== "all" && a.week !== b.week) return false;
  const aEnd = a.validUntil ?? "9999-12-31";
  const bEnd = b.validUntil ?? "9999-12-31";
  return a.validFrom <= bEnd && b.validFrom <= aEnd;
}

/** Audit-Ziel im Entwurf: die Version (ohne Personen). */
const draftMeta = (source: PlanSource) => (source.kind === "draft" ? { draft: source.versionId } : {});

/**
 * Andere Stunden, mit denen `input` kollidiert (Lehrkraft, Raum, Gruppe). Stunden derselben Kopplung und
 * `excludeIds` (die Stunde selbst bzw. bisherige Teile der Kopplung) zählen nicht. Im Entwurf nur Stunden derselben Version.
 */
export async function findCollisions(db: Db, input: LessonInput, opts: { excludeIds?: string[]; couplingId?: string | null } = {}, source: PlanSource = LIVE): Promise<Collision[]> {
  const t = lessonCols(source);
  const who = [eq(t.groupId, input.groupId)];
  if (input.teacherId) who.push(eq(t.teacherId, input.teacherId));
  if (input.roomId) who.push(eq(t.roomId, input.roomId));
  const rows = await db
    .select({ l: { id: t.id, groupId: t.groupId, teacherId: t.teacherId, roomId: t.roomId, weekday: t.weekday, periodNr: t.periodNr, week: t.week, validFrom: t.validFrom, validUntil: t.validUntil }, groupName: groups.name, teacherCode: users.shortCode })
    .from(t)
    .innerJoin(groups, eq(groups.id, t.groupId))
    .leftJoin(users, eq(users.id, t.teacherId))
    .where(
      and(
        versionWhere(source),
        eq(t.weekday, input.weekday),
        eq(t.periodNr, input.periodNr),
        or(...who),
        opts.excludeIds?.length ? notInArray(t.id, opts.excludeIds) : undefined,
        opts.couplingId ? or(isNull(t.couplingId), ne(t.couplingId, opts.couplingId)) : undefined,
      ),
    );
  const when = `${WEEKDAYS[input.weekday]} ${input.periodNr}. Stunde`;
  const out: Collision[] = [];
  for (const r of rows) {
    if (!slotsOverlap(r.l, input)) continue;
    if (input.teacherId && r.l.teacherId === input.teacherId) {
      out.push({ kind: "teacher", lessonId: r.l.id, message: `${r.teacherCode ?? "Lehrkraft"} unterrichtet ${when} schon in ${r.groupName}` });
    }
    if (input.roomId && r.l.roomId === input.roomId) {
      out.push({ kind: "room", lessonId: r.l.id, message: `Raum ${input.roomId} ist ${when} schon von ${r.groupName} belegt` });
    }
    if (r.l.groupId === input.groupId) {
      out.push({ kind: "group", lessonId: r.l.id, message: `${r.groupName} hat ${when} schon eine Stunde (geteilte Klasse? Dann eine Kopplung anlegen)` });
    }
  }
  return out;
}

type SlotInput = Pick<LessonInput, "weekday" | "periodNr" | "week" | "validFrom" | "validUntil">;

function checkSlot(input: SlotInput, fe: Record<string, string>) {
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 4) fe.weekday = "Wochentag wählen";
  if (!LESSON_WEEKS.includes(input.week)) fe.week = "Woche wählen";
  if (!YMD.test(input.validFrom)) fe.validFrom = "Beginn angeben";
  if (input.validUntil !== null && (!YMD.test(input.validUntil) || input.validUntil < input.validFrom)) fe.validUntil = "Ende muss nach dem Beginn liegen";
}

/** Prüft Gruppe, Stunde, Fach, Lehrkraft und Raum; Fehler landen unter `${prefix}<feld>`. */
async function checkRefs(db: Db, input: LessonInput, fe: Record<string, string>, prefix = ""): Promise<void> {
  const [[g], [p], [s], t, r] = await Promise.all([
    db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId)),
    db.select({ nr: periods.nr }).from(periods).where(eq(periods.nr, input.periodNr)),
    db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, input.subjectId)),
    input.teacherId ? db.select({ role: users.role }).from(users).where(eq(users.id, input.teacherId)) : Promise.resolve([{ role: "lehrkraft" as const }]),
    input.roomId ? db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, input.roomId)) : Promise.resolve([{ id: "" }]),
  ]);
  if (!g) fe[`${prefix}groupId`] = "Gruppe wählen";
  if (!p) fe.periodNr = "Stunde wählen";
  if (!s) fe[`${prefix}subjectId`] = "Fach wählen";
  if (t[0]?.role !== "lehrkraft") fe[`${prefix}teacherId`] = "Lehrkraft wählen";
  if (!r[0]) fe[`${prefix}roomId`] = "Raum gibt es nicht";
}

async function validate(db: Db, input: LessonInput, excludeId: string | undefined, source: PlanSource): Promise<void> {
  await validateFields(db, input, excludeId, source);
  await checkCollisions(db, input, excludeId, source);
}

async function validateFields(db: Db, input: LessonInput, excludeId: string | undefined, source: PlanSource): Promise<void> {
  const fe: Record<string, string> = {};
  checkSlot(input, fe);
  await checkRefs(db, input, fe);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  if (excludeId) {
    const t = lessonCols(source);
    const [own] = await db.select({ c: t.couplingId }).from(t).where(idWhere(source, excludeId));
    if (own?.c) throw new ValidationError({ id: "Die Stunde gehört zu einer Kopplung – dort bearbeiten" });
  }
}

async function checkCollisions(db: Db, input: LessonInput, excludeId: string | undefined, source: PlanSource): Promise<void> {
  const collisions = await findCollisions(db, input, { excludeIds: excludeId ? [excludeId] : [] }, source);
  if (collisions.length) {
    const fe: Record<string, string> = {};
    const fieldOf = { teacher: "teacherId", room: "roomId", group: "periodNr" } as const;
    for (const c of collisions) fe[fieldOf[c.kind]] ??= c.message;
    throw new ValidationError(fe);
  }
}

/** Gültigkeit, mit der eine Änderung im gültigen Plan auf Kollisionen geprüft wird: ab dem Stichtag eines Splits. */
const effectiveValidity = <T extends { validFrom: string }>(input: T, plan: UnitPlan): T => (plan.mode === "split" ? { ...input, validFrom: plan.cut } : input);

function values(i: LessonInput) {
  return { groupId: i.groupId, weekday: i.weekday, periodNr: i.periodNr, subjectId: i.subjectId, teacherId: i.teacherId, roomId: i.roomId, week: i.week, validFrom: i.validFrom, validUntil: i.validUntil };
}

export async function createLesson(db: Db, actorId: string, input: LessonInput, source: PlanSource = LIVE, opts: LiveOptions = {}): Promise<string> {
  await requireWritable(db, source);
  await validate(db, input, undefined, source);
  let id: string;
  if (source.kind === "live") {
    // SP3-05: neue Stunde im gültigen Plan – Protokoll und Gong (eine neue Stunde zerreißt nichts, sie gilt wie eingegeben)
    checkReason(opts.reason);
    const today = opts.today ?? toBerlinDate(new Date());
    const plan = planUnit({ before: [], after: [{ ...values(input), couplingId: null }], coupled: false, today, from: today, noPast: true });
    await applyLiveUnits(db, actorId, [plan], { ...opts, today });
    id = plan.inserts[0]!.id;
  } else id = (await insertLessonRows(db, source, [{ ...values(input), assignmentId: input.assignmentId ?? null }]))[0]!;
  await audit(db, actorId, source.kind === "draft" ? "stundenplan.draft.lesson.create" : "stundenplan.lesson.create", input.groupId, {
    weekday: input.weekday,
    period: input.periodNr,
    subject: input.subjectId,
    ...draftMeta(source),
  });
  return id;
}

type LiveRow = typeof timetableLessons.$inferSelect;

/** Eine Stunde des gültigen Plans mit allen Feldern (für die Sofort-Korrektur). */
async function liveRow(db: Db, id: string): Promise<LiveRow | null> {
  const [row] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, id));
  return row ?? null;
}

/** Plan einer Sofort-Korrektur für eine Einheit: ohne Vergangenheitsbezug in place, sonst Split ab dem Stichtag. */
export async function liveUnitPlan(db: Db, before: LiveRow[], after: UnitAfter[], coupled: boolean, opts: LiveOptions, forceSplit = false): Promise<{ plan: UnitPlan; today: string }> {
  checkReason(opts.reason);
  const today = opts.today ?? toBerlinDate(new Date());
  const noPast = !forceSplit && (before.length === 0 || (await withoutPast(db, before, today)));
  const from = noPast ? today : await correctionFrom(db, today, opts.from);
  return { plan: planUnit({ before: before.map(toBefore), after, coupled, today, from, noPast }), today };
}

/** Felder einer Stunde des gültigen Plans als „nachher“ (unverändert). */
export const afterOf = (l: LiveRow): UnitAfter => ({
  id: l.id,
  groupId: l.groupId,
  subjectId: l.subjectId,
  teacherId: l.teacherId,
  roomId: l.roomId,
  weekday: l.weekday,
  periodNr: l.periodNr,
  week: l.week,
  validFrom: l.validFrom,
  validUntil: l.validUntil,
  couplingId: l.couplingId,
});

export async function updateLesson(db: Db, actorId: string, id: string, input: LessonInput, source: PlanSource = LIVE, opts: LiveOptions = {}): Promise<void> {
  await requireWritable(db, source);
  const t = lessonCols(source);
  const [old] = await db.select({ id: t.id }).from(t).where(idWhere(source, id));
  if (!old) throw new ValidationError({ id: "Stunde gibt es nicht mehr" });
  if (source.kind === "live") {
    // SP3-05: laufende Stunde → Split ab dem nächsten Schultag; Kollisionen zählen ab dann
    await validateFields(db, input, id, source);
    const row = (await liveRow(db, id))!;
    const { plan, today } = await liveUnitPlan(db, [row], [{ ...values(input), couplingId: row.couplingId, id }], false, opts);
    if (plan.mode === "noop") return;
    await checkCollisions(db, effectiveValidity(input, plan), id, source);
    await applyLiveUnits(db, actorId, [plan], { ...opts, today });
  } else {
    await validate(db, input, id, source);
    await db.update(t).set(values(input)).where(idWhere(source, id));
  }
  await audit(db, actorId, source.kind === "draft" ? "stundenplan.draft.lesson.update" : "stundenplan.lesson.update", input.groupId, { lesson: id, ...draftMeta(source) });
}

export async function deleteLesson(db: Db, actorId: string, id: string, today = toBerlinDate(new Date()), source: PlanSource = LIVE, opts: LiveOptions = {}): Promise<void> {
  if (source.kind === "draft") {
    // Entwurf: keine Vertretungen/Zusammenlegungen, keine Historie
    await requireWritable(db, source);
    const t = lessonCols(source);
    const [old] = await db.delete(t).where(idWhere(source, id)).returning();
    if (!old) return;
    if (old.couplingId) await dissolveIfSingle(db, old.couplingId, source);
    await audit(db, actorId, "stundenplan.draft.lesson.delete", old.groupId, { weekday: old.weekday, period: old.periodNr, subject: old.subjectId, ...draftMeta(source) });
    return;
  }
  // SP3-05: ohne Vergangenheitsbezug wird die Stunde gelöscht (Zusammenlegungen in sie bleiben ohne Ziel stehen, R1b/A10), sonst endet sie am
  // Vortag des Stichtags; ein Teil einer laufenden Kopplung beendet die Kopplung – die übrigen Teile gelten ab dem Stichtag neu gekoppelt
  const old = await liveRow(db, id);
  if (!old) return;
  const unit = old.couplingId ? await db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, old.couplingId)).orderBy(asc(timetableLessons.id)) : [old];
  const rest = unit.filter((u) => u.id !== id).map((u) => ({ ...afterOf(u), couplingId: unit.length > 2 ? u.couplingId : null }));
  const { plan } = await liveUnitPlan(db, unit, rest, Boolean(old.couplingId), { ...opts, today });
  await applyLiveUnits(db, actorId, [plan], { ...opts, today });
  await audit(db, actorId, "stundenplan.lesson.delete", old.groupId, { weekday: old.weekday, period: old.periodNr, subject: old.subjectId, ended: plan.mode === "split" || undefined });
}

/** Eine Kopplung mit nur noch einem Teil ist keine mehr. */
async function dissolveIfSingle(db: Db, couplingId: string, source: PlanSource) {
  const t = lessonCols(source);
  const rest = await db.select({ id: t.id }).from(t).where(and(versionWhere(source), eq(t.couplingId, couplingId)));
  if (rest.length === 1) await db.update(t).set({ couplingId: null }).where(eq(t.id, rest[0]!.id));
}

// ---------------------------------------------------------------- Kopplungen

export interface CouplingPart {
  /** bestehende Stunde (behält Vertretungen und Klassenbuch-Einträge) */
  id?: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  /** SP3-02: nur im Entwurf – Lehrauftrag des Teils (Setzhilfe) */
  assignmentId?: string | null;
}

export interface CouplingInput extends SlotInput {
  parts: CouplingPart[];
}

/**
 * Legt eine Kopplung an oder ändert sie: alle Teile liegen im selben Slot. Innerhalb der Kopplung darf eine Gruppe
 * mehrfach vorkommen (geteilte Klasse), eine Lehrkraft mehrere Gruppen im selben Raum unterrichten und ein Raum
 * mehrere Lehrkräfte haben (Teamteaching). Nach außen gelten die normalen Kollisionen. Fehler je Teil unter `p<i>-<feld>`.
 */
export async function saveCoupling(db: Db, actorId: string, couplingId: string | null, input: CouplingInput, source: PlanSource = LIVE, opts: LiveOptions = {}): Promise<string> {
  await requireWritable(db, source);
  const t = lessonCols(source);
  const fe: Record<string, string> = {};
  checkSlot(input, fe);
  if (input.parts.length < 2) fe.parts = "Eine Kopplung braucht mindestens zwei Teile";
  const existing = couplingId ? await db.select({ id: t.id }).from(t).where(and(versionWhere(source), eq(t.couplingId, couplingId))) : [];
  if (couplingId && !existing.length) throw new ValidationError({ id: "Die Kopplung gibt es nicht mehr" });
  // Teile mit id: Stunden dieser Kopplung oder (beim Erweitern) eine ungekoppelte Stunde
  const ids = input.parts.map((p) => p.id).filter((x): x is string => Boolean(x));
  const known = ids.length ? await db.select({ id: t.id, couplingId: t.couplingId }).from(t).where(and(versionWhere(source), inArray(t.id, ids))) : [];
  for (const [i, p] of input.parts.entries()) {
    if (!p.id) continue;
    const row = known.find((k) => k.id === p.id);
    if (!row || (row.couplingId !== null && row.couplingId !== couplingId)) fe[`p${i}-groupId`] = "Diese Stunde gehört zu einer anderen Kopplung";
  }
  const seen = new Map<string, number>();
  for (const [i, p] of input.parts.entries()) {
    const lesson = { ...input, ...p };
    await checkRefs(db, lesson, fe, `p${i}-`);
    const key = `${p.groupId}|${p.subjectId}|${p.teacherId ?? ""}`;
    if (seen.has(key)) fe[`p${i}-groupId`] = "Dieser Teil steht schon in der Kopplung";
    seen.set(key, i);
    const sameTeacher = p.teacherId ? input.parts.findIndex((q) => q.teacherId === p.teacherId) : i;
    if (sameTeacher < i && input.parts[sameTeacher]!.roomId !== p.roomId) fe[`p${i}-roomId`] = "Dieselbe Lehrkraft kann nicht in zwei Räumen sein";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);

  let id = couplingId ?? crypto.randomUUID();
  const excludeIds = [...new Set([...existing.map((e) => e.id), ...ids])];
  const slot = { weekday: input.weekday, periodNr: input.periodNr, week: input.week, validFrom: input.validFrom, validUntil: input.validUntil, couplingId: id };

  // SP3-05: im gültigen Plan als Sofort-Korrektur – eine laufende Kopplung endet am Vortag des Stichtags, alle Teile gelten ab dann neu gekoppelt
  let plan: UnitPlan | null = null;
  let today = toBerlinDate(new Date());
  if (source.kind === "live") {
    const before = excludeIds.length ? await db.select().from(timetableLessons).where(inArray(timetableLessons.id, excludeIds)).orderBy(asc(timetableLessons.id)) : [];
    const r = await liveUnitPlan(
      db,
      before,
      input.parts.map((p) => ({ ...slot, id: p.id, groupId: p.groupId, subjectId: p.subjectId, teacherId: p.teacherId, roomId: p.roomId })),
      true,
      opts,
    );
    plan = r.plan;
    today = r.today;
    if (plan.mode === "noop") return id;
  }

  const check = plan ? effectiveValidity(input, plan) : input;
  for (const [i, p] of input.parts.entries()) {
    const collisions = await findCollisions(db, { ...check, ...p }, { excludeIds, couplingId: id }, source);
    const fieldOf = { teacher: "teacherId", room: "roomId", group: "groupId" } as const;
    for (const c of collisions) fe[`p${i}-${fieldOf[c.kind]}`] ??= c.message;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);

  if (plan) {
    await applyLiveUnits(db, actorId, [plan], { ...opts, today });
    if (plan.mode === "split") id = plan.inserts[0]?.couplingId ?? id;
  } else {
    const keep = new Set(ids);
    const gone = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    await db.transaction(async (tx) => {
      const x = tx as unknown as Db;
      if (gone.length) await tx.delete(t).where(and(versionWhere(source), inArray(t.id, gone)));
      const fresh = [];
      for (const p of input.parts) {
        const v = { ...slot, groupId: p.groupId, subjectId: p.subjectId, teacherId: p.teacherId, roomId: p.roomId };
        if (p.id) await tx.update(t).set(v).where(idWhere(source, p.id));
        else fresh.push({ ...v, assignmentId: p.assignmentId ?? null });
      }
      if (fresh.length) await insertLessonRows(x, source, fresh);
    });
  }
  await audit(
    db,
    actorId,
    source.kind === "draft" ? (couplingId ? "stundenplan.draft.coupling.update" : "stundenplan.draft.coupling.create") : couplingId ? "stundenplan.coupling.update" : "stundenplan.coupling.create",
    input.parts[0]!.groupId,
    {
      coupling: id,
      weekday: input.weekday,
      period: input.periodNr,
      parts: input.parts.length,
      ...(plan?.mode === "split" ? { ended: true } : {}),
      ...draftMeta(source),
    },
  );
  return id;
}

export async function deleteCoupling(db: Db, actorId: string, couplingId: string, source: PlanSource = LIVE, opts: LiveOptions = {}): Promise<void> {
  await requireWritable(db, source);
  const t = lessonCols(source);
  const where = and(versionWhere(source), eq(t.couplingId, couplingId));
  if (source.kind === "draft") {
    const gone = await db.delete(t).where(where).returning();
    if (gone.length) await audit(db, actorId, "stundenplan.draft.coupling.delete", gone[0]!.groupId, { coupling: couplingId, parts: gone.length, ...draftMeta(source) });
    return;
  }
  // SP3-05: ohne Vergangenheitsbezug gelöscht (Zusammenlegungen in die Kopplung bleiben ohne Ziel stehen, R1b/A10), sonst endet sie am Vortag
  const parts = await db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, couplingId)).orderBy(asc(timetableLessons.id));
  if (!parts.length) return;
  const { plan, today } = await liveUnitPlan(db, parts, [], true, opts);
  await applyLiveUnits(db, actorId, [plan], { ...opts, today });
  await audit(db, actorId, "stundenplan.coupling.delete", parts[0]!.groupId, { coupling: couplingId, parts: parts.length, ended: plan.mode === "split" || undefined });
}

export interface CouplingRow {
  id: string;
  couplingId: string;
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  teacherId: string | null;
  teacherCode: string | null;
  roomId: string | null;
}

/** Alle Teile der angegebenen Kopplungen, nach Gruppe sortiert. */
export async function couplingParts(db: Db, couplingIds: string[], source: PlanSource = LIVE): Promise<CouplingRow[]> {
  if (!couplingIds.length) return [];
  const t = lessonCols(source);
  const rows = await db
    .select({ id: t.id, couplingId: t.couplingId, groupId: t.groupId, subjectId: t.subjectId, teacherId: t.teacherId, roomId: t.roomId, groupName: groups.name, subjectName: subjects.name, teacherCode: users.shortCode })
    .from(t)
    .innerJoin(groups, eq(groups.id, t.groupId))
    .innerJoin(subjects, eq(subjects.id, t.subjectId))
    .leftJoin(users, eq(users.id, t.teacherId))
    .where(and(versionWhere(source), inArray(t.couplingId, couplingIds)))
    .orderBy(asc(groups.gradeLevel), de(groups.name), asc(subjects.sortOrder), asc(users.shortCode), asc(t.id));
  return rows.map((r) => ({ ...r, couplingId: r.couplingId! }));
}

/**
 * Raumvorschlag beim Setzen: Fach mit Raumwunsch (NW, Sport, Kunst …) → erster aktiver Raum dieser Art,
 * sonst der Stammraum der Gruppe.
 */
export function suggestRoom(subject: { roomKind: string | null } | undefined, homeRoomId: string | null, roomList: { id: string; kind: string; active?: boolean }[]): string | null {
  if (subject?.roomKind && subject.roomKind !== "klassenraum") {
    const fit = roomList.find((r) => r.kind === subject.roomKind && r.active !== false);
    if (fit) return fit.id;
  }
  return homeRoomId;
}

/** Gruppen, für die ein Stundenplan gepflegt wird. */
export async function plannableGroups(db: Db) {
  return db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, homeRoomId: groups.homeRoomId })
    .from(groups)
    .where(inArray(groups.kind, [...PLANNED_GROUP_KINDS]))
    .orderBy(asc(groups.kind), asc(groups.gradeLevel), de(groups.name));
}

export async function teacherOptions(db: Db) {
  return db
    .select({ id: users.id, name: users.name, code: users.shortCode })
    .from(users)
    .where(eq(users.role, "lehrkraft"))
    .orderBy(asc(users.shortCode));
}

/** Aktuelle und künftige Stunden einer Gruppe (abgelaufene ausgeblendet) – im gültigen Plan oder im Entwurf. */
export async function lessonsOfGroup(db: Db, groupId: string, todayYmd: string, source: PlanSource = LIVE) {
  const t = lessonCols(source);
  const rows = await db
    .select({
      id: t.id,
      groupId: t.groupId,
      weekday: t.weekday,
      periodNr: t.periodNr,
      subjectId: t.subjectId,
      teacherId: t.teacherId,
      roomId: t.roomId,
      week: t.week,
      validFrom: t.validFrom,
      validUntil: t.validUntil,
      couplingId: t.couplingId,
      fixed: t.fixed,
      solverRunId: t.solverRunId,
      subjectName: subjects.name,
      color: subjects.color,
      teacherCode: users.shortCode,
    })
    .from(t)
    .innerJoin(subjects, eq(subjects.id, t.subjectId))
    .leftJoin(users, eq(users.id, t.teacherId))
    .where(and(versionWhere(source), eq(t.groupId, groupId), or(isNull(t.validUntil), gte(t.validUntil, todayYmd))))
    .orderBy(asc(t.weekday), asc(t.periodNr), asc(t.validFrom), asc(t.id));
  return rows.map(({ subjectName, color, teacherCode, ...l }) => ({ l, subjectName, color, teacherCode }));
}

/** Vorbelegung für neue Stunden: laufendes Schuljahr; mit `from` (Planungsstand einer neuen Periode bzw. Stichtag des Entwurfs) erst ab diesem Tag. */
export async function defaultValidity(db: Db, todayYmd: string, from?: string): Promise<{ validFrom: string; validUntil: string | null }> {
  const [y] = await db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
  const v = y ? { validFrom: y.startsOn, validUntil: y.endsOn } : { validFrom: todayYmd, validUntil: null };
  return from && from > v.validFrom && (v.validUntil === null || from <= v.validUntil) ? { ...v, validFrom: from } : v;
}
