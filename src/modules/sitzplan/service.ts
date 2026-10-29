// Sitzplan (P5-01): Pläne je Lerngruppe mit Sichtbarkeit nach Need-to-know (§ 120 Abs. 1 S. 2 SchulG NRW). Sehen und
// ändern dürfen nur Lehrkräfte der Gruppe (Leitung, Lehrkraft-Mitglied, Stundenplan, Unterrichtsverteilung) und die
// Klassenleitung – mit dem Recht `sitzplan.edit`. Kein „alle sehen“: Verwaltung und Admin ohne Bezug zur Gruppe sehen
// nichts (fremde Pläne wie nicht vorhanden). Im Klassenbuch sieht zusätzlich, wer die Stunde an dem Tag hält (Vertretung).
// Fotos nur als Profilbild mit Einwilligung (DS-09, F5-09) und nur, wenn die Moduleinstellung es erlaubt; Druck ohne Fotos.
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import {
  groupMembers,
  groups,
  profilePhotos,
  rooms,
  schoolYears,
  sitzplanPlans,
  sitzplanSeats,
  subjects,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
  type SitzplanPlan,
} from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { photoUrl } from "@/core/privacy/profilbild";
import { seatKeys } from "@/core/raumlayout-raster";
import { canViewLayouts, layoutById } from "@/modules/verwaltung/raumlayout";
import { ValidationError } from "@/modules/verwaltung/users";
import { PRESETS, keepSeatsOnDesks, layoutError, presetDesks, seatInitials, seatsError, type Preset, type Seat } from "./layout";
import { PHOTOS_SETTING } from "./settings";

export const EDIT = "sitzplan.edit";
/** Gruppenarten mit Sitzplan (Unterricht; keine AG, Gremien, Fachschaften) */
export const PLAN_GROUP_KINDS = ["klasse", "kurs", "wahlpflicht", "foerderkurs"] as const;
export const TITLE_MAX = 80;

// ------------------------------------------------------------------ Wer darf

/**
 * Gruppen, in denen `viewer` unterrichtet oder die er leitet (aktiv, Unterrichtsgruppen): Leitung, Lehrkraft-Mitglied,
 * Stunden laut Stundenplan am Tag `today`, Lehraufträge des laufenden Schuljahres.
 */
export async function teachingGroupIds(db: Db, viewer: PermissionSet, today: string): Promise<Set<string>> {
  const direct = new Set<string>([...viewer.leaderOf, ...(viewer.role === "lehrkraft" ? viewer.memberOf : [])]);
  const [lessons, assigned] = await Promise.all([
    db
      .selectDistinct({ id: timetableLessons.groupId })
      .from(timetableLessons)
      .where(
        and(
          eq(timetableLessons.teacherId, viewer.userId),
          lte(timetableLessons.validFrom, today),
          or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, today)),
        ),
      ),
    db
      .selectDistinct({ id: timetableAssignmentGroups.groupId })
      .from(timetableAssignmentTeachers)
      .innerJoin(timetableAssignments, eq(timetableAssignments.id, timetableAssignmentTeachers.assignmentId))
      .innerJoin(timetableAssignmentGroups, eq(timetableAssignmentGroups.assignmentId, timetableAssignments.id))
      .innerJoin(schoolYears, eq(schoolYears.id, timetableAssignments.schoolYearId))
      .where(and(eq(timetableAssignmentTeachers.teacherId, viewer.userId), lte(schoolYears.startsOn, today), gte(schoolYears.endsOn, today))),
  ]);
  const ids = [...new Set([...direct, ...lessons.map((r) => r.id), ...assigned.map((r) => r.id)])];
  if (ids.length === 0) return new Set();
  const active = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(inArray(groups.id, ids), inArray(groups.kind, [...PLAN_GROUP_KINDS]), isNull(groups.archivedAt)));
  return new Set(active.map((g) => g.id));
}

/** Darf `viewer` Sitzpläne der Gruppe sehen und ändern? */
export async function canUseGroup(db: Db, viewer: PermissionSet, groupId: string, today: string): Promise<boolean> {
  if (viewer.locked || !hasPermission(viewer, EDIT)) return false;
  return (await teachingGroupIds(db, viewer, today)).has(groupId);
}

export interface GroupOption {
  id: string;
  name: string;
  subjectId: string | null;
  homeRoomId: string | null;
}

