// Stundenplan: regelmäßige Stunden je Gruppe, beim Lesen auf konkrete Tage aufgefaltet.
import { and, eq, gte, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { groupMembers, groups, parentChild, periods, rooms, subjects, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import { mergeHosts } from "./vertretung-ziel";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { isStaffRole } from "@/core/roles";
import { addDays, isoWeek, weekdayMon0 } from "@/core/time";
import { parentInformedSql } from "@/core/school/majority";
import { de } from "@/core/db/sort";
import { draftDaysBetween } from "./freigabe";
import type { SubstitutionKind, SubstitutionReason } from "./schema";

import { PLAN_MANAGE, PLAN_SUBSTITUTE } from "./rechte";

export type PlanTarget =
  | { kind: "user"; id: string }
  | { kind: "group"; id: string }
  | { kind: "teacher"; id: string }
  | { kind: "room"; id: string };

export interface SlotChange {
  kind: SubstitutionKind;
  substituteId: string | null;
  substituteName: string | null;
  substituteCode: string | null;
  /** neuer Raum, sonst null */
  roomId: string | null;
  note: string | null;
  /**
   * SP-12 (Fachtausch): reguläres Fach, wenn die Vertretung ein anderes Fach gibt („Mathe statt Sport“) – dann tragen
   * `subjectId`/`subjectName`/`color` des Slots bereits das tatsächliche Fach (außer in der Sicht „away“). Sonst null.
   */
  insteadOf?: string | null;
  /** id zu `insteadOf` (reguläres Fach) */
  insteadOfId?: string | null;
  /** SP-12: abweichendes Fach der Vertretung (unabhängig von der Sicht), sonst null */
  subjectId?: string | null;
  subjectName?: string | null;
  /** SP2-07 Verlegung: Stunde, in die die Stunde an diesem Tag rückt */
  targetPeriod?: number | null;
  /** SP2-07 Zusammenlegung: Gruppe, Lehrkraft (Kürzel) und Raum der Stunde, zu der die Gruppe geht */
  mergeWith?: { groupName: string; teacherCode: string | null; roomId: string | null } | null;
  mergeLessonId?: string | null;
  /** VT-02 (F-10-8): öffentliche Grund-Kategorie (grob) */
  reason?: SubstitutionReason | null;
  /** VT-02 (F-10-9): Vertretung nur als Betreuung */
  supervisionOnly?: boolean;
}

export interface LessonSlot {
  lessonId: string;
  date: string;
  weekday: number;
  periodNr: number;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  subjectName: string;
  color: string;
  groupId: string;
  groupName: string;
  teacherId: string | null;
  teacherName: string | null;
  teacherCode: string | null;
  roomId: string | null;
  week: "all" | "A" | "B";
  /** Kopplung, zu der die Stunde gehört */
  couplingId: string | null;
  /** nach mergeCoupled(): alle Gruppen einer zusammengefassten Kopplung */
  coupledGroups?: { id: string; name: string }[];
  /** Vertretung/Entfall/Raumänderung an diesem Tag */
  change?: SlotChange;
  /**
   * Sicht des Betrachters auf die Änderung: „covering“ = er/sie vertritt bzw. die Stunde zieht in diesen Raum,
   * „away“ = die Stunde findet für ihn/sie nicht statt (vertreten durch jemand anderen, in einen anderen Raum verlegt)
   */
  perspective?: "covering" | "away";
  /**
   * SP2-07 Verlegung: „from“ = bisherige Stunde (findet hier nicht statt), „to“ = neue Stunde (`periodNr`/Zeiten sind die neuen,
   * `change.targetPeriod` ebenso, `movedFrom` die bisherige)
   */
  moved?: "from" | "to";
  movedFrom?: number;
  /** SP2-07: Gruppen, die an diesem Tag zu dieser Stunde zusammengelegt sind (Mitbetreuung) */
  joined?: string[];
}

/** A-Woche = ungerade ISO-Kalenderwoche */
export function weekOf(ymd: string): "A" | "B" {
  return isoWeek(ymd) % 2 === 1 ? "A" : "B";
}

export function lessonActiveOn(l: { weekday: number; week: string; validFrom: string; validUntil: string | null }, ymd: string): boolean {
  if (weekdayMon0(ymd) !== l.weekday) return false;
  if (ymd < l.validFrom || (l.validUntil !== null && ymd > l.validUntil)) return false;
  return l.week === "all" || l.week === weekOf(ymd);
}

/** Gruppen-ids, deren Stunden zu einer Person gehören (Mitgliedschaften). */
async function groupIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId));
  return rows.map((r) => r.g);
}

