// Schulbücherei – offene Posten für Schuljahreswechsel (B-08) und Abgang (B-02), BU-13. Nur Zahlen, keine Titel: Wer den
// Wechsel bzw. den Abgang bearbeitet (Verwaltung), erfährt, dass noch etwas offen ist, und findet die Einzelheiten in der
// Bücherei (Theke, Schulbuchausgabe, Ersatzforderungen – dort mit den jeweiligen Rechten). Offene Posten blockieren nichts:
// Abgang und Löschung laufen weiter (docs/BUECHEREI.md „Abgang“); die Person verliert mit der Kontolöschung nur den Bezug.
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { buechereiCompensations, buechereiLoans, buechereiMaterialIssues } from "@/core/db/schema";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { lernmittelEnabled } from "./lernmittel";
import buecherei from "./manifest";

export interface OpenItems {
  /** offene Ausleihen der Bücherei (Stufe 1) */
  loans: number;
  /** ausgegebene, nicht zurückgenommene Schulbücher */
  schoolbooks: number;
  /** offene Ersatzforderungen */
  compensations: number;
}

export const noOpenItems = (o: OpenItems) => o.loans + o.schoolbooks + o.compensations === 0;

/** Rein: „2 Ausleihen, 1 Schulbuch, 1 Ersatzforderung“ – leere Teile entfallen. */
export function openItemsText(o: OpenItems): string {
  const parts = [
    o.loans ? (o.loans === 1 ? "1 Ausleihe" : `${o.loans} Ausleihen`) : null,
    o.schoolbooks ? (o.schoolbooks === 1 ? "1 Schulbuch" : `${o.schoolbooks} Schulbücher`) : null,
    o.compensations ? (o.compensations === 1 ? "1 offene Ersatzforderung" : `${o.compensations} offene Ersatzforderungen`) : null,
  ].filter(Boolean);
  return parts.join(", ");
}

async function moduleOn(db: Db): Promise<boolean> {
  return isEnabled(buecherei, await loadModuleStates(db));
}

/** Offene Posten je Person (nur Zahlen); Modul aus → leere Map. Schulbücher/Forderungen nur mit Schulbuchausleihe. */
export async function openItemsOf(db: Db, userIds: readonly string[]): Promise<Map<string, OpenItems>> {
  const out = new Map<string, OpenItems>();
  if (!userIds.length || !(await moduleOn(db))) return out;
  const ids = [...userIds];
  const stage2 = await lernmittelEnabled(db);
  const [loans, books, comps] = await Promise.all([
    db
      .select({ userId: buechereiLoans.userId, n: count() })
      .from(buechereiLoans)
      .where(and(inArray(buechereiLoans.userId, ids), isNull(buechereiLoans.returnedOn)))
      .groupBy(buechereiLoans.userId),
    stage2
      ? db
          .select({ userId: buechereiMaterialIssues.userId, n: count() })
          .from(buechereiMaterialIssues)
          .where(and(inArray(buechereiMaterialIssues.userId, ids), isNull(buechereiMaterialIssues.returnedOn)))
          .groupBy(buechereiMaterialIssues.userId)
      : [],
    stage2
      ? db
          .select({ userId: buechereiCompensations.userId, n: count() })
          .from(buechereiCompensations)
          .where(and(inArray(buechereiCompensations.userId, ids), eq(buechereiCompensations.status, "offen")))
          .groupBy(buechereiCompensations.userId)
      : [],
  ]);
  const get = (id: string) => out.get(id) ?? out.set(id, { loans: 0, schoolbooks: 0, compensations: 0 }).get(id)!;
  for (const r of loans) get(r.userId!).loans = r.n;
  for (const r of books) get(r.userId!).schoolbooks = r.n;
  for (const r of comps) get(r.userId!).compensations = r.n;
  return out;
}

export interface YearEndCheck {
  /** Schulbücher aus dem endenden Schuljahr, die noch nicht zurück sind */
  schoolbooks: number;
  /** Personen mit solchen Schulbüchern */
  people: number;
  /** davon vorgemerkte Abgänger:innen */
  leavers: number;
  /** offene Ersatzforderungen insgesamt */
  compensations: number;
}

/**
 * Prüfschritt „offene Schulbücher“ im Schuljahreswechsel (B-08): Schulbücher aus dem endenden Schuljahr, die noch nicht
 * zurückgenommen sind, wie viele Personen und Abgänger:innen es betrifft, offene Ersatzforderungen. Nur Zahlen; null, wenn die
 * Bücherei oder die Schulbuchausleihe aus ist.
 */
export async function yearEndCheck(db: Db, fromYearId: string, leavers: readonly string[]): Promise<YearEndCheck | null> {
  if (!(await moduleOn(db)) || !(await lernmittelEnabled(db))) return null;
  const [rows, [comps]] = await Promise.all([
    db
      .select({ userId: buechereiMaterialIssues.userId })
      .from(buechereiMaterialIssues)
      .where(and(eq(buechereiMaterialIssues.schoolYearId, fromYearId), isNull(buechereiMaterialIssues.returnedOn))),
    db.select({ n: count() }).from(buechereiCompensations).where(eq(buechereiCompensations.status, "offen")),
  ]);
  const people = new Set(rows.map((r) => r.userId).filter((x): x is string => !!x));
  const leaving = new Set(leavers);
  return { schoolbooks: rows.length, people: people.size, leavers: [...people].filter((p) => leaving.has(p)).length, compensations: comps?.n ?? 0 };
}
