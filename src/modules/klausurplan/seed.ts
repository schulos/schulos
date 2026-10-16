// Demo-Klausurplan: drei Arbeiten in der kommenden Woche, regelkonform – jeweils in den Stunden, in denen das Fach
// laut (vom Solver erzeugtem) Stundenplan liegt.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { exams, timetableLessons } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";

interface Spec {
  groupId: string;
  subjectId: string;
  kind: "klassenarbeit" | "klausur";
  title: string;
  /** bevorzugter Tag (0 = Montag) */
  day: number;
  /** Länge in Stunden */
  length: number;
  roomId?: string;
}

const SPECS: Spec[] = [
  { groupId: "g-7b", subjectId: "M", kind: "klassenarbeit", title: "2. Klassenarbeit", day: 1, length: 2 },
  { groupId: "g-9a", subjectId: "D", kind: "klassenarbeit", title: "1. Klassenarbeit", day: 3, length: 2 },
  { groupId: "g-q1-e-gk1", subjectId: "E", kind: "klausur", title: "Klausur 1", day: 2, length: 3 },
];

export async function seedKlausurplan(db: Db, now = new Date()) {
  // kommende Woche – liegt sie in den Ferien, die erste Schulwoche danach; einzelne Feiertage überspringen
  const cal = await loadSchoolCalendar(db);
  const next = mondayOf(cal.nextSchoolDay(addDays(mondayOf(toBerlinDate(now)), 7)));
  const rows: (typeof exams.$inferInsert)[] = [];
  const used = new Set<string>();
  for (const spec of SPECS) {
    const lessons = await db
      .select()
      .from(timetableLessons)
      .where(and(eq(timetableLessons.groupId, spec.groupId), eq(timetableLessons.subjectId, spec.subjectId)));
    // ab dem bevorzugten Tag der erste Schultag (ohne zweite Arbeit an dem Tag), an dem das Fach liegt
    for (let k = 0; k < 5; k++) {
      const date = cal.nextSchoolDay(addDays(next, (spec.day + k) % 5));
      if (used.has(date)) continue;
      const here = lessons.filter((l) => l.weekday === weekdayMon0(date)).sort((a, b) => a.periodNr - b.periodNr);
      if (!here.length) continue;
      const from = here[0]!;
      rows.push({
        groupId: spec.groupId,
        subjectId: spec.subjectId,
        kind: spec.kind,
        title: spec.title,
        date,
        periodFrom: from.periodNr,
        periodTo: from.periodNr + spec.length - 1,
        teacherId: from.teacherId,
        roomId: spec.roomId ?? null,
      });
      used.add(date);
      break;
    }
  }
  if (rows.length) await db.insert(exams).values(rows);
}