const teacher = alias(users, "teacher");
const substitute = alias(users, "substitute");
const altSubject = alias(subjects, "alt_subject");

function lessonQuery(db: Db) {
  return db
    .select({
      l: timetableLessons,
      subjectName: subjects.name,
      color: subjects.color,
      groupName: groups.name,
      teacherName: teacher.name,
      teacherCode: teacher.shortCode,
      startsAt: periods.startsAt,
      endsAt: periods.endsAt,
    })
    .from(timetableLessons)
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(periods, eq(periods.nr, timetableLessons.periodNr))
    .leftJoin(teacher, eq(teacher.id, timetableLessons.teacherId));
}

/**
 * Alle Stunden für `target` im Zeitraum [fromYmd, toYmd) inkl. Vertretungen, sortiert nach Tag und Stunde.
 * Person: Personal = selbst gehaltene Stunden; Schüler:innen = Stunden aller Gruppen, in denen sie Mitglied sind.
 * Lehrkräfte bekommen Stunden dazu, in denen sie vertreten; Raumpläne Stunden, die in den Raum verlegt wurden.
 */
/** Bedingung für die Stunden eines Plans; `teacherId` = Lehrkraft, deren Vertretungen dazugehören. `null` = keine Stunden. */
async function targetCondition(db: Db, target: PlanTarget): Promise<{ cond: SQL | undefined; teacherId: string | null } | null> {
  if (target.kind === "group") return { cond: eq(timetableLessons.groupId, target.id), teacherId: null };
  if (target.kind === "teacher") return { cond: eq(timetableLessons.teacherId, target.id), teacherId: target.id };
  if (target.kind === "room") return { cond: eq(timetableLessons.roomId, target.id), teacherId: null };
  // Beschäftigte: nur selbst gehaltene Stunden (Klassenleitung heißt nicht, alle Stunden der Klasse zu geben)
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, target.id));
  if (u && isStaffRole(u.role)) return { cond: eq(timetableLessons.teacherId, target.id), teacherId: target.id };
  const gids = await groupIdsOf(db, target.id);
  return gids.length ? { cond: inArray(timetableLessons.groupId, gids), teacherId: null } : null;
}

