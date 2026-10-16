// Notenbuch (P5-15, § 120 Abs. 9 SchulG NRW, Art. 15 DSGVO): Auskunft für Schüler:innen lesbar – Teilnoten mit Fach, Lerngruppe,
// Leistung (Spaltentitel), Datum und Kommentar sowie Halbjahreswerte (Vorschlag und festgelegte Note). Für Lehrkräfte die Liste
// der Notenbücher, die sie führen (ohne Noten der Schüler:innen).
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groups, notenbuchBooks, notenbuchBookTeachers, notenbuchColumns, notenbuchEntries, notenbuchTermGrades, schoolYears, subjects } from "@/core/db/schema";
import type { ReadableExport } from "../auskunft";
import { COLUMN_KIND_LABELS, type ColumnKind } from "./berechnung";
import { displayEntry } from "./einsicht";
import { AUSKUNFT, hasNotenbuchRight } from "./service";

export const notenbuchAuskunft: ReadableExport = {
  moduleId: "notenbuch",
  // G5A-S01: Teilnoten, Kommentare und Halbjahreswerte nur, wenn die erzeugende Person ausdrücklich `notenbuch.auskunft` hat
  // (kein Admin-Konto, Q-5A-28) – sonst ohne diesen Teil, mit Hinweis; die Liste der geführten Bücher (ohne Noten) bleibt
  restricted: {
    tables: ["notenbuch_entries", "notenbuch_term_grades"],
    sections: ["noten", "halbjahresnoten"],
    allowed: (perms) => hasNotenbuchRight(perms, AUSKUNFT),
    note: "Notenbuch-Teil (Teilnoten, Kommentare, Halbjahreswerte) nicht enthalten – er wird gesondert durch eine dafür berechtigte Person erteilt (Recht „Notenbuch: Auskunft erteilen“).",
    readAction: "lesen.notenbuch.auskunft",
  },
  async build(db: Db, userId: string) {
    const book = { schuljahr: schoolYears.name, halbjahr: notenbuchBooks.term, fach: subjects.name, lerngruppe: groups.name };
    const [entries, terms, led] = await Promise.all([
      db
        .select({
          ...book,
          leistung: notenbuchColumns.title,
          art: notenbuchColumns.kind,
          datum: notenbuchColumns.date,
          scale: notenbuchBooks.scale,
          maxPoints: notenbuchColumns.maxPoints,
          key: notenbuchColumns.pointsToGrade,
          wert: notenbuchEntries.value,
          kommentar: notenbuchEntries.comment,
          geaendert: notenbuchEntries.updatedAt,
        })
        .from(notenbuchEntries)
        .innerJoin(notenbuchColumns, eq(notenbuchColumns.id, notenbuchEntries.columnId))
        .innerJoin(notenbuchBooks, eq(notenbuchBooks.id, notenbuchColumns.bookId))
        .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
        .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
        .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
        .where(eq(notenbuchEntries.studentId, userId))
        .orderBy(asc(schoolYears.startsOn), asc(notenbuchBooks.term), asc(subjects.name), asc(notenbuchColumns.position)),
      db
        .select({ ...book, vorschlag: notenbuchTermGrades.computed, halbjahresnote: notenbuchTermGrades.final, festgelegt: notenbuchTermGrades.finalizedAt, abgeschlossen: notenbuchBooks.lockedAt })
        .from(notenbuchTermGrades)
        .innerJoin(notenbuchBooks, eq(notenbuchBooks.id, notenbuchTermGrades.bookId))
        .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
        .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
        .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
        .where(eq(notenbuchTermGrades.studentId, userId))
        .orderBy(asc(schoolYears.startsOn), asc(notenbuchBooks.term), asc(subjects.name)),
      db
        .select(book)
        .from(notenbuchBookTeachers)
        .innerJoin(notenbuchBooks, eq(notenbuchBooks.id, notenbuchBookTeachers.bookId))
        .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
        .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
        .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
        .where(eq(notenbuchBookTeachers.teacherId, userId))
        .orderBy(asc(schoolYears.startsOn), asc(notenbuchBooks.term), asc(subjects.name)),
    ]);
    return [
      {
        table: "noten",
        purpose: "Teilnoten aus den Notenbüchern der Lehrkräfte (lesbar: Fach, Leistung, Note, Kommentar)",
        categories: ["Fach und Lerngruppe", "Leistung und Datum", "Note bzw. Punkte", "Kurzkommentar"],
        rows: entries.map(({ scale, maxPoints, key, art, wert, ...e }) => ({
          ...e,
          art: COLUMN_KIND_LABELS[art as ColumnKind] ?? art,
          note: displayEntry(wert, scale, { maxPoints, key: key ?? null }),
        })),
      },
      {
        table: "halbjahresnoten",
        purpose: "Halbjahreswerte aus den Notenbüchern (berechneter Vorschlag und festgelegte Note)",
        categories: ["Fach und Lerngruppe", "Vorschlag", "festgelegte Halbjahresnote"],
        rows: terms,
      },
      {
        table: "notenbuecher",
        purpose: "Notenbücher, die die Person als Lehrkraft führt (ohne Noten der Schüler:innen)",
        categories: ["Lerngruppe", "Fach", "Schuljahr und Halbjahr"],
        rows: led,
      },
    ];
  },
};