/** Eigene Unterrichtsgruppen (für „Neuer Sitzplan“), deutsch sortiert. */
export async function myGroups(db: Db, viewer: PermissionSet, today: string): Promise<GroupOption[]> {
  if (viewer.locked || !hasPermission(viewer, EDIT)) return [];
  const ids = [...(await teachingGroupIds(db, viewer, today))];
  if (ids.length === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name, subjectId: groups.subjectId, homeRoomId: groups.homeRoomId })
    .from(groups)
    .where(inArray(groups.id, ids))
    .orderBy(de(groups.name));
}

// ------------------------------------------------------------------ Lesen

export interface PlanListRow {
  id: string;
  title: string;
  groupId: string;
  groupName: string;
  subjectName: string | null;
  roomId: string | null;
  seated: number;
  updatedAt: Date;
}

/** Pläne der eigenen Gruppen, nach Gruppe und Titel. */
export async function listPlans(db: Db, viewer: PermissionSet, today: string, groupIds?: readonly string[]): Promise<PlanListRow[]> {
  if (viewer.locked || !hasPermission(viewer, EDIT)) return [];
  let ids = [...(await teachingGroupIds(db, viewer, today))];
  if (groupIds) ids = ids.filter((g) => groupIds.includes(g));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ p: sitzplanPlans, groupName: groups.name, subjectName: subjects.name })
    .from(sitzplanPlans)
    .innerJoin(groups, eq(groups.id, sitzplanPlans.groupId))
    .leftJoin(subjects, eq(subjects.id, sitzplanPlans.subjectId))
    .where(inArray(sitzplanPlans.groupId, ids))
    .orderBy(de(groups.name), de(sitzplanPlans.title));
  const counts = await seatCounts(
    db,
    rows.map((r) => r.p.id),
  );
  return rows.map((r) => ({
    id: r.p.id,
    title: r.p.title,
    groupId: r.p.groupId,
    groupName: r.groupName,
    subjectName: r.subjectName,
    roomId: r.p.roomId,
    seated: counts.get(r.p.id) ?? 0,
    updatedAt: r.p.updatedAt,
  }));
}

async function seatCounts(db: Db, planIds: readonly string[]): Promise<Map<string, number>> {
  if (planIds.length === 0) return new Map();
  // Belegte Plätze nur von Personen, die noch in der Gruppe sind
  const rows = await db
    .select({ planId: sitzplanSeats.planId })
    .from(sitzplanSeats)
    .innerJoin(sitzplanPlans, eq(sitzplanPlans.id, sitzplanSeats.planId))
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, sitzplanPlans.groupId), eq(groupMembers.userId, sitzplanSeats.studentId)))
    .where(inArray(sitzplanSeats.planId, [...planIds]));
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.planId, (out.get(r.planId) ?? 0) + 1);
  return out;
}

export interface PlanStudent {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  initials: string;
  /** Profilbild nur mit Einwilligung und eingeschalteter Einstellung */
  photo?: string;
}

export interface PlanView {
  plan: SitzplanPlan;
  groupName: string;
  subjectName: string | null;
  roomName: string | null;
  /** Schüler:innen der Gruppe, nach Nachname/Vorname */
  students: PlanStudent[];
  /** nur Plätze von Personen, die (noch) in der Gruppe sind */
  seats: Seat[];
}

/** Schüler:innen einer Gruppe (aktiv), deutsch sortiert. */
export async function groupStudents(db: Db, groupId: string): Promise<{ id: string; name: string; firstName: string; lastName: string }[]> {
  return db
    .select({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(users.role, "schueler"), eq(users.status, "active")))
    .orderBy(de(users.lastName), de(users.firstName));
}

