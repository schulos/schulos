// SP2-07: Ziel einer Zusammenlegung – Gruppe, mitbetreuende Lehrkraft und Raum der Stunde, zu der eine Gruppe geht.
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { groups, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";

export interface MergeTarget {
  groupName: string;
  teacherCode: string | null;
  roomId: string | null;
}

/** SP2-07: Gruppe, mitbetreuende Lehrkraft (eigene bzw. Vertretung) und Raum der Stunden, zu denen zusammengelegt ist – je `lessonId:date`. */
export async function mergeHosts(db: Db, refs: readonly { lessonId: string; date: string }[]): Promise<Map<string, MergeTarget>> {
  const out = new Map<string, MergeTarget>();
  if (refs.length === 0) return out;
  const teacher = alias(users, "teacher");
  const lessons = await db
    .select({ id: timetableLessons.id, roomId: timetableLessons.roomId, groupName: groups.name, teacherCode: teacher.shortCode })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .leftJoin(teacher, eq(teacher.id, timetableLessons.teacherId))
    .where(inArray(timetableLessons.id, [...new Set(refs.map((r) => r.lessonId))]));
  const substitute = alias(users, "substitute");
  const subs = await db
    .select({ lessonId: timetableSubstitutions.lessonId, date: timetableSubstitutions.date, kind: timetableSubstitutions.kind, roomId: timetableSubstitutions.roomId, code: substitute.shortCode })
    .from(timetableSubstitutions)
    .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
    .where(and(inArray(timetableSubstitutions.lessonId, [...new Set(refs.map((r) => r.lessonId))]), inArray(timetableSubstitutions.date, [...new Set(refs.map((r) => r.date))])));
  for (const ref of refs) {
    const h = lessons.find((x) => x.id === ref.lessonId);
    if (!h) continue;
    const hs = subs.find((x) => x.lessonId === ref.lessonId && x.date === ref.date);
    out.set(`${ref.lessonId}:${ref.date}`, {
      groupName: h.groupName,
      teacherCode: hs?.kind === "substitute" ? hs.code : h.teacherCode,
      roomId: hs?.roomId ?? h.roomId,
    });
  }
  return out;
}
