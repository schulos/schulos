// SP3-09a (docs/STUNDENPLAN-LEBENSZYKLUS.md §3.1 „Umgesetzt (SP3-09a)“): Jahreswahl im Planungsbereich. Vorgabe ist das laufende
// Schuljahr (`planningYear`); künftige Schuljahre (Folgejahr) sind wählbar, sobald sie angelegt sind, vergangene nur lesend. Die Wahl
// selbst (Cookie, Deeplinks) liegt in `src/app/(shell)/planung/planungsjahr.ts`; hier nur die reine Logik und die Prüfungen für Server
// Actions – die Actions bekommen das Jahr der Seite ausdrücklich (gebunden), nicht aus dem Cookie, damit zwei offene Tabs mit
// verschiedenen Jahren nichts verwechseln.
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { schoolYears, timetableAssignments, timetableBands, timetablePlanVersions, timetableReductions } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { isDraft, LIVE, type PlanSource } from "./plan-quelle";
import { planningYear } from "./verteilung";

export type SchoolYear = typeof schoolYears.$inferSelect;

/** Rolle eines Schuljahrs gegenüber dem laufenden: abgeschlossen (nur lesbar), laufend, künftig (Folgejahr). */
export type PlanningYearRole = "vergangen" | "laufend" | "folgejahr";

export const ROLE_LABELS: Record<PlanningYearRole, string> = {
  vergangen: "abgeschlossen – nur lesbar",
  laufend: "laufendes Schuljahr",
  folgejahr: "Folgejahr",
};

export interface PlanningYearChoice {
  id: string;
  name: string;
  role: PlanningYearRole;
  writable: boolean;
}

export interface PlanningYearState {
  /** gewähltes Schuljahr */
  year: SchoolYear;
  role: PlanningYearRole;
  /** Schreiben erlaubt (laufendes oder künftiges Schuljahr) */
  writable: boolean;
  /** laufendes Schuljahr (Vorgabe) */
  base: SchoolYear;
  /** gewähltes = laufendes Schuljahr */
  isBase: boolean;
  /** alle Schuljahre, älteste zuerst */
  choices: PlanningYearChoice[];
}

/** (rein) Rücksprung nach dem Umstellen: nur Pfade unter /planung (keine offene Weiterleitung), sonst die Übersicht. */
export function safePlanningTarget(raw: string | null | undefined): string {
  if (!raw || !/^\/planung(?:[/?#]|$)/.test(raw) || raw.includes("\\") || raw.includes("//") || /[\r\n]/.test(raw)) return "/planung";
  return raw;
}

/** (rein) Rolle von `year` gegenüber dem laufenden Schuljahr `base`. */
export function yearRole(year: Pick<SchoolYear, "id" | "startsOn">, base: Pick<SchoolYear, "id" | "startsOn">): PlanningYearRole {
  if (year.id === base.id) return "laufend";
  return year.startsOn < base.startsOn ? "vergangen" : "folgejahr";
}

/**
 * Gewähltes Planungsjahr: `requestedId`, wenn es das Schuljahr gibt, sonst das laufende. `null` nur ohne jedes Schuljahr.
 */
export async function resolvePlanningYear(db: Db, requestedId: string | null | undefined): Promise<PlanningYearState | null> {
  const [rows, base] = await Promise.all([db.select().from(schoolYears).orderBy(asc(schoolYears.startsOn), asc(schoolYears.id)), planningYear(db)]);
  if (!base) return null;
  const year = (requestedId && rows.find((y) => y.id === requestedId)) || base;
  const role = yearRole(year, base);
  const choices = rows.map((y) => {
    const r = yearRole(y, base);
    return { id: y.id, name: y.name, role: r, writable: r !== "vergangen" };
  });
  return { year, role, writable: role !== "vergangen", base, isBase: year.id === base.id, choices };
}

/**
 * Für Server Actions: das Schuljahr, in das geschrieben wird – es muss es geben und es darf nicht abgeschlossen sein (vergangene
 * Schuljahre sind nur lesbar). Rechte prüft die Action vorher wie bisher.
 */
export async function requireWritableYear(db: Db, yearId: string | null | undefined): Promise<SchoolYear> {
  const state = await resolvePlanningYear(db, yearId);
  if (!state || !yearId || state.year.id !== yearId) throw new ValidationError({ schoolYearId: "Schuljahr gibt es nicht (mehr) – Seite neu laden" });
  if (!state.writable) throw new ValidationError({ schoolYearId: `Das Schuljahr ${state.year.name} ist abgeschlossen und nur noch lesbar` });
  return state.year;
}

/** Datensätze mit Schuljahr, die Actions nur über ihre id ändern oder löschen. */
export type YearRecord = "assignment" | "band" | "reduction";

/** Für Server Actions mit id: Schuljahr des Datensatzes muss beschreibbar sein (unbekannte id → `null`, die Action bleibt wie bisher still). */
export async function requireWritableRecordYear(db: Db, kind: YearRecord, id: string): Promise<SchoolYear | null> {
  const t = kind === "assignment" ? timetableAssignments : kind === "band" ? timetableBands : timetableReductions;
  const [row] = await db.select({ schoolYearId: t.schoolYearId }).from(t).where(eq(t.id, id));
  if (!row) return null;
  return requireWritableYear(db, row.schoolYearId);
}

/** Schuljahr einer Planversion (Entwurf kennt sein Jahr). */
export async function yearOfVersion(db: Db, versionId: string): Promise<SchoolYear | null> {
  const [row] = await db.select({ y: schoolYears }).from(timetablePlanVersions).innerJoin(schoolYears, eq(schoolYears.id, timetablePlanVersions.schoolYearId)).where(eq(timetablePlanVersions.id, versionId));
  return row?.y ?? null;
}

/**
 * Schuljahr einer Planquelle: im Entwurf das der Version (auch im Folgejahr), im gültigen Plan das laufende. Für Setzhilfe, Pflege-Hinweise
 * und Restdeputate, die bisher immer das laufende Schuljahr nahmen.
 */
export async function yearOfSource(db: Db, source: PlanSource = LIVE): Promise<SchoolYear | null> {
  if (isDraft(source)) return (await yearOfVersion(db, source.versionId)) ?? planningYear(db);
  return planningYear(db);
}
