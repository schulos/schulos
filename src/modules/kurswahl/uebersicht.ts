// Kurswahlen (P4-61): Auswahllisten und Zahlen für die Verwaltungsseiten.
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { gradeLevels, kurswahlWahlen, schoolYears, subjects, users, KURSWAHL_KINDS, type KurswahlVerfahren } from "@/core/db/schema";
import { LEVEL_LABELS } from "@/core/school/catalog";
import { KIND_LABEL, targetStudents } from "./service";

export type Option = { value: string; label: string };

export async function formOptions(db: Db) {
  const [grades, years, subjectRows, teachers] = await Promise.all([
    db.select().from(gradeLevels).orderBy(asc(gradeLevels.level)),
    db.select().from(schoolYears).orderBy(asc(schoolYears.startsOn)),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects).orderBy(asc(subjects.sortOrder)),
    db
      .select({ id: users.id, name: users.name, shortCode: users.shortCode })
      .from(users)
      .where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")))
      .orderBy(de(users.lastName), de(users.firstName)),
  ]);
  return {
    kinds: KURSWAHL_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
    grades: grades.map((g) => ({ value: String(g.level), label: g.name })),
    gradeName: new Map(grades.map((g) => [g.level, g.name])),
    gradeCode: new Map(grades.map((g) => [g.level, g.code])),
    years: years.map((y) => ({ value: y.id, label: `${y.name}${y.isCurrent ? " (aktuell)" : ""}` })),
    subjects: subjectRows.map((s) => ({ value: s.id, label: s.name })),
    teachers: teachers.map((t) => ({ value: t.id, label: t.shortCode ? `${t.name} (${t.shortCode})` : t.name })),
    levels: Object.entries(LEVEL_LABELS).map(([value, label]) => ({ value, label: `${value} – ${label}` })),
  };
}

export interface Progress {
  target: number;
  submitted: number;
  /** Zielgruppe je Klasse: Name → Anzahl */
  byClass: { name: string; count: number }[];
}

/** Stand eines Verfahrens: Größe der Zielgruppe (je Klasse) und abgegebene Wahlen. */
export async function progress(db: Db, v: KurswahlVerfahren): Promise<Progress> {
  const target = await targetStudents(db, v);
  const ids = target.map((t) => t.id);
  const [row] = ids.length
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(kurswahlWahlen)
        .where(and(eq(kurswahlWahlen.verfahrenId, v.id), eq(kurswahlWahlen.place, 1), isNotNull(kurswahlWahlen.submittedAt), inArray(kurswahlWahlen.studentId, ids)))
    : [{ n: 0 }];
  const byClass = new Map<string, number>();
  for (const t of target) byClass.set(t.className, (byClass.get(t.className) ?? 0) + 1);
  return { target: target.length, submitted: Number(row?.n ?? 0), byClass: [...byClass].map(([name, count]) => ({ name, count })) };
}