export async function listSlots(
  db: Db,
  target: PlanTarget,
  fromYmd: string,
  toYmd: string,
  /** Q5-11: Änderungen an Entwurfstagen mitlesen – nur für die Vertretungsplanung (`stundenplan.substitute`); sonst gilt der veröffentlichte Stand */
  opts: { drafts?: boolean } = {},
): Promise<LessonSlot[]> {
  const tc = await targetCondition(db, target);
  if (!tc) return [];
  const { cond, teacherId } = tc;
  const roomId = target.kind === "room" ? target.id : null;
  const lastDay = addDays(toYmd, -1);
  const hidden = opts.drafts ? new Set<string>() : await draftDaysBetween(db, fromYmd, lastDay);
  const inRange = and(lte(timetableLessons.validFrom, lastDay), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, fromYmd)));
  const base = await lessonQuery(db).where(and(cond, inRange));
  const baseIds = new Set(base.map((r) => r.l.id));

  // Stunden, die über eine Vertretung dazukommen (Vertretungslehrkraft bzw. neuer Raum)
  let extra: typeof base = [];
  if (teacherId || roomId) {
    const subCond = teacherId ? eq(timetableSubstitutions.substituteId, teacherId) : eq(timetableSubstitutions.roomId, roomId!);
    const ids = await db
      .selectDistinct({ id: timetableSubstitutions.lessonId, date: timetableSubstitutions.date })
      .from(timetableSubstitutions)
      .where(and(subCond, gte(timetableSubstitutions.date, fromYmd), lte(timetableSubstitutions.date, lastDay)));
    const missing = [...new Set(ids.filter((r) => !hidden.has(r.date)).map((r) => r.id))].filter((id) => !baseIds.has(id));
    if (missing.length) extra = await lessonQuery(db).where(inArray(timetableLessons.id, missing));
  }
  const all = [...base, ...extra];
  const subs = all.length
    ? await db
        .select({ s: timetableSubstitutions, name: substitute.name, code: substitute.shortCode, altName: altSubject.name, altColor: altSubject.color })
        .from(timetableSubstitutions)
        .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
        .leftJoin(altSubject, eq(altSubject.id, timetableSubstitutions.subjectId))
        .where(
          and(
            inArray(timetableSubstitutions.lessonId, all.map((r) => r.l.id)),
            gte(timetableSubstitutions.date, fromYmd),
            lte(timetableSubstitutions.date, lastDay),
          ),
        )
    : [];
  const subOf = new Map(subs.filter((x) => !hidden.has(x.s.date)).map((x) => [`${x.s.lessonId}:${x.s.date}`, x]));
  // SP2-07: Zusammenlegung – wohin die Gruppe geht, und wer zu den eigenen Stunden dazukommt
  const visibleSubs = subs.filter((x) => !hidden.has(x.s.date));
  const hosts = await mergeHosts(
    db,
    visibleSubs.filter((x) => x.s.kind === "merge" && x.s.mergeLessonId).map((x) => ({ lessonId: x.s.mergeLessonId!, date: x.s.date })),
  );
  const joinedRows = all.length
    ? await db
        .select({ host: timetableSubstitutions.mergeLessonId, date: timetableSubstitutions.date, groupName: groups.name })
        .from(timetableSubstitutions)
        .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
        .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
        .where(
          and(
            inArray(timetableSubstitutions.mergeLessonId, all.map((r) => r.l.id)),
            gte(timetableSubstitutions.date, fromYmd),
            lte(timetableSubstitutions.date, lastDay),
          ),
        )
    : [];
  const joinedOf = new Map<string, string[]>();
  for (const j of joinedRows) if (!hidden.has(j.date)) joinedOf.set(`${j.host}:${j.date}`, [...(joinedOf.get(`${j.host}:${j.date}`) ?? []), j.groupName]);
  const periodRows = subs.some((x) => x.s.kind === "move") ? await db.select().from(periods) : [];
  const periodOf = new Map(periodRows.map((p) => [p.nr, p]));

  const cal = await loadSchoolCalendar(db);
  const slots: LessonSlot[] = [];
  for (let d = fromYmd; d < toYmd; d = addDays(d, 1)) {
    // Feiertage, Ferien und unterrichtsfreie Tage: keine Stunden
    if (cal.dayOff(d)) continue;
    for (const r of all) {
      if (!lessonActiveOn(r.l, d)) continue;
      const sub = subOf.get(`${r.l.id}:${d}`);
      let perspective: LessonSlot["perspective"];
      if (!baseIds.has(r.l.id)) {
        // nur über die Vertretung hier: an genau diesem Tag zeigen
        const mine = sub && ((teacherId && sub.s.substituteId === teacherId && sub.s.kind === "substitute") || (roomId && sub.s.roomId === roomId && sub.s.kind !== "cancel"));
        if (!mine) continue;
        perspective = "covering";
      } else if (sub && teacherId && sub.s.kind === "substitute" && sub.s.substituteId !== teacherId) {
        perspective = "away";
      } else if (sub && roomId && sub.s.kind !== "cancel" && sub.s.roomId && sub.s.roomId !== roomId) {
        perspective = "away";
      } else if (sub && teacherId && sub.s.substituteId === teacherId && sub.s.kind === "substitute") {
        perspective = "covering";
      } else if (sub?.s.kind === "merge" && (teacherId || roomId)) {
        // SP2-07: zusammengelegt – Lehrkraft und Raum der Stunde sind frei, die Gruppe ist bei der anderen Stunde
        perspective = "away";
      }
      // SP-12: Vertretung mit anderem Fach – der Slot zeigt das tatsächliche Fach; wer die Stunde abgegeben hat, sieht weiter das eigene
      const alt = sub?.s.kind === "substitute" && sub.s.subjectId && sub.altName && perspective !== "away" ? { id: sub.s.subjectId, name: sub.altName, color: sub.altColor! } : null;
      slots.push({
        lessonId: r.l.id,
        date: d,
        weekday: r.l.weekday,
        periodNr: r.l.periodNr,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        subjectId: alt?.id ?? r.l.subjectId,
        subjectName: alt?.name ?? r.subjectName,
        color: alt?.color ?? r.color,
        groupId: r.l.groupId,
        groupName: r.groupName,
        teacherId: r.l.teacherId,
        teacherName: r.teacherName,
        teacherCode: r.teacherCode,
        roomId: r.l.roomId,
        week: r.l.week,
        couplingId: r.l.couplingId,
        change: sub
          ? {
              kind: sub.s.kind,
              substituteId: sub.s.substituteId,
              substituteName: sub.name,
              substituteCode: sub.code,
              roomId: sub.s.roomId,
              note: sub.s.note,
              insteadOf: alt ? r.subjectName : null,
              insteadOfId: alt ? r.l.subjectId : null,
              subjectId: sub.s.kind === "substitute" ? sub.s.subjectId : null,
              subjectName: sub.s.kind === "substitute" ? sub.altName : null,
              targetPeriod: sub.s.kind === "move" ? sub.s.targetPeriod : null,
              mergeWith: sub.s.kind === "merge" && sub.s.mergeLessonId ? (hosts.get(`${sub.s.mergeLessonId}:${d}`) ?? null) : null,
              mergeLessonId: sub.s.mergeLessonId,
              reason: sub.s.reason,
              supervisionOnly: sub.s.supervisionOnly,
            }
          : undefined,
        perspective,
        ...(joinedOf.has(`${r.l.id}:${d}`) ? { joined: joinedOf.get(`${r.l.id}:${d}`) } : {}),
      });
      // SP2-07 Verlegung: die Stunde steht in der bisherigen Stunde als „verlegt“ und zusätzlich in der neuen
      const target = sub?.s.kind === "move" ? sub.s.targetPeriod : null;
      const p = target !== null ? periodOf.get(target) : undefined;
      if (p) {
        const fromIdx = slots.length - 1;
        const from = slots[fromIdx]!;
        // Raumplan: die neue Stunde nur im Raum, in dem sie stattfindet; die bisherige nur im eigenen Raum
        if (!roomId || (sub!.s.roomId ?? r.l.roomId) === roomId)
          slots.push({ ...from, periodNr: p.nr, startsAt: p.startsAt, endsAt: p.endsAt, perspective: undefined, moved: "to", movedFrom: r.l.periodNr, joined: undefined });
        from.moved = "from";
        from.perspective = "away";
        if (!baseIds.has(r.l.id)) slots.splice(fromIdx, 1);
      }
    }
  }
  return slots.sort((a, b) => a.date.localeCompare(b.date) || a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de"));
}

