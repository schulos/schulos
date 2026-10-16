// Wirkung von Entscheidungen auf das Klassenbuch: Meldungen und Beurlaubungen setzen die Fehlstunden im Zeitraum.
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { absenceLeaveRequests, classbookAbsences, classbookEntries } from "@/core/db/schema";

/** Setzt „entschuldigt“ an allen Fehlstunden (nicht Verspätungen) im Zeitraum. */
export async function applyToClassbook(db: Db, studentId: string, from: string, to: string, excused: boolean) {
  const entries = await db
    .select({ id: classbookEntries.id })
    .from(classbookEntries)
    .where(and(gte(classbookEntries.date, from), lte(classbookEntries.date, to)));
  if (entries.length === 0) return;
  await db
    .update(classbookAbsences)
    .set({ excused })
    .where(and(eq(classbookAbsences.studentId, studentId), eq(classbookAbsences.kind, "absent"), inArray(classbookAbsences.entryId, entries.map((e) => e.id))));
}

/** Schüler:innen aus der Liste mit genehmigter Beurlaubung an diesem Tag (Q5-16; Klassenbuch zeigt „beurlaubt“). */
export async function onLeave(db: Db, studentIds: readonly string[], date: string): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await db
    .select({ studentId: absenceLeaveRequests.studentId })
    .from(absenceLeaveRequests)
    .where(
      and(
        inArray(absenceLeaveRequests.studentId, [...studentIds]),
        eq(absenceLeaveRequests.status, "genehmigt"),
        lte(absenceLeaveRequests.fromDate, date),
        gte(absenceLeaveRequests.toDate, date),
      ),
    );
  return new Set(rows.map((r) => r.studentId));
}
