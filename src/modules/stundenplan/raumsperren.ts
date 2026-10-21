// Raumsperrungen (P2b-17): Raum im Zeitraum (ganztägig oder einzelne Stunden) gesperrt → betroffene Stunden mit
// Ausweichraum-Vorschlägen nach Passung (Art, Nähe, Größe).
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groupMembers, groups, periods, rooms, subjects, timetableLessons, timetableRoomBlocks, timetableSubstitutions, users } from "@/core/db/schema";
import { ROOM_BLOCK_REASONS, type RoomBlockReason } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { blockCovers, listRooms, occupancyOn, searchRooms, type RoomBlock, type RoomHit, type RoomInfo } from "./raeume";
import { lessonActiveOn, listSlots } from "./service";

export { blockCovers, blockLabel, ROOM_BLOCK_LABELS, type RoomBlock } from "./raeume";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface RoomBlockInput {
  roomId: string;
  startsOn: string;
  endsOn: string;
  fromPeriod: number | null;
  toPeriod: number | null;
  reason: string;
  note: string | null;
}

export async function createRoomBlock(db: Db, actorId: string, input: RoomBlockInput): Promise<string> {
  const fe: Record<string, string> = {};
  const note = input.note?.trim() || null;
  if (!YMD.test(input.startsOn)) fe.startsOn = "Datum angeben";
  if (!YMD.test(input.endsOn)) fe.endsOn = "Datum angeben";
  else if (YMD.test(input.startsOn) && input.endsOn < input.startsOn) fe.endsOn = "Ende liegt vor dem Beginn";
  if (!(ROOM_BLOCK_REASONS as readonly string[]).includes(input.reason)) fe.reason = "Grund wählen";
  if (note && note.length > 80) fe.note = "höchstens 80 Zeichen";
  const [[room], ps] = await Promise.all([db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, input.roomId)), db.select({ nr: periods.nr }).from(periods)]);
  if (!room) fe.roomId = "Raum wählen";
  const nrs = new Set(ps.map((p) => p.nr));
  if ((input.fromPeriod === null) !== (input.toPeriod === null)) fe.toPeriod = "Beide Stunden angeben oder keine (ganzer Tag)";
  else if (input.fromPeriod !== null && input.toPeriod !== null) {
    if (!nrs.has(input.fromPeriod) || !nrs.has(input.toPeriod)) fe.fromPeriod = "Stunde wählen";
    else if (input.toPeriod < input.fromPeriod) fe.toPeriod = "„bis“ liegt vor „von“";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db
    .insert(timetableRoomBlocks)
    .values({ roomId: input.roomId, startsOn: input.startsOn, endsOn: input.endsOn, fromPeriod: input.fromPeriod, toPeriod: input.toPeriod, reason: input.reason as RoomBlockReason, note, createdBy: actorId })
    .returning({ id: timetableRoomBlocks.id });
  await audit(db, actorId, "stundenplan.roomblock.create", null, { room: input.roomId, from: input.startsOn, to: input.endsOn, reason: input.reason });
  return row!.id;
}

export async function deleteRoomBlock(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableRoomBlocks).where(eq(timetableRoomBlocks.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.roomblock.delete", null, { room: old.roomId, from: old.startsOn, to: old.endsOn });
}

/**
 * Sperrung vorzeitig beenden (P4-14, Mangel behoben): ab heute ist der Raum wieder frei. Beginnt die Sperrung erst heute
 * oder später, fällt sie ganz weg; sonst endet sie gestern. Liefert, was passiert ist (null = gab es nicht/schon vorbei).
 */
export async function endRoomBlock(db: Db, actorId: string, id: string, todayYmd: string): Promise<"deleted" | "shortened" | null> {
  const [b] = await db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.id, id));
  if (!b || b.endsOn < todayYmd) return null;
  if (b.startsOn >= todayYmd) {
    await deleteRoomBlock(db, actorId, id);
    return "deleted";
  }
  const endsOn = addDays(todayYmd, -1);
  await db.update(timetableRoomBlocks).set({ endsOn }).where(eq(timetableRoomBlocks.id, id));
  await audit(db, actorId, "stundenplan.roomblock.end", null, { room: b.roomId, from: b.startsOn, to: endsOn });
  return "shortened";
}