/**
 * Regelplan: alle Stunden, die am Stichtag gelten – ohne Vertretungen, Ferien und Feiertage, A- und B-Woche zusammen.
 * `date` ist der Tag der Stichtagswoche (für die Anzeige im Wochenraster).
 */
export async function regularSlots(db: Db, target: PlanTarget, refYmd: string): Promise<LessonSlot[]> {
  const tc = await targetCondition(db, target);
  if (!tc) return [];
  return regularSlotsWhere(db, tc.cond, refYmd);
}

/** SP2-10: Regelplan der ganzen Schule (alle Gruppen, alle Lehrkräfte) – Grundlage der Gesamtübersichten. */
export async function allRegularSlots(db: Db, refYmd: string): Promise<LessonSlot[]> {
  return regularSlotsWhere(db, undefined, refYmd);
}

async function regularSlotsWhere(db: Db, cond: SQL | undefined, refYmd: string): Promise<LessonSlot[]> {
  const valid = and(lte(timetableLessons.validFrom, refYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, refYmd)));
  const rows = await lessonQuery(db).where(and(cond, valid));
  const monday = addDays(refYmd, -weekdayMon0(refYmd));
  return rows
    .map((r) => ({
      lessonId: r.l.id,
      date: addDays(monday, r.l.weekday),
      weekday: r.l.weekday,
      periodNr: r.l.periodNr,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      subjectId: r.l.subjectId,
      subjectName: r.subjectName,
      color: r.color,
      groupId: r.l.groupId,
      groupName: r.groupName,
      teacherId: r.l.teacherId,
      teacherName: r.teacherName,
      teacherCode: r.teacherCode,
      roomId: r.l.roomId,
      week: r.l.week,
      couplingId: r.l.couplingId,
    }))
    .sort((a, b) => a.weekday - b.weekday || a.periodNr - b.periodNr || a.week.localeCompare(b.week) || a.groupName.localeCompare(b.groupName, "de"));
}

