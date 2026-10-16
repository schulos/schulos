// Vertretungsplan Entwurf/Freigabe (Q5-11, I-25, F-06). Modus „sofort“ (Vorgabe): jede Änderung gilt sofort, wie bisher.
// Modus „erst nach Freigabe“: die erste Änderung an einem Tag ohne bisherige Änderungen legt den Tag als Entwurf an
// (`timetable_substitution_days` ohne `published_at`). Solange er Entwurf ist, sehen nur Personen mit `stundenplan.manage`
// seine Änderungen; Schüler:innen, Eltern, Lehrkräfte, Monitore, Kursraum, Klassenbuch und Hausaufgaben-Fälligkeit lesen
// den veröffentlichten Stand (= Regelplan für diesen Tag). Veröffentlichen schickt die gebündelte Tagesnachricht (Q5-03);
// spätere Änderungen an einem veröffentlichten Tag gehen sofort raus. Ein Wechsel zurück auf „sofort“ veröffentlicht keine
// Entwürfe stillschweigend (sonst ohne Gong sichtbar) – sie bleiben, bis jemand sie veröffentlicht.
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableSubstitutionDays, timetableSubstitutions } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { SUBSTITUTION_RELEASE } from "./settings";

export type ReleaseMode = "sofort" | "freigabe";

export async function releaseMode(db: Db): Promise<ReleaseMode> {
  return (await readModuleSetting(db, SUBSTITUTION_RELEASE)) === "freigabe" ? "freigabe" : "sofort";
}

/** Welche dieser Tage sind (noch) Entwurf? */
export async function draftDays(db: Db, dates: readonly string[]): Promise<Set<string>> {
  if (dates.length === 0) return new Set();
  const rows = await db
    .select({ date: timetableSubstitutionDays.date })
    .from(timetableSubstitutionDays)
    .where(and(inArray(timetableSubstitutionDays.date, [...new Set(dates)]), isNull(timetableSubstitutionDays.publishedAt)));
  return new Set(rows.map((r) => r.date));
}

/** Entwürfe in einem Zeitraum [from, to] (to einschließlich) – für Seiten, die viele Tage lesen. */
export async function draftDaysBetween(db: Db, from: string, to: string): Promise<Set<string>> {
  const rows = await db
    .select({ date: timetableSubstitutionDays.date })
    .from(timetableSubstitutionDays)
    .where(and(gte(timetableSubstitutionDays.date, from), lte(timetableSubstitutionDays.date, to), isNull(timetableSubstitutionDays.publishedAt)));
  return new Set(rows.map((r) => r.date));
}

export async function isDraftDay(db: Db, date: string): Promise<boolean> {
  return (await draftDays(db, [date])).has(date);
}

/** Offene Entwürfe ab heute (für die Planung: „nicht veröffentlicht“). */
export async function openDrafts(db: Db, fromYmd: string): Promise<string[]> {
  const rows = await db
    .select({ date: timetableSubstitutionDays.date })
    .from(timetableSubstitutionDays)
    .where(and(gte(timetableSubstitutionDays.date, fromYmd), isNull(timetableSubstitutionDays.publishedAt)))
    .orderBy(asc(timetableSubstitutionDays.date));
  return rows.map((r) => r.date);
}

export interface DayRelease {
  mode: ReleaseMode;
  /** Tag ist Entwurf (nur für die Planung sichtbar) */
  draft: boolean;
  publishedAt: Date | null;
}

export async function dayRelease(db: Db, date: string): Promise<DayRelease> {
  const [mode, [row]] = await Promise.all([releaseMode(db), db.select().from(timetableSubstitutionDays).where(eq(timetableSubstitutionDays.date, date))]);
  return { mode, draft: !!row && !row.publishedAt, publishedAt: row?.publishedAt ?? null };
}

/**
 * Vor dem Speichern einer Änderung: im Modus „Freigabe“ wird ein Tag ohne Status und ohne bisherige Änderungen zum Entwurf.
 * Hat der Tag schon Änderungen (veröffentlicht oder aus dem Modus „sofort“), bleibt er veröffentlicht – sonst verschwänden
 * bereits bekanntgegebene Änderungen wieder. Gibt zurück, ob der Tag danach Entwurf ist.
 */
export async function startDraftIfNeeded(db: Db, actorId: string, date: string): Promise<boolean> {
  const [row] = await db.select().from(timetableSubstitutionDays).where(eq(timetableSubstitutionDays.date, date));
  if (row) return !row.publishedAt;
  if ((await releaseMode(db)) !== "freigabe") return false;
  const [existing] = await db.select({ id: timetableSubstitutions.id }).from(timetableSubstitutions).where(eq(timetableSubstitutions.date, date)).limit(1);
  if (existing) return false;
  await db.insert(timetableSubstitutionDays).values({ date, createdBy: actorId }).onConflictDoNothing();
  return isDraftDay(db, date);
}
