// SP-04 (docs/STUNDENPLAN-UMBAU.md §2.3): Kennzahlen der Übersicht `/planung` – nur Lesen, nur aus vorhandenen Services.
// Jahresplanung (`stundenplan.manage`): Schuljahr, offene Lehraufträge, Diagnose, Zeitwunsch-Fenster, letzter Solver-Lauf.
// Tagesgeschäft (`stundenplan.substitute`): Vertretungsbedarf heute/nächster Schultag, Entwürfe, unbesetzte Aufsichten, Raumsperren.
// Nur Zähler, keine Auswertung je Lehrkraft (wie „Offen für dich“).
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { SOLVER_RUN_STATUS, timetableSolverRuns } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { readSchoolSettings } from "@/core/settings";
import { needsOn } from "./abwesenheit";
import { dutiesOn } from "./aufsichten";
import { defaultObligation } from "./deputate";
import { diagnoseYear } from "./diagnose";
import { openDrafts } from "./freigabe";
import { blocksOn } from "./raumsperren";
import { distribution, planningYear } from "./verteilung";
import { planDays } from "./vertretung";
import { activeTeachers, readPrefWindow, submissions, windowState, type PrefWindowState } from "./zeitwunsch-fenster";

export interface PlanningYearInfo {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  isCurrent: boolean;
}

export interface YearPlanningFigures {
  /** Stichtag für „verplant“ (heute, eingegrenzt aufs Schuljahr) */
  refYmd: string;
  assignments: {
    total: number;
    /** Lehraufträge mit weniger verplanten als beauftragten Wochenstunden */
    open: number;
    /** Summe der offenen Wochenstunden */
    openHours: number;
    /** Lehraufträge mit mehr verplanten als beauftragten Stunden */
    over: number;
    /** Stunden im Plan ohne passenden Lehrauftrag */
    unmatched: number;
  };
  diagnosis: { error: number; warn: number };
  prefWindow: { state: PrefWindowState; opensOn: string | null; closesOn: string | null; submitted: number; teachers: number };
  lastRun: {
    id: string;
    status: (typeof SOLVER_RUN_STATUS)[number];
    progress: number;
    createdAt: Date;
    finishedAt: Date | null;
    appliedFrom: string | null;
    score: number | null;
    unplaced: number | null;
  } | null;
}

export interface SubstituteFigures {
  /** heute (bzw. nächster Schultag) und der Schultag danach */
  days: { date: string; open: number; total: number }[];
  /** Tage mit unveröffentlichtem Vertretungsplan ab heute */
  drafts: string[];
  duties: { date: string; open: number; total: number };
  roomBlocks: { date: string; count: number; rooms: string[] };
}

export interface PlanningOverview {
  year: PlanningYearInfo | null;
  manage: YearPlanningFigures | null;
  substitute: SubstituteFigures | null;
}

async function lastSolverRun(db: Db, schoolYearId: string): Promise<YearPlanningFigures["lastRun"]> {
  const r = timetableSolverRuns;
  // Bewertung und „nicht gesetzt“ direkt aus dem JSON – das ganze Ergebnis (Einheiten, Kostenposten) wird hier nicht gebraucht
  const [row] = await db
    .select({
      id: r.id,
      status: r.status,
      progress: r.progress,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      appliedFrom: r.appliedFrom,
      score: sql<string | number | null>`(${r.result} -> 'result' ->> 'score')`,
      unplaced: sql<string | number | null>`jsonb_array_length(${r.result} -> 'result' -> 'unplaced')`,
    })
    .from(r)
    .where(eq(r.schoolYearId, schoolYearId))
    .orderBy(desc(r.createdAt))
    .limit(1);
  if (!row) return null;
  const num = (v: string | number | null) => (v === null || v === undefined ? null : Number(v));
  return { ...row, score: num(row.score), unplaced: num(row.unplaced) };
}

async function yearFigures(db: Db, year: PlanningYearInfo, today: string): Promise<YearPlanningFigures> {
  const [d, school, window, submitted, teachers, lastRun] = await Promise.all([
    distribution(db, year, today),
    readSchoolSettings(db),
    readPrefWindow(db),
    submissions(db),
    activeTeachers(db),
    lastSolverRun(db, year.id),
  ]);
  const report = await diagnoseYear(db, year, today, defaultObligation(school.profile.form), d);
  const open = d.assignments.filter((a) => a.planned < a.hours);
  const sumSev = (sev: "error" | "warn") => Object.values(report.counts).reduce((s, c) => s + c[sev], 0);
  // Ein Fenster aus einem anderen Schuljahr zählt nicht (wie `openWindow`)
  const w = window && window.schoolYearId === year.id ? window : null;
  return {
    refYmd: d.refYmd,
    assignments: {
      total: d.assignments.length,
      open: open.length,
      openHours: open.reduce((s, a) => s + (a.hours - a.planned), 0),
      over: d.assignments.filter((a) => a.planned > a.hours).length,
      unmatched: d.unmatched.length,
    },
    diagnosis: { error: sumSev("error"), warn: sumSev("warn") },
    prefWindow: {
      state: windowState(w, today),
      opensOn: w?.opensOn ?? null,
      closesOn: w?.closesOn ?? null,
      submitted: teachers.filter((t) => submitted.has(t)).length,
      teachers: teachers.length,
    },
    lastRun,
  };
}

async function substituteFigures(db: Db, today: string): Promise<SubstituteFigures> {
  const days = planDays(today, await loadSchoolCalendar(db));
  const [needs, duties, drafts, blocks] = await Promise.all([Promise.all(days.map((d) => needsOn(db, d))), dutiesOn(db, days[0]), openDrafts(db, today), blocksOn(db, today)]);
  return {
    days: days.map((date, i) => ({ date, open: needs[i]!.open.filter((o) => o.status === "open").length, total: needs[i]!.open.length })),
    drafts,
    duties: { date: days[0], open: duties.filter((x) => x.status === "open").length, total: duties.length },
    roomBlocks: { date: today, count: blocks.length, rooms: [...new Set(blocks.map((b) => b.roomId))].sort() },
  };
}

/** Kennzahlen der Planungs-Übersicht; Teile ohne passendes Recht bleiben `null` (werden gar nicht erst berechnet). */
export async function planningOverview(db: Db, today: string, rights: { manage: boolean; substitute: boolean }): Promise<PlanningOverview> {
  const y = await planningYear(db);
  const year: PlanningYearInfo | null = y ? { id: y.id, name: y.name, startsOn: y.startsOn, endsOn: y.endsOn, isCurrent: y.isCurrent } : null;
  const [manage, substitute] = await Promise.all([
    rights.manage && year ? yearFigures(db, year, today) : null,
    rights.substitute ? substituteFigures(db, today) : null,
  ]);
  return { year, manage, substitute };
}