/** Plan mit Personen ohne Rechteprüfung – nur intern nach einer Prüfung. */
async function buildView(db: Db, plan: SitzplanPlan, opts: { photos: boolean }): Promise<PlanView> {
  const [[meta], students, seats] = await Promise.all([
    db
      .select({ groupName: groups.name, subjectName: subjects.name, roomName: rooms.name })
      .from(groups)
      .leftJoin(subjects, eq(subjects.id, plan.subjectId ?? ""))
      .leftJoin(rooms, eq(rooms.id, plan.roomId ?? ""))
      .where(eq(groups.id, plan.groupId)),
    groupStudents(db, plan.groupId),
    db.select().from(sitzplanSeats).where(eq(sitzplanSeats.planId, plan.id)),
  ]);
  const ids = new Set(students.map((s) => s.id));
  const usePhotos = opts.photos && students.length > 0 && (await readModuleSetting(db, PHOTOS_SETTING)) === "an";
  const photos = usePhotos
    ? new Map(
        (
          await db
            .select({ userId: profilePhotos.userId, at: profilePhotos.createdAt })
            .from(profilePhotos)
            .where(
              inArray(
                profilePhotos.userId,
                students.map((s) => s.id),
              ),
            )
        ).map((p) => [p.userId, photoUrl(p.userId, p.at)]),
      )
    : new Map<string, string | undefined>();
  return {
    plan,
    groupName: meta?.groupName ?? "",
    subjectName: meta?.subjectName ?? null,
    roomName: meta?.roomName ?? null,
    students: students.map((s) => ({ ...s, initials: seatInitials(s.firstName, s.lastName), photo: photos.get(s.id) })),
    seats: keepSeatsOnDesks(
      seats.filter((s) => ids.has(s.studentId)).map((s) => ({ studentId: s.studentId, row: s.row, col: s.col })),
      plan.desks,
    ),
  };
}

/** Ein Plan – oder null, wenn es ihn nicht gibt oder `viewer` ihn nicht sehen darf (kein Unterschied nach außen). */
export async function getPlan(db: Db, viewer: PermissionSet, id: string, today: string, opts: { photos?: boolean } = {}): Promise<PlanView | null> {
  const [plan] = await db.select().from(sitzplanPlans).where(eq(sitzplanPlans.id, id));
  if (!plan || !(await canUseGroup(db, viewer, plan.groupId, today))) return null;
  return buildView(db, plan, { photos: opts.photos ?? true });
}

async function ownPlan(db: Db, viewer: PermissionSet, id: string, today: string): Promise<SitzplanPlan> {
  const [plan] = await db.select().from(sitzplanPlans).where(eq(sitzplanPlans.id, id));
  if (!plan || !(await canUseGroup(db, viewer, plan.groupId, today))) throw new ForbiddenError(EDIT);
  return plan;
}

// ------------------------------------------------------------------ Anlegen und ändern

export interface PlanMetaInput {
  title: string;
  subjectId: string | null;
  roomId: string | null;
}

export interface CreatePlanInput extends PlanMetaInput {
  groupId: string;
  rows: number;
  cols: number;
  preset: Preset;
  /** RS-09: Tische als Kopie aus einem Raumlayout (Raster und Platz-Zellen); Reihen/Spalten/Vorlage zählen dann nicht */
  layoutId?: string | null;
}

async function checkMeta(db: Db, input: PlanMetaInput): Promise<PlanMetaInput> {
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  if (!title) fe.title = "Titel angeben";
  else if (title.length > TITLE_MAX) fe.title = `Titel bitte kürzer (höchstens ${TITLE_MAX} Zeichen)`;
  const subjectId = input.subjectId?.trim() || null;
  const roomId = input.roomId?.trim() || null;
  if (subjectId && !(await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, subjectId))).length) fe.subjectId = "Fach gibt es nicht";
  if (roomId && !(await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId))).length) fe.roomId = "Raum gibt es nicht";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { title, subjectId, roomId };
}

/**
 * Legt einen Plan für eine eigene Gruppe an (Tische aus einer Vorlage, noch niemand sitzt). RS-09: mit `layoutId` werden
 * Raster und Platz-Zellen des Raumlayouts **kopiert** – der Plan gehört der Lehrkraft, spätere Änderungen am Raumlayout ändern
 * ihn nicht (nur ein Hinweis, `planLayoutSource`). Ohne Raumangabe wird der Raum des Layouts eingetragen.
 */
export async function createPlan(db: Db, viewer: PermissionSet, input: CreatePlanInput, today: string): Promise<string> {
  if (!(await canUseGroup(db, viewer, input.groupId, today))) throw new ForbiddenError(EDIT);
  const layout = input.layoutId ? await layoutById(db, input.layoutId) : null;
  if (input.layoutId && (!layout || !canViewLayouts(viewer))) throw new ValidationError({ preset: "Dieses Raumlayout gibt es nicht (mehr)" });
  const meta = await checkMeta(db, layout && !input.roomId?.trim() ? { ...input, roomId: layout.roomId } : input);
  let grid: { rows: number; cols: number; desks: string[] };
  if (layout) grid = { rows: layout.rows, cols: layout.cols, desks: seatKeys(layout.cells) };
  else {
    if (!(PRESETS as readonly string[]).includes(input.preset)) throw new ValidationError({ preset: "Anordnung wählen" });
    const err = layoutError(input.rows, input.cols, []);
    if (err) throw new ValidationError({ [err.startsWith("Reihen") ? "rows" : "cols"]: err });
    grid = { rows: input.rows, cols: input.cols, desks: presetDesks(input.preset, input.rows, input.cols) };
  }
  const [year] = await db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  const [row] = await db
    .insert(sitzplanPlans)
    .values({
      groupId: input.groupId,
      ...meta,
      ownerId: viewer.userId,
      schoolYearId: year?.id ?? null,
      ...grid,
      layoutId: layout?.id ?? null,
      layoutCopiedAt: layout ? new Date() : null,
    })
    .returning({ id: sitzplanPlans.id });
  await audit(db, viewer.userId, "sitzplan.anlegen", row!.id, { gruppe: input.groupId, ...(layout ? { raumlayout: layout.id } : {}) });
  return row!.id;
}

