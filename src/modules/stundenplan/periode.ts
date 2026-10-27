// Periode kopieren (P2b-14): Halbjahreswechsel ab Stichtag – laufende Stunden enden am Vortag, eine Kopie gilt ab
// dem Stichtag. Danach lässt sich der neue Plan ändern, ohne die Vergangenheit (Klassenbuch, Vertretungen) anzufassen.
import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { classbookEntries, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { moveChangeHistory } from "./vertretung-historie";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface PeriodPreview {
  cutoff: string;
  /** Stunden, die über den Stichtag laufen und geteilt werden */
  split: number;
  /** Stunden, die schon ab dem Stichtag oder später beginnen (bleiben unverändert) */
  alreadyFuture: number;
  /** Vertretungen und Klassenbuch-Einträge ab dem Stichtag, die auf die Kopie umziehen */
  moved: number;
}

const crossing = (cutoff: string) => and(lt(timetableLessons.validFrom, cutoff), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, cutoff)));

function check(cutoff: string, todayYmd: string) {
  if (!YMD.test(cutoff) || Number.isNaN(Date.parse(`${cutoff}T00:00:00Z`))) throw new ValidationError({ cutoff: "Datum wählen" });
  if (cutoff <= todayYmd) throw new ValidationError({ cutoff: "Der Stichtag muss in der Zukunft liegen" });
}

export async function periodPreview(db: Db, cutoff: string, todayYmd: string): Promise<PeriodPreview> {
  check(cutoff, todayYmd);
  const [split, future] = await Promise.all([
    db.select({ id: timetableLessons.id }).from(timetableLessons).where(crossing(cutoff)),
    db.select({ id: timetableLessons.id }).from(timetableLessons).where(gte(timetableLessons.validFrom, cutoff)),
  ]);
  const ids = split.map((l) => l.id);
  const [subs, entries] = ids.length
    ? await Promise.all([
        db.select({ id: timetableSubstitutions.id }).from(timetableSubstitutions).where(and(inArray(timetableSubstitutions.lessonId, ids), gte(timetableSubstitutions.date, cutoff))),
        db.select({ id: classbookEntries.id }).from(classbookEntries).where(and(inArray(classbookEntries.lessonId, ids), gte(classbookEntries.date, cutoff))),
      ])
    : [[], []];
  return { cutoff, split: ids.length, alreadyFuture: future.length, moved: subs.length + entries.length };
}

/**
 * Teilt alle Stunden, die über den Stichtag laufen: die bestehende Zeile endet am Vortag, eine Kopie (mit neuer
 * Kopplungs-id je Kopplung) gilt ab dem Stichtag bis zum bisherigen Ende. Vertretungen und Klassenbuch-Einträge
 * ab dem Stichtag ziehen auf die Kopie um.
 */
export async function copyPeriod(db: Db, actorId: string, cutoff: string, todayYmd: string): Promise<number> {
  check(cutoff, todayYmd);
  const dayBefore = addDays(cutoff, -1);
  const n = await db.transaction(async (tx) => {
    const rows = await tx.select().from(timetableLessons).where(crossing(cutoff));
    if (!rows.length) return 0;
    const couplings = new Map<string, string>();
    const copies = rows.map(({ id, ...l }) => {
      let couplingId: string | null = null;
      if (l.couplingId) {
        if (!couplings.has(l.couplingId)) couplings.set(l.couplingId, crypto.randomUUID());
        couplingId = couplings.get(l.couplingId)!;
      }
      return { oldId: id, row: { ...l, id: crypto.randomUUID(), couplingId, validFrom: cutoff, createdAt: new Date() } };
    });
    await tx.insert(timetableLessons).values(copies.map((c) => c.row));
    await tx.update(timetableLessons).set({ validUntil: dayBefore }).where(inArray(timetableLessons.id, rows.map((r) => r.id)));
    for (const { oldId, row } of copies) {
      await tx.update(timetableSubstitutions).set({ lessonId: row.id }).where(and(eq(timetableSubstitutions.lessonId, oldId), gte(timetableSubstitutions.date, cutoff)));
      await tx.update(classbookEntries).set({ lessonId: row.id }).where(and(eq(classbookEntries.lessonId, oldId), gte(classbookEntries.date, cutoff)));
      // VT-01: die Historie der Vertretungen hängt mit um
      await moveChangeHistory(tx as unknown as Db, oldId, row.id, cutoff);
    }
    return rows.length;
  });
  await audit(db, actorId, "stundenplan.period.copy", null, { cutoff, lessons: n });
  return n;
}