/** Wessen Plan zeigt „Mein Stundenplan"? Schüler:innen und Lehrkräfte sich selbst, Eltern ihre Kinder. */
export async function planOwners(db: Db, viewer: PermissionSet): Promise<{ id: string; name: string }[]> {
  if (viewer.role === "eltern") {
    return db
      .select({ id: users.id, name: users.name })
      .from(parentChild)
      .innerJoin(users, eq(users.id, parentChild.childId))
      .where(and(eq(parentChild.parentId, viewer.userId), parentInformedSql()))
      .orderBy(de(users.firstName));
  }
  if (viewer.role === "schueler" || viewer.role === "lehrkraft") {
    const [me] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, viewer.userId));
    return me ? [me] : [];
  }
  return [];
}

/** SP-05: Alle Pläne sehen Beschäftigte der Schule (`isStaffRole`) und wer plant (Planungsrecht) – unabhängig von der Rolle. */
export function seesAllPlans(viewer: PermissionSet): boolean {
  return isStaffRole(viewer.role) || hasPermission(viewer, PLAN_MANAGE) || hasPermission(viewer, PLAN_SUBSTITUTE);
}

/** Darf der Betrachter diesen Plan sehen? Beschäftigte und Planung alles; sonst eigener Plan, Plan der Kinder, eigene Gruppen. */
export async function canViewPlan(db: Db, viewer: PermissionSet, target: PlanTarget): Promise<boolean> {
  if (seesAllPlans(viewer)) return true;
  if (target.kind === "user") return (await planOwners(db, viewer)).some((o) => o.id === target.id);
  if (target.kind === "group") return viewer.memberOf.has(target.id);
  return false;
}

/** Stammdaten für Auswahllisten (Verwaltung, Plan-Ansichten); nur aktive Räume. */
export async function timetableMasterData(db: Db) {
  const [ps, subs, rs] = await Promise.all([
    db.select().from(periods).orderBy(periods.nr),
    db.select().from(subjects).orderBy(subjects.sortOrder, subjects.name),
    db.select().from(rooms).where(eq(rooms.active, true)).orderBy(rooms.id),
  ]);
  return { periods: ps, subjects: subs, rooms: rs };
}