export interface PlanLayoutSource {
  layoutId: string;
  roomId: string;
  name: string;
  /** Raumlayout wurde nach dem Anlegen des Plans geändert (der Plan bleibt, wie er ist) */
  changed: boolean;
}

/** RS-09: Aus welchem Raumlayout stammt der Plan, und wurde es seitdem geändert? null ohne Vorlage bzw. gelöschtes Layout. */
export async function planLayoutSource(db: Db, plan: Pick<SitzplanPlan, "layoutId" | "layoutCopiedAt">): Promise<PlanLayoutSource | null> {
  if (!plan.layoutId) return null;
  const layout = await layoutById(db, plan.layoutId);
  if (!layout) return null;
  return { layoutId: layout.id, roomId: layout.roomId, name: layout.name, changed: !plan.layoutCopiedAt || layout.updatedAt.getTime() > plan.layoutCopiedAt.getTime() };
}

/** Titel, Fach und Raum ändern. */
export async function updatePlanMeta(db: Db, viewer: PermissionSet, id: string, input: PlanMetaInput, today: string): Promise<void> {
  await ownPlan(db, viewer, id, today);
  const meta = await checkMeta(db, input);
  await db
    .update(sitzplanPlans)
    .set({ ...meta, updatedAt: new Date() })
    .where(eq(sitzplanPlans.id, id));
}

export interface PlanLayoutInput {
  rows: number;
  cols: number;
  desks: string[];
  seats: Seat[];
}

/**
 * Speichert Raster, Tische und Plätze in einem Schritt (Editor). Alles wird vorab geprüft – Personen der Gruppe, nur auf
 * Tischen, je Tisch eine Person; sonst ändert sich nichts.
 */
export async function savePlan(db: Db, viewer: PermissionSet, id: string, input: PlanLayoutInput, today: string): Promise<void> {
  const plan = await ownPlan(db, viewer, id, today);
  const desks = [...new Set(input.desks)];
  const lerr = layoutError(input.rows, input.cols, desks);
  if (lerr) throw new ValidationError({ layout: lerr });
  const students = new Set((await groupStudents(db, plan.groupId)).map((s) => s.id));
  const serr = seatsError(input.seats, desks, students);
  if (serr) throw new ValidationError({ seats: serr });
  await db.transaction(async (tx) => {
    await tx.update(sitzplanPlans).set({ rows: input.rows, cols: input.cols, desks, updatedAt: new Date() }).where(eq(sitzplanPlans.id, id));
    await tx.delete(sitzplanSeats).where(eq(sitzplanSeats.planId, id));
    if (input.seats.length) await tx.insert(sitzplanSeats).values(input.seats.map((s) => ({ planId: id, studentId: s.studentId, row: s.row, col: s.col })));
  });
}

/** Kopie eines Plans (z. B. für ein anderes Fach oder einen anderen Raum) – mit Tischen und Plätzen. */
export async function copyPlan(db: Db, viewer: PermissionSet, id: string, title: string, today: string): Promise<string> {
  const plan = await ownPlan(db, viewer, id, today);
  const meta = await checkMeta(db, { title, subjectId: plan.subjectId, roomId: plan.roomId });
  const seats = await db.select().from(sitzplanSeats).where(eq(sitzplanSeats.planId, id));
  const newId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sitzplanPlans)
      .values({
        groupId: plan.groupId,
        ...meta,
        ownerId: viewer.userId,
        schoolYearId: plan.schoolYearId,
        rows: plan.rows,
        cols: plan.cols,
        desks: plan.desks,
        layoutId: plan.layoutId,
        layoutCopiedAt: plan.layoutCopiedAt,
      })
      .returning({ id: sitzplanPlans.id });
    if (seats.length) await tx.insert(sitzplanSeats).values(seats.map((s) => ({ planId: row!.id, studentId: s.studentId, row: s.row, col: s.col })));
    return row!.id;
  });
  await audit(db, viewer.userId, "sitzplan.kopieren", newId, { von: id });
  return newId;
}