/**
 * Wer unterrichtet im Zeitraum in diesen Räumen? (P4-17, Wartungstermine) – Lehrkräfte der Stunden, die sich mit dem
 * Zeitraum überschneiden, einschließlich Vertretungen und in den Raum verlegter Stunden; entfallene zählen nicht.
 */
export async function teachersInRooms(db: Db, roomIds: readonly string[], from: Date, to: Date): Promise<string[]> {
  const ids = new Set<string>();
  const fromYmd = toBerlinDate(from);
  const toYmd = addDays(toBerlinDate(to), 1);
  for (const roomId of new Set(roomIds)) {
    // Planung: Entwürfe (Q5-11) zählen mit – lieber eine Lehrkraft zu viel informieren
    for (const s of await listSlots(db, { kind: "room", id: roomId }, fromYmd, toYmd, { drafts: true })) {
      if (s.perspective === "away" || s.change?.kind === "cancel") continue;
      const start = fromBerlinLocal(`${s.date}T${s.startsAt.slice(0, 5)}`);
      const end = fromBerlinLocal(`${s.date}T${s.endsAt.slice(0, 5)}`);
      if (end <= from || start >= to) continue;
      const teacher = s.change?.kind === "substitute" ? s.change.substituteId : s.teacherId;
      if (teacher) ids.add(teacher);
    }
  }
  return [...ids];
}

/** Sperrungen, die am oder nach `fromYmd` enden (laufende und künftige). */
export async function listRoomBlocks(db: Db, fromYmd: string): Promise<RoomBlock[]> {
  return db
    .select({
      id: timetableRoomBlocks.id,
      roomId: timetableRoomBlocks.roomId,
      startsOn: timetableRoomBlocks.startsOn,
      endsOn: timetableRoomBlocks.endsOn,
      fromPeriod: timetableRoomBlocks.fromPeriod,
      toPeriod: timetableRoomBlocks.toPeriod,
      reason: timetableRoomBlocks.reason,
      note: timetableRoomBlocks.note,
    })
    .from(timetableRoomBlocks)
    .where(gte(timetableRoomBlocks.endsOn, fromYmd))
    .orderBy(asc(timetableRoomBlocks.startsOn), asc(timetableRoomBlocks.roomId));
}

/** Sperrungen, die `date` berühren. */
export async function blocksOn(db: Db, date: string): Promise<RoomBlock[]> {
  return (await listRoomBlocks(db, date)).filter((b) => b.startsOn <= date);
}

/** Ist der Raum an diesem Tag in dieser Stunde gesperrt? Liefert die Sperrung. */
export async function roomBlockAt(db: Db, roomId: string, date: string, periodNr: number): Promise<RoomBlock | null> {
  const rows = await db
    .select()
    .from(timetableRoomBlocks)
    .where(and(eq(timetableRoomBlocks.roomId, roomId), lte(timetableRoomBlocks.startsOn, date), gte(timetableRoomBlocks.endsOn, date)));
  return rows.find((b) => blockCovers(b, date, periodNr)) ?? null;
}

// ---------------------------------------------------------------- Ausweichräume

/**
 * Rein: Ausweichräume nach Passung – gleiche Raumart wie der gesperrte Raum, dann gleiches Gebäude, gleiche Etage,
 * dann die kleinste ausreichende Größe.
 */
export function rankAlternatives(original: RoomInfo | undefined, hits: RoomHit[]): RoomHit[] {
  const score = (r: RoomHit) =>
    (original && r.kind === original.kind ? 0 : 100) +
    (original?.building && r.building === original.building ? 0 : 10) +
    (original?.floor && r.floor === original.floor && r.building === original.building ? 0 : 1);
  return [...hits].sort((a, b) => score(a) - score(b) || (a.capacity ?? 9999) - (b.capacity ?? 9999) || a.id.localeCompare(b.id, "de", { numeric: true }));
}

