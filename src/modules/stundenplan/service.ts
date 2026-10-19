// Stundenplan: regelmäßige Stunden je Gruppe, beim Lesen auf konkrete Tage aufgefaltet.
import { and, eq, gte, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { groupMembers, groups, parentChild, periods, rooms, subjects, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import type { PermissionSet } from "@/core/permissions";
import { addDays, isoWeek, weekdayMon0 } from "@/core/time";
import { parentInformedSql } from "@/core/school/majority";
import { de } from "@/core/db/sort";
import { draftDaysBetween } from "./freigabe";

const STAFF = ["lehrkraft", "verwaltung", "admin"];

export type PlanTarget =
  | { kind: "user"; id: string }
  | { kind: "group"; id: string }
  | { kind: "teacher"; id: string }
  | { kind: "room"; id: string };

export interface SlotChange {
  kind: "cancel" | "substitute" | "room";
  substituteId: string | null;
  substituteName: string | null;
  substituteCode: string | null;
  /** neuer Raum, sonst null */
  roomId: string | null;
  note: string | null;
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
  // Personal: nur selbst gehaltene Stunden (Klassenleitung heißt nicht, alle Stunden der Klasse zu geben)
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, target.id));
  if (u && STAFF.includes(u.role)) return { cond: eq(timetableLessons.teacherId, target.id), teacherId: target.id };
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
        .select({ s: timetableSubstitutions, name: substitute.name, code: substitute.shortCode })
        .from(timetableSubstitutions)
        .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
        .where(
          and(
            inArray(timetableSubstitutions.lessonId, all.map((r) => r.l.id)),
            gte(timetableSubstitutions.date, fromYmd),
            lte(timetableSubstitutions.date, lastDay),
          ),
        )
    : [];
  const subOf = new Map(subs.filter((x) => !hidden.has(x.s.date)).map((x) => [`${x.s.lessonId}:${x.s.date}`, x]));

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
      }
      slots.push({
        lessonId: r.l.id,
        date: d,
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
        change: sub
          ? { kind: sub.s.kind, substituteId: sub.s.substituteId, substituteName: sub.name, substituteCode: sub.code, roomId: sub.s.roomId, note: sub.s.note }
          : undefined,
        perspective,
      });
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
  const valid = and(lte(timetableLessons.validFrom, refYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, refYmd)));
  const rows = await lessonQuery(db).where(and(tc.cond, valid));
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

/** Darf der Betrachter diesen Plan sehen? Personal alles; sonst eigener Plan, Plan der Kinder, eigene Gruppen. */
export async function canViewPlan(db: Db, viewer: PermissionSet, target: PlanTarget): Promise<boolean> {
  if (STAFF.includes(viewer.role)) return true;
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