export async function deletePlan(db: Db, viewer: PermissionSet, id: string, today: string): Promise<void> {
  const plan = await ownPlan(db, viewer, id, today);
  await db.delete(sitzplanPlans).where(eq(sitzplanPlans.id, id));
  await audit(db, viewer.userId, "sitzplan.loeschen", id, { gruppe: plan.groupId });
}

// ------------------------------------------------------------------ Einbindung (P5-03)

/** Rein: welcher Plan passt am besten zu einer Stunde? Fach und Raum gleich vor „nur Fach“ vor „nur Raum“ vor „allgemein“. */
export function pickPlan<T extends Pick<SitzplanPlan, "subjectId" | "roomId" | "updatedAt">>(plans: readonly T[], lesson: { subjectId: string | null; roomId: string | null }): T | null {
  const score = (p: T) =>
    (p.subjectId === null ? 0 : p.subjectId === lesson.subjectId ? 2 : -10) + (p.roomId === null ? 0 : p.roomId === lesson.roomId ? 1 : -10);
  return (
    [...plans]
      .filter((p) => score(p) >= 0)
      .sort((a, b) => score(b) - score(a) || b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null
  );
}

/**
 * Sitzplan zu einer Stunde (Klassenbuch-Eintrag): sichtbar für Lehrkräfte der Gruppe und für die Person, die die Stunde
 * an dem Tag hält (auch Vertretung) – jeweils mit `sitzplan.edit`.
 */
export async function planForLesson(
  db: Db,
  viewer: PermissionSet,
  lesson: { groupId: string; subjectId: string | null; roomId: string | null; teacherId: string | null },
  today: string,
): Promise<PlanView | null> {
  if (viewer.locked || !hasPermission(viewer, EDIT)) return null;
  if (lesson.teacherId !== viewer.userId && !(await canUseGroup(db, viewer, lesson.groupId, today))) return null;
  const plans = await db.select().from(sitzplanPlans).where(eq(sitzplanPlans.groupId, lesson.groupId)).orderBy(desc(sitzplanPlans.updatedAt));
  const plan = pickPlan(plans, lesson);
  return plan ? buildView(db, plan, { photos: true }) : null;
}

/** Pläne je Gruppe (Kursraum, Tagesleiste) – nur Gruppen, die `viewer` sehen darf. */
export async function plansByGroup(db: Db, viewer: PermissionSet, groupIds: readonly string[], today: string): Promise<Map<string, { id: string; title: string }[]>> {
  const out = new Map<string, { id: string; title: string }[]>();
  if (groupIds.length === 0 || viewer.locked || !hasPermission(viewer, EDIT)) return out;
  const allowed = await teachingGroupIds(db, viewer, today);
  const ids = groupIds.filter((g) => allowed.has(g));
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: sitzplanPlans.id, title: sitzplanPlans.title, groupId: sitzplanPlans.groupId })
    .from(sitzplanPlans)
    .where(inArray(sitzplanPlans.groupId, ids))
    .orderBy(de(sitzplanPlans.title), asc(sitzplanPlans.id));
  for (const r of rows) out.set(r.groupId, [...(out.get(r.groupId) ?? []), { id: r.id, title: r.title }]);
  return out;
}

/** Suche (P5-03): Pläne eigener Gruppen nach Titel oder Gruppenname. */
export async function searchPlans(db: Db, viewer: PermissionSet, q: string, today: string): Promise<{ id: string; title: string; groupName: string }[]> {
  if (viewer.locked || !hasPermission(viewer, EDIT)) return [];
  const ids = [...(await teachingGroupIds(db, viewer, today))];
  if (ids.length === 0) return [];
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db
    .select({ id: sitzplanPlans.id, title: sitzplanPlans.title, groupName: groups.name })
    .from(sitzplanPlans)
    .innerJoin(groups, eq(groups.id, sitzplanPlans.groupId))
    .where(and(inArray(sitzplanPlans.groupId, ids), or(ilike(sitzplanPlans.title, like), ilike(groups.name, like))))
    .orderBy(de(groups.name), de(sitzplanPlans.title))
    .limit(5);
}