export interface AffectedLesson {
  lessonId: string;
  date: string;
  periodNr: number;
  groupName: string;
  subjectName: string;
  teacherCode: string | null;
  roomId: string;
  block: RoomBlock;
  /** schon eine Raumänderung in einen anderen Raum eingetragen? */
  resolved: boolean;
  suggestions: RoomHit[];
}

/**
 * Stunden der nächsten `days` Tage ab `fromYmd`, deren Raum gesperrt ist (Vertretungsbedarf), mit bis zu drei
 * Ausweichräumen. Stunden mit Entfall zählen nicht; eine Raumänderung in einen freien Raum gilt als erledigt.
 */
export async function affectedLessons(db: Db, fromYmd: string, days = 14): Promise<AffectedLesson[]> {
  const toYmd = addDays(fromYmd, days - 1);
  const blocks = (await listRoomBlocks(db, fromYmd)).filter((b) => b.startsOn <= toYmd);
  if (!blocks.length) return [];
  const blockedRooms = [...new Set(blocks.map((b) => b.roomId))];
  const [lessonRows, roomList, sizes, cal] = await Promise.all([
    db
      .select({ l: timetableLessons, groupName: groups.name, subjectName: subjects.name, teacherCode: users.shortCode })
      .from(timetableLessons)
      .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
      .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
      .leftJoin(users, eq(users.id, timetableLessons.teacherId)),
    listRooms(db),
    db.select({ groupId: groupMembers.groupId, userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.role, "member")),
    loadSchoolCalendar(db),
  ]);
  const sizeOf = new Map<string, number>();
  for (const s of sizes) sizeOf.set(s.groupId, (sizeOf.get(s.groupId) ?? 0) + 1);
  const roomOf = new Map(roomList.map((r) => [r.id, r]));
  const periodNrs = (await db.select({ nr: periods.nr }).from(periods)).map((p) => p.nr);
  const out: AffectedLesson[] = [];
  for (let d = fromYmd; d <= toYmd; d = addDays(d, 1)) {
    if (cal.dayOff(d)) continue;
    const dayBlocks = blocks.filter((b) => b.startsOn <= d && b.endsOn >= d);
    if (!dayBlocks.length) continue;
    const active = lessonRows.filter((r) => lessonActiveOn(r.l, d));
    if (!active.length) continue;
    const subs = await db
      .select({ lessonId: timetableSubstitutions.lessonId, kind: timetableSubstitutions.kind, roomId: timetableSubstitutions.roomId })
      .from(timetableSubstitutions)
      .where(and(eq(timetableSubstitutions.date, d), inArray(timetableSubstitutions.lessonId, active.map((r) => r.l.id))));
    const subOf = new Map(subs.map((s) => [s.lessonId, s]));
    let occ: Awaited<ReturnType<typeof occupancyOn>>["occupancy"] | null = null;
    for (const r of active) {
      if (!r.l.roomId || !blockedRooms.includes(r.l.roomId)) continue;
      const sub = subOf.get(r.l.id);
      // SP2-07: verlegte und zusammengelegte Stunden liegen nicht im gesperrten Raum zu dieser Zeit
      if (sub && sub.kind !== "substitute" && sub.kind !== "room") continue;
      const block = dayBlocks.find((b) => b.roomId === r.l.roomId && blockCovers(b, d, r.l.periodNr));
      if (!block) continue;
      const movedTo = sub?.roomId && sub.roomId !== r.l.roomId ? sub.roomId : null;
      occ ??= (await occupancyOn(db, d)).occupancy;
      const hits = movedTo ? [] : searchRooms(roomList, occ, { periodNrs: [r.l.periodNr], minCapacity: sizeOf.get(r.l.groupId) || null }, periodNrs);
      out.push({
        lessonId: r.l.id,
        date: d,
        periodNr: r.l.periodNr,
        groupName: r.groupName,
        subjectName: r.subjectName,
        teacherCode: r.teacherCode,
        roomId: r.l.roomId,
        block,
        resolved: Boolean(movedTo),
        suggestions: rankAlternatives(roomOf.get(r.l.roomId), hits).slice(0, 3),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de", { numeric: true }));
}
