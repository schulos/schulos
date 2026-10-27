// Solver-Läufe (P2b-23, SP-06): Lauf mit Parametern anlegen, Warteschlange (nur ein Lauf rechnet), Ausführung im App-Prozess
// zeitgeschnitten (~25 ms rechnen, dann `setImmediate`) mit Heartbeat-Sperre, Abbruch, Protokoll und Kennzahlen; Vorschau mit
// Bewertung und Diagnose, Übernahme ab Stichtag (Schultag) mit Rücknahme-Daten und „Übernahme zurücknehmen“ bis zum Stichtag (SP-09),
// Aufräumen. Fixierte Stunden und Stunden ohne Lehrauftrag bleiben.
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { runExclusive, type HeldLock } from "@/core/jobs";
import { audit } from "@/core/audit";
import {
  bookingResources,
  bookings,
  classbookEntries,
  exams,
  groupMembers,
  groups,
  periods,
  rooms,
  subjects,
  timetableAbsenceMaterials,
  timetableAssignments,
  timetableLessons,
  timetableSolverRuns,
  timetableSubstitutions,
  users,
  type TimetableLesson,
  type TimetableSubstitution,
} from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, isCalendarDate, toBerlinDate, TZ, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { diagnose, type DiagLesson, type Finding } from "./diagnose";
import { createSolver, DEFAULT_WEIGHTS, placementRooms, unitParts, type GapStats, type SolverResult, type SolverWeights, type UnitPart } from "./solver";
import { precheck, type PrecheckFinding } from "./solver-check";
import { solverInputFromDb } from "./solver-input";
import { distribution, planningYear } from "./verteilung";
import { deletedEntries, moveChangeHistory, recordLessonCascade, recordSubstitutionChanges, snapshotOf } from "./vertretung-historie";
import { draftOf, idWhere, insertLessonRows, lessonCols, LIVE, requireWritable, versionWhere, type NewLessonRow, type PlanSource } from "./plan-quelle";
import { createDraft, getVersion, OPEN_STATUSES, versionNumber } from "./planversionen";
import { timetableDraftLessons, timetablePlanVersions } from "./schema";

export const EFFORTS = { schnell: 0.25, normal: 1, gruendlich: 4 } as const;
export type Effort = keyof typeof EFFORTS;
export const EFFORT_LABELS: Record<Effort, string> = { schnell: "schnell", normal: "normal", gruendlich: "gründlich" };

/** Gewichtungs-Voreinstellungen (SP-07 zeigt sie zur Auswahl; „eigene“ = alle Felder von Hand). */
export const WEIGHT_PRESETS = {
  ausgewogen: DEFAULT_WEIGHTS,
  // SP2-04: Anwesenheitstage (lehrkräfteschonend) und Fach an Folgetagen (klassenkompakt) nur in diesen Voreinstellungen – „ausgewogen“ bleibt
  lehrkraefteschonend: { ...DEFAULT_WEIGHTS, teacherGap: 8, pref: 3, classGap: 6, teacherDays: 4 },
  klassenkompakt: { ...DEFAULT_WEIGHTS, classGap: 16, subjectTwice: 10, late: 3, subjectSpread: 6 },
  raumtreu: { ...DEFAULT_WEIGHTS, roomWish: 10, noRoom: 40 },
} as const satisfies Record<string, SolverWeights>;
export type WeightPreset = keyof typeof WEIGHT_PRESETS | "eigene";
export const PRESET_LABELS: Record<WeightPreset, string> = {
  ausgewogen: "ausgewogen",
  lehrkraefteschonend: "lehrkräfteschonend",
  klassenkompakt: "klassenkompakt",
  raumtreu: "raumtreu",
  eigene: "eigene",
};

/** Alles, was einen Lauf reproduzierbar macht (L-05). */
export interface RunParams {
  effort: Effort;
  seed: number;
  weights: SolverWeights;
  preset: WeightPreset;
  /** SP2-09: Lehraufträge, die an diesem Tag gelten (fehlt = Tag der Berechnung, wie vor SP2-09) */
  refYmd?: string;
  /** SP3-02: gerechnet gegen den Entwurf dieser Planversion (fixierte/behaltene Stunden aus dem Entwurf); fehlt = gültiger Plan */
  versionId?: string;
}

export interface RunLogEntry {
  at: string;
  kind: "queued" | "start" | "input" | "warning" | "precheck" | "construct" | "progress" | "cancel" | "done" | "error" | "cleanup" | "apply" | "undo";
  text: string;
  /** Zahlen zum Eintrag (Vorprüfung, Gründe „nicht gesetzt“, Zwischenbewertung) */
  data?: Record<string, unknown>;
}

export const LOG_LIMIT = 50;

/** Kennzahlen beim Abschluss – klein, damit die Historie sie ohne das ganze Ergebnis lesen kann. */
export interface RunMetrics {
  score: number;
  breakdown: SolverResult["breakdown"];
  unplaced: number;
  units: number;
  steps: number;
  improved: number;
  durationMs: number;
  gaps: GapStats;
  /** Diagnose-Zähler des Vorschlags (Fehler + Warnungen) */
  diag: { gaps: number; subjectDay: number; room: number };
  /** Pausen „Vorfahrt für Anfragen“ (Ereignisschleife war zwischen zwei Zeitscheiben anderweitig beschäftigt) */
  pauses: number;
  /** Fortschritt in %, bei dem der Lauf vorzeitig beendet wurde (Abbruch nach der Konstruktion) */
  cancelledAt?: number;
  /** Fehler und Warnungen der Vorprüfung */
  precheck: { errors: number; warnings: number };
}

/** Einheit, wie sie im Lauf gespeichert wird. `parts` fehlt bei Läufen vor SP-06 (dann ein Teil aus den flachen Feldern). */
export interface StoredUnit {
  id: string;
  label: string;
  groupIds: string[];
  teacherIds: string[];
  subjectId: string;
  length: 1 | 2;
  parts?: UnitPart[];
}

/** Was zu einem Lauf gespeichert wird: Ergebnis + was die Vorschau und die Übernahme brauchen. */
export interface StoredResult {
  result: SolverResult;
  units: StoredUnit[];
  keptLessonIds: string[];
  refYmd: string;
  /** SP3-02: `keptLessonIds` sind Entwurfsstunden dieser Version (fehlt = Stunden des gültigen Plans) */
  versionId?: string;
}

export type RunStatus = (typeof timetableSolverRuns.$inferSelect)["status"];

/** Eine bei der Übernahme entfernte Stunde (begann erst ab dem Stichtag) – vollständig, damit das Zurücknehmen sie wieder anlegt. */
export type UndoLesson = Pick<TimetableLesson, "id" | "groupId" | "weekday" | "periodNr" | "subjectId" | "teacherId" | "roomId" | "week" | "validFrom" | "validUntil" | "couplingId" | "fixed" | "solverRunId">;

/**
 * SP-13: eine bei der Übernahme entfernte Vertretung – vollständig, damit das Zurücknehmen sie wiederherstellt, sofern ihre Stunde
 * an dem Tag wieder gilt. `createdAt` als ISO-Zeitpunkt (JSONB).
 */
export type UndoSubstitution = Pick<TimetableSubstitution, "id" | "lessonId" | "date" | "kind" | "substituteId" | "roomId" | "note" | "subjectId" | "createdBy"> & {
  createdAt: string;
  /** SP2-07 (R1a/A1): Zielstunde einer Verlegung bzw. aufnehmende Stunde einer Zusammenlegung – fehlen bei Übernahmen davor */
  targetPeriod?: number | null;
  mergeLessonId?: string | null;
  /** VT-01: Grund-Kategorie, interner Hinweis, „nur Betreuung“ – fehlen bei Übernahmen davor */
  reason?: TimetableSubstitution["reason"];
  internalNote?: string | null;
  supervisionOnly?: boolean;
};

/**
 * SP-09: was die Übernahme am bestehenden Plan geändert hat – Grundlage für „Übernahme zurücknehmen“. Enthält Lehrkraft-IDs
 * (Personenbezug) und wird deshalb geleert, sobald der Stichtag erreicht ist (Nachtjob) oder die Übernahme zurückgenommen wurde.
 */
export interface UndoData {
  /** Stunden, die am Vortag des Stichtags beendet wurden, mit ihrem früheren Ende (`null` = unbefristet) */
  ended: { id: string; validUntil: string | null }[];
  /** Stunden, die ganz entfernt wurden (sie begannen erst ab dem Stichtag) */
  deleted: UndoLesson[];
  /** Zahl der Vertretungen ab dem Stichtag an ersetzten Stunden, die entfernt wurden */
  removedSubstitutions: number;
  /** SP-13: diese Vertretungen vollständig – fehlt bei Übernahmen vor SP-13 (dann kommt keine zurück) */
  substitutions?: UndoSubstitution[];
  /**
   * R1a/A2: Stunden, die über das Ende des Planungszeitraums hinaus galten, wurden dort geteilt – `of` endet am Ende des Zeitraums,
   * die Kopie `id` gilt danach weiter (mit den Vertretungen/Einträgen ab dann). Das Zurücknehmen fügt sie wieder zusammen.
   */
  split?: { id: string; of: string }[];
}

export interface SolverRun {
  id: string;
  schoolYearId: string;
  status: RunStatus;
  progress: number;
  seed: number;
  iterations: number;
  error: string | null;
  label: string | null;
  params: RunParams | null;
  metrics: RunMetrics | null;
  log: RunLogEntry[];
  cancelRequested: boolean;
  heartbeatAt: Date | null;
  appliedFrom: string | null;
  appliedBy: string | null;
  appliedAt: Date | null;
  /** SP-09: Rücknahme-Daten, solange die Übernahme zurücknehmbar ist */
  undo: UndoData | null;
  createdBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  stored: StoredResult | null;
}

const toRun = (r: typeof timetableSolverRuns.$inferSelect): SolverRun => ({
  id: r.id,
  schoolYearId: r.schoolYearId,
  status: r.status,
  progress: r.progress,
  seed: r.seed,
  iterations: r.iterations,
  error: r.error,
  label: r.label,
  params: (r.params as RunParams | null) ?? null,
  metrics: (r.metrics as RunMetrics | null) ?? null,
  log: (r.log as RunLogEntry[] | null) ?? [],
  cancelRequested: r.cancelRequested,
  heartbeatAt: r.heartbeatAt,
  appliedFrom: r.appliedFrom,
  appliedBy: r.appliedBy,
  appliedAt: r.appliedAt,
  undo: (r.undo as UndoData | null) ?? null,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
  stored: (r.result as StoredResult | null) ?? null,
});

export interface ListRunsOptions {
  schoolYearId?: string;
  /** nur diese Läufe (SP-08: Vergleich) */
  ids?: string[];
  status?: RunStatus | RunStatus[];
  limit?: number;
}

/** Läufe, neueste zuerst. `listRuns(db, 5)` = die letzten fünf (alle Schuljahre); mit Optionen gefiltert (SP-07: Historie). */
export async function listRuns(db: Db, opts: number | ListRunsOptions = 5): Promise<SolverRun[]> {
  const o = typeof opts === "number" ? { limit: opts } : opts;
  const conds = [];
  if (o.schoolYearId) conds.push(eq(timetableSolverRuns.schoolYearId, o.schoolYearId));
  if (o.status) conds.push(Array.isArray(o.status) ? inArray(timetableSolverRuns.status, o.status) : eq(timetableSolverRuns.status, o.status));
  const q = db
    .select()
    .from(timetableSolverRuns)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(timetableSolverRuns.createdAt));
  return (await (o.limit ? q.limit(o.limit) : q)).map(toRun);
}

export async function getRun(db: Db, id: string): Promise<SolverRun | null> {
  const [r] = await db.select().from(timetableSolverRuns).where(eq(timetableSolverRuns.id, id));
  return r ? toRun(r) : null;
}

/** Ein Lauf für die Historie (SP-07): ohne Ergebnis-JSON, Protokoll und Rücknahme-Daten – die Liste liest nur Kennzahlen. */
export type RunSummary = Omit<SolverRun, "stored" | "log" | "undo"> & { hasResult: boolean; hasUndo: boolean; createdByName: string | null };

/** Läufe für die Historie, neueste zuerst – wie listRuns(), aber ohne `result`/`log` (bei 20 Ergebnissen je Schuljahr spürbar). */
export async function listRunSummaries(db: Db, opts: ListRunsOptions = {}): Promise<RunSummary[]> {
  const t = timetableSolverRuns;
  const conds = [];
  if (opts.schoolYearId) conds.push(eq(t.schoolYearId, opts.schoolYearId));
  if (opts.ids) conds.push(inArray(t.id, opts.ids));
  if (opts.status) conds.push(Array.isArray(opts.status) ? inArray(t.status, opts.status) : eq(t.status, opts.status));
  const q = db
    .select({
      id: t.id,
      schoolYearId: t.schoolYearId,
      status: t.status,
      progress: t.progress,
      seed: t.seed,
      iterations: t.iterations,
      error: t.error,
      label: t.label,
      params: t.params,
      metrics: t.metrics,
      cancelRequested: t.cancelRequested,
      heartbeatAt: t.heartbeatAt,
      appliedFrom: t.appliedFrom,
      appliedBy: t.appliedBy,
      appliedAt: t.appliedAt,
      createdBy: t.createdBy,
      createdByName: users.name,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt,
      hasResult: sql<boolean>`${t.result} is not null`,
      hasUndo: sql<boolean>`${t.undo} is not null`,
    })
    .from(t)
    .leftJoin(users, eq(users.id, t.createdBy))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(t.createdAt), desc(t.id));
  const rows = await (opts.limit ? q.limit(opts.limit) : q);
  return rows.map((r) => ({
    ...r,
    params: (r.params as RunParams | null) ?? null,
    metrics: (r.metrics as RunMetrics | null) ?? null,
    hasResult: Boolean(r.hasResult),
    hasUndo: Boolean(r.hasUndo),
  }));
}

/** Zustand eines wartenden/rechnenden Laufs für die Live-Anzeige (SP-07) – klein, damit häufiges Nachfragen nichts kostet. */
export interface RunLiveState {
  id: string;
  status: RunStatus;
  progress: number;
  cancelRequested: boolean;
  heartbeatAt: string | null;
  /** letzter Protokolleintrag (z. B. „40 % – Bewertung 312“) */
  note: string | null;
}

export async function runLiveStates(db: Db, ids: string[]): Promise<RunLiveState[]> {
  const valid = [...new Set(ids)].filter((id) => /^[\w-]{1,64}$/.test(id)).slice(0, 50);
  if (!valid.length) return [];
  const t = timetableSolverRuns;
  const rows = await db
    .select({
      id: t.id,
      status: t.status,
      progress: t.progress,
      cancelRequested: t.cancelRequested,
      heartbeatAt: t.heartbeatAt,
      // nur der letzte Eintrag – das Protokoll kann mit den Vorprüfungs-Daten groß sein
      note: sql<string | null>`${t.log} -> -1 ->> 'text'`,
    })
    .from(t)
    .where(inArray(t.id, valid));
  return rows.map((r) => ({ ...r, heartbeatAt: r.heartbeatAt ? new Date(r.heartbeatAt).toISOString() : null, note: r.note ?? null }));
}

/** Rein: Ergebnis der Vorprüfung aus dem Protokoll (SP-G-03) – `null`, wenn der Lauf noch nicht so weit kam. */
export function precheckOf(log: RunLogEntry[]): PrecheckFinding[] | null {
  const entry = [...log].reverse().find((e) => e.kind === "precheck");
  if (!entry) return null;
  const findings = entry.data?.findings;
  return Array.isArray(findings) ? (findings as PrecheckFinding[]) : [];
}

/**
 * Rein: Lässt sich die Übernahme noch zurücknehmen (SP-09)? Nur, solange der Stichtag in der Zukunft liegt und die
 * Rücknahme-Daten vorhanden sind (Läufe, die vor SP-09 übernommen wurden, haben keine).
 */
export function isUndoable(run: { status: RunStatus; appliedFrom: string | null; undo: UndoData | null }, todayYmd: string): boolean {
  return run.status === "applied" && run.appliedFrom !== null && run.appliedFrom > todayYmd && run.undo !== null;
}

/**
 * Rein: Darf der Lauf gelöscht werden? Nicht, solange er rechnet (erst abbrechen) – und nicht, solange seine Übernahme noch
 * zurücknehmbar ist (das Löschen würde die Rücknahme-Daten mitnehmen; erst zurücknehmen oder bis zum Stichtag warten).
 */
export function canDeleteRun(run: { status: RunStatus; appliedFrom: string | null; undo: UndoData | null }, todayYmd: string): boolean {
  return run.status !== "running" && !isUndoable(run, todayYmd);
}

// ---------------------------------------------------------------- Anlegen

export interface CreateRunOptions {
  label?: string | null;
  effort?: string;
  seed?: number;
  preset?: string;
  /** eigene Gewichte (nur bei `preset: "eigene"`, sonst ignoriert); fehlende Felder aus der Vorgabe */
  weights?: Partial<Record<keyof SolverWeights, number>>;
  /** SP2-09: Planungsstand – Lehraufträge, die an diesem Tag gelten (leer = heute; im Entwurf: dessen Stichtag) */
  refYmd?: string | null;
  /** SP3-02: im Entwurf dieser Planversion rechnen (leer = gegen den gültigen Plan) */
  versionId?: string | null;
}

/** Rein: Parameter aus der Eingabe (Formular/Test) – ungültige Werte werden gemeldet, nicht still ersetzt. */
export function parseParams(opts: CreateRunOptions): RunParams {
  const errors: Record<string, string> = {};
  const effort = (opts.effort ?? "normal") as Effort;
  if (!(effort in EFFORTS)) errors.effort = "Unbekannte Gründlichkeit";
  const seed = opts.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 1 || seed > 999_999) errors.seed = "Der Startwert muss eine ganze Zahl von 1 bis 999999 sein";
  const preset = (opts.preset ?? "ausgewogen") as WeightPreset;
  if (!(preset in PRESET_LABELS)) errors.preset = "Unbekannte Gewichtung";
  let weights: SolverWeights = preset === "eigene" || !(preset in WEIGHT_PRESETS) ? { ...DEFAULT_WEIGHTS } : { ...WEIGHT_PRESETS[preset as keyof typeof WEIGHT_PRESETS] };
  if (preset === "eigene") {
    weights = { ...DEFAULT_WEIGHTS };
    for (const k of Object.keys(DEFAULT_WEIGHTS) as (keyof SolverWeights)[]) {
      const v = opts.weights?.[k];
      if (v === undefined) continue;
      if (!Number.isFinite(v) || v < 0 || v > 1000 || (k === "lateFrom" && !Number.isInteger(v))) errors[`weights.${k}`] = `Gewicht „${k}“ muss eine Zahl von 0 bis 1000 sein`;
      else weights[k] = v;
    }
  }
  const refYmd = opts.refYmd || undefined;
  if (refYmd && !isCalendarDate(refYmd)) errors.refYmd = "Datum angeben";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const versionId = opts.versionId?.trim() || undefined;
  return { effort, seed, weights, preset, ...(refYmd ? { refYmd } : {}), ...(versionId ? { versionId } : {}) };
}

/**
 * SP3-02: Entwurf eines Laufs prüfen – offen (nicht verworfen/veröffentlicht), im Planungsjahr; der Planungsstand liegt frühestens am
 * Stichtag des Entwurfs (vorher gelten seine Stunden nicht). Liefert den Planungsstand (Vorgabe: Stichtag des Entwurfs).
 */
async function draftRunRef(db: Db, versionId: string, year: { id: string }, refYmd: string | undefined): Promise<string | undefined> {
  const v = await getVersion(db, versionId);
  if (!v || v.schoolYearId !== year.id) throw new ValidationError({ versionId: "Entwurf des Planungsjahrs wählen" });
  if (!(OPEN_STATUSES as readonly string[]).includes(v.status)) throw new ValidationError({ versionId: `Version ${versionNumber(v)} ist kein offener Entwurf` });
  const from = v.validFrom ?? undefined;
  if (refYmd && from && refYmd < from)
    throw new ValidationError({ refYmd: `Im Entwurf ${versionNumber(v)} gelten die Stunden erst ab ${dayFmt.format(fromBerlinLocal(from))} – Planungsstand ab diesem Tag wählen` });
  return refYmd ?? from;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

const logEntry = (kind: RunLogEntry["kind"], text: string, data?: Record<string, unknown>, now = new Date()): RunLogEntry => ({
  at: now.toISOString(),
  kind,
  text,
  ...(data ? { data } : {}),
});

/**
 * Legt einen Lauf an (Status „queued“); gerechnet wird über executeQueued() – sofort, wenn kein anderer Lauf rechnet, sonst
 * danach. Ohne Zeitraster, Lehraufträge oder aktive Räume gibt es einen Hinweis statt eines leeren Laufs (L-02); Warnungen
 * (Kurse ohne Mitglieder, A/B-Stunden) stehen im Protokoll.
 */
export async function createRun(db: Db, actorId: string, opts: CreateRunOptions, todayYmd?: string): Promise<string> {
  const year = await planningYear(db);
  if (!year) throw new ValidationError({ year: "Zuerst ein Schuljahr anlegen" });
  const params = parseParams(opts);
  if (params.refYmd && (params.refYmd < year.startsOn || params.refYmd > year.endsOn)) throw new ValidationError({ refYmd: "Der Planungsstand muss im Schuljahr liegen" });
  const label = opts.label?.trim() ? opts.label.trim().slice(0, 120) : null;
  // SP3-02: im Entwurf ist der Planungsstand mindestens sein Stichtag (und wird mitgespeichert, damit der Lauf reproduzierbar bleibt)
  if (params.versionId) {
    const ref = await draftRunRef(db, params.versionId, year, params.refYmd);
    if (ref) params.refYmd = ref;
  }
  const source = params.versionId ? draftOf(params.versionId) : LIVE;
  const input = await solverInputFromDb(db, year, params.refYmd ?? todayYmd ?? toBerlinDate(new Date()), { seed: params.seed, source });
  if (Object.keys(input.check.errors).length) throw new ValidationError(input.check.errors);
  const now = new Date();
  const log: RunLogEntry[] = [logEntry("queued", "Lauf angelegt, wartet auf die Berechnung", undefined, now), ...input.check.warnings.map((w) => logEntry("warning", w, undefined, now))];
  const [row] = await db
    .insert(timetableSolverRuns)
    .values({ schoolYearId: year.id, status: "queued", seed: params.seed, createdBy: actorId, iterations: 0, label, params, log })
    .returning({ id: timetableSolverRuns.id });
  await audit(db, actorId, "stundenplan.solver.start", null, { run: row!.id, seed: params.seed, effort: params.effort, preset: params.preset, label, ...(params.versionId ? { draft: params.versionId } : {}) });
  return row!.id;
}

/** Abbruch: wartende Läufe enden sofort als „cancelled“; rechnende bekommen den Wunsch und beenden sich in der nächsten Zeitscheibe. */
export async function cancelRun(db: Db, actorId: string, runId: string): Promise<"cancelled" | "requested"> {
  const run = await getRun(db, runId);
  if (!run) throw new ValidationError({ run: "Lauf gibt es nicht" });
  if (run.status === "queued") {
    await db
      .update(timetableSolverRuns)
      .set({ status: "cancelled", finishedAt: new Date(), log: [...run.log, logEntry("cancel", "Abgebrochen, bevor die Berechnung begann")].slice(-LOG_LIMIT) })
      .where(and(eq(timetableSolverRuns.id, runId), eq(timetableSolverRuns.status, "queued")));
    await audit(db, actorId, "stundenplan.solver.cancel", null, { run: runId, state: "queued" });
    return "cancelled";
  }
  if (run.status !== "running") throw new ValidationError({ run: "Nur ein wartender oder rechnender Lauf lässt sich abbrechen" });
  await db.update(timetableSolverRuns).set({ cancelRequested: true }).where(eq(timetableSolverRuns.id, runId));
  await audit(db, actorId, "stundenplan.solver.cancel", null, { run: runId, state: "running" });
  return "requested";
}

/**
 * Lauf löschen (nicht während er rechnet, nicht solange seine Übernahme zurücknehmbar ist). Stunden, die aus ihm übernommen
 * wurden, bleiben – nur ihre Herkunft wird leer.
 */
export async function deleteRun(db: Db, actorId: string, runId: string, todayYmd = toBerlinDate(new Date())): Promise<void> {
  const run = await getRun(db, runId);
  if (!run) throw new ValidationError({ run: "Lauf gibt es nicht" });
  if (run.status === "running") throw new ValidationError({ run: "Erst abbrechen, dann löschen" });
  if (isUndoable(run, todayYmd))
    throw new ValidationError({ run: `Die Übernahme lässt sich bis zum Stichtag (${dayFmt.format(fromBerlinLocal(run.appliedFrom!))}) noch zurücknehmen – erst zurücknehmen oder bis dahin warten` });
  await db.delete(timetableSolverRuns).where(eq(timetableSolverRuns.id, runId));
  await audit(db, actorId, "stundenplan.solver.delete", null, { run: runId, status: run.status, label: run.label });
}

// ---------------------------------------------------------------- Ausführen

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Sperre „solver“: TTL kurz, je Heartbeat verlängert – ein verlorener Prozess gibt sie so nach zwei Minuten frei. */
export const SOLVER_LOCK_TTL_MS = 2 * 60_000;
/** Rechnende Läufe ohne Lebenszeichen so lange gelten als verwaist (anderer Prozess abgestürzt). */
export const STALE_RUN_MS = 5 * 60_000;

export interface ExecuteOptions {
  /** Rechenzeit je Zeitscheibe, danach `setImmediate` (Vorgabe 25 ms) */
  sliceMs?: number;
  /**
   * Vorfahrt für Anfragen: kam der Lauf nach `setImmediate` spürbar verspätet zurück (etwas anderes hat die Ereignisschleife
   * gebraucht), pausiert er so lange (Vorgabe 30 ms), bevor er weiterrechnet – unter Last wird der Lauf langsamer, die Seiten nicht
   */
  pauseMs?: number;
  /** Abstand der Heartbeats (Fortschritt, Sperre verlängern, Abbruch prüfen; Vorgabe 1 s) */
  heartbeatMs?: number;
  lock?: HeldLock;
  /** Testhaken: wird je Zeitscheibe aufgerufen */
  onSlice?: (phase: "construct" | "improve") => void;
  /** Testhaken: wird je Pause (Vorfahrt) aufgerufen */
  onPause?: () => void;
}

/** Beim Serverstart: Läufe, die beim Beenden noch rechneten, sind verloren (sie laufen im Prozess) → fehlgeschlagen; wartende startet executeQueued(). */
export async function failInterruptedRuns(db: Db): Promise<number> {
  const rows = await db
    .update(timetableSolverRuns)
    .set({ status: "failed", error: "Abgebrochen: Der Server wurde neu gestartet", finishedAt: new Date() })
    .where(eq(timetableSolverRuns.status, "running"))
    .returning({ id: timetableSolverRuns.id });
  return rows.length;
}

/** Rechnende Läufe ohne Lebenszeichen seit STALE_RUN_MS (Prozess abgestürzt, Sperre abgelaufen) → fehlgeschlagen. */
export async function reapStaleRuns(db: Db, now = new Date(), staleMs = STALE_RUN_MS): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs);
  // kein `Date` als Parameter in rohem SQL (postgres-js serialisiert ihn dort nicht) – darum zwei typisierte Vergleiche
  const rows = await db
    .update(timetableSolverRuns)
    .set({ status: "failed", error: "Abgebrochen: keine Rückmeldung der Berechnung (Prozess beendet?)", finishedAt: now })
    .where(
      and(
        eq(timetableSolverRuns.status, "running"),
        or(lt(timetableSolverRuns.heartbeatAt, cutoff), and(isNull(timetableSolverRuns.heartbeatAt), lt(timetableSolverRuns.createdAt, cutoff))),
      ),
    )
    .returning({ id: timetableSolverRuns.id });
  return rows.length;
}

/**
 * Warteschlange abarbeiten: unter der Sperre „solver“ (nur ein Lauf gleichzeitig, auch über Prozesse hinweg) den ältesten
 * wartenden Lauf rechnen, dann den nächsten – bis keiner mehr wartet. Läuft schon ein anderer Prozess, passiert nichts
 * (`ran: false`); der Takt in scheduler.ts versucht es dann wieder. Verwaiste Läufe werden vorher aufgeräumt.
 */
export async function executeQueued(db: Db, todayYmd: string, opts: ExecuteOptions = {}): Promise<{ ran: boolean; executed: string[] }> {
  await reapStaleRuns(db);
  const [pending] = await db.select({ id: timetableSolverRuns.id }).from(timetableSolverRuns).where(eq(timetableSolverRuns.status, "queued")).limit(1);
  if (!pending) return { ran: false, executed: [] };
  const executed: string[] = [];
  const r = await runExclusive(
    db,
    "solver",
    async (lock) => {
      for (;;) {
        const [next] = await db
          .select({ id: timetableSolverRuns.id })
          .from(timetableSolverRuns)
          .where(eq(timetableSolverRuns.status, "queued"))
          .orderBy(asc(timetableSolverRuns.createdAt), asc(timetableSolverRuns.id))
          .limit(1);
        if (!next) return;
        await executeRun(db, next.id, todayYmd, { ...opts, lock });
        executed.push(next.id);
      }
    },
    { ttlMs: SOLVER_LOCK_TTL_MS },
  );
  return { ran: r.ran, executed };
}

/**
 * Führt einen Lauf aus (queued/running → done | cancelled | failed) und schreibt Fortschritt, Heartbeat, Protokoll, Kennzahlen
 * und Ergebnis. Rechnet zeitgeschnitten, damit der Serverprozess nebenbei Anfragen beantwortet.
 */
export async function executeRun(db: Db, runId: string, todayYmd: string, opts: ExecuteOptions = {}): Promise<"done" | "cancelled" | "failed" | "skipped"> {
  const sliceMs = opts.sliceMs ?? 25;
  const pauseMs = opts.pauseMs ?? 30;
  const heartbeatMs = opts.heartbeatMs ?? 1000;
  const t0 = Date.now();
  let pauses = 0;
  /** Ereignisschleife freigeben; kam etwas anderes dran, zusätzlich pausieren (Anfragen haben Vorfahrt) */
  const breathe = async () => {
    const t = performance.now();
    await tick();
    if (pauseMs > 0 && performance.now() - t > 2) {
      pauses++;
      opts.onPause?.();
      await new Promise<void>((r) => setTimeout(r, pauseMs));
    }
  };
  let log: RunLogEntry[] = [];
  const set = (v: Partial<typeof timetableSolverRuns.$inferInsert>) => db.update(timetableSolverRuns).set(v).where(eq(timetableSolverRuns.id, runId));
  const note = (kind: RunLogEntry["kind"], text: string, data?: Record<string, unknown>) => {
    log = [...log, logEntry(kind, text, data)].slice(-LOG_LIMIT);
  };
  try {
    const run = await getRun(db, runId);
    if (!run) throw new Error("Lauf fehlt");
    if (run.status !== "queued" && run.status !== "running") return "skipped";
    const year = await planningYear(db);
    if (!year || year.id !== run.schoolYearId) throw new Error("Das Schuljahr des Laufs ist nicht mehr das Planungsjahr");
    log = run.log;
    const params: RunParams = run.params ?? { effort: "normal", seed: run.seed, weights: { ...DEFAULT_WEIGHTS }, preset: "ausgewogen" };
    // SP2-09: Lehraufträge am gewählten Planungsstand (sonst am Tag der Berechnung)
    const refYmd = params.refYmd ?? todayYmd;
    note(
      "start",
      `Berechnung gestartet (${EFFORT_LABELS[params.effort]}, Startwert ${params.seed}, Gewichtung ${PRESET_LABELS[params.preset]}${params.refYmd ? `, Lehraufträge am ${dayFmt.format(fromBerlinLocal(params.refYmd))}` : ""})`,
    );
    await set({ status: "running", progress: 1, heartbeatAt: new Date(), log });

    // Eingabe und Vorprüfung (zwischen den Abschnitten die Ereignisschleife freigeben – mit PGlite rechnet die Datenbank im selben Thread)
    // SP3-02: im Entwurf rechnen – gibt es ihn nicht mehr (verworfen/veröffentlicht), scheitert der Lauf mit Hinweis
    if (params.versionId) {
      const v = await getVersion(db, params.versionId);
      if (!v || !(OPEN_STATUSES as readonly string[]).includes(v.status)) throw new Error("Der Entwurf des Laufs ist nicht mehr offen (verworfen oder veröffentlicht)");
    }
    const input = await solverInputFromDb(db, year, refYmd, { seed: params.seed, source: params.versionId ? draftOf(params.versionId) : LIVE });
    await tick();
    input.weights = params.weights;
    const blockedSlots = [...input.prefs.values()].reduce((s, m) => s + [...m.values()].filter((v) => v === null).length, 0);
    note("input", `Eingabe: ${input.units.length} Einheiten (${input.units.filter((u) => u.length === 2).length} Doppelstunden), ${input.fixed.length} fixierte Stunden, ${input.rooms.length} Räume, ${blockedSlots} gesperrte Zeiten, ${input.weekdays.length * input.periods.length} Slots${input.breakAfter?.length ? `, große Pause nach der ${input.breakAfter.map((p) => `${p}.`).join("/")} Stunde` : ""}${input.dayRules?.size ? `, Tagesgrenzen für ${input.dayRules.size} ${input.dayRules.size === 1 ? "Klasse" : "Klassen"}` : ""}${input.teacherRules?.size ? `, Tagesregeln für ${input.teacherRules.size} ${input.teacherRules.size === 1 ? "Lehrkraft" : "Lehrkräfte"}` : ""}`, {
      units: input.units.length,
      dayRules: input.dayRules?.size ?? 0,
      teacherRules: input.teacherRules?.size ?? 0,
      doubles: input.units.filter((u) => u.length === 2).length,
      fixed: input.fixed.length,
      rooms: input.rooms.length,
      blocked: blockedSlots,
      breakAfter: input.breakAfter ?? [],
    });
    for (const w of input.check.warnings) if (!run.log.some((e) => e.kind === "warning" && e.text === w)) note("warning", w);
    const findings = precheck(input);
    const pre = { errors: findings.filter((f) => f.severity === "error").length, warnings: findings.filter((f) => f.severity === "warn").length };
    note(
      "precheck",
      findings.length
        ? `Vorprüfung: ${pre.errors} Fehler, ${pre.warnings} ${pre.warnings === 1 ? "Warnung" : "Warnungen"} – ${findings
            .slice(0, 3)
            .map((f) => f.message)
            .join("; ")}${findings.length > 3 ? "; …" : ""}`
        : "Vorprüfung: Bedarf passt überall in die freien Slots",
      { findings },
    );
    await set({ progress: 5, heartbeatAt: new Date(), log });
    await tick();

    // Heartbeat: Fortschritt + Lebenszeichen schreiben, Sperre verlängern, Abbruchwunsch lesen
    let lastBeat = Date.now();
    const beat = async (progress: number): Promise<boolean> => {
      lastBeat = Date.now();
      const [row] = await db
        .update(timetableSolverRuns)
        .set({ progress, heartbeatAt: new Date() })
        .where(eq(timetableSolverRuns.id, runId))
        .returning({ cancel: timetableSolverRuns.cancelRequested });
      if (opts.lock) await opts.lock.extend();
      return row?.cancel ?? false;
    };

    // 1. Konstruktion in Zeitscheiben (5 … 30 %)
    const solver = createSolver(input);
    let cancelled = false;
    for (;;) {
      const start = performance.now();
      const remaining = solver.construct(() => performance.now() - start < sliceMs);
      opts.onSlice?.("construct");
      if (remaining === 0) break;
      await breathe();
      if (Date.now() - lastBeat >= heartbeatMs) {
        if (await beat(5 + Math.round((25 * (input.units.length - remaining)) / Math.max(1, input.units.length)))) {
          cancelled = true;
          break;
        }
      }
    }
    if (cancelled) {
      note("cancel", "Abgebrochen während der Konstruktion – kein Ergebnis");
      await set({ status: "cancelled", finishedAt: new Date(), heartbeatAt: new Date(), log });
      return "cancelled";
    }
    await tick();
    const built = solver.result();
    note(
      "construct",
      `Konstruktion fertig: ${built.placements.length} von ${input.units.length} Einheiten gesetzt${built.unplaced.length ? `, ${built.unplaced.length} nicht gesetzt (${built.unplaced
        .slice(0, 3)
        .map((u) => `${u.label}: ${u.reason}`)
        .join("; ")}${built.unplaced.length > 3 ? "; …" : ""})` : ""}, Bewertung ${built.score}`,
      { placed: built.placements.length, unplaced: built.unplaced.length, score: built.score },
    );

    // 2. Verbesserung in Zeitscheiben (30 … 95 %), alle 10 % eine Zwischenbewertung
    const factor = EFFORTS[params.effort];
    const steps = Math.max(1, Math.round(solver.total * factor));
    await set({ progress: 30, iterations: steps, heartbeatAt: new Date(), log });
    let done = 0;
    let nextMark = 10;
    let earlyAt: number | null = null;
    // Abbruchwunsch an jeder Phasengrenze lesen, nicht nur im Heartbeat-Takt: ein kurzer Lauf (kleine Schule, schneller Server) ist
    // sonst vor dem ersten Heartbeat fertig und übergeht einen Abbruch, der längst gesetzt war (GATE-SP-E2E, main rot seit d4418f7).
    if (await beat(30)) earlyAt = 30;
    while (earlyAt === null && done < steps) {
      const start = performance.now();
      while (done < steps && performance.now() - start < sliceMs) {
        const n = Math.min(20, steps - done);
        solver.improve(n);
        done += n;
      }
      opts.onSlice?.("improve");
      const pct = Math.round((done / steps) * 100);
      if (pct >= nextMark && done < steps) {
        note("progress", `${pct} % – Bewertung ${solver.score()}`, { percent: pct, score: solver.score() });
        nextMark = Math.floor(pct / 10) * 10 + 10;
        await set({ log });
      }
      if (done >= steps) break;
      await breathe();
      if (Date.now() - lastBeat >= heartbeatMs && (await beat(30 + Math.round((65 * done) / steps)))) {
        earlyAt = 30 + Math.round((65 * done) / steps);
        break;
      }
    }

    // Abbruch während der letzten Scheibe(n) seit dem letzten Heartbeat: der Plan ist gültig, aber als vorzeitig beendet vermerkt
    if (earlyAt === null && (await beat(95))) earlyAt = 95;

    // 3. Ergebnis, Kennzahlen, Protokoll
    await tick();
    const result = solver.result();
    const stored: StoredResult = {
      result,
      units: input.units.map((u) => ({ id: u.id, label: u.label, groupIds: u.groupIds, teacherIds: u.teacherIds, subjectId: u.subjectId, length: u.length, parts: u.parts })),
      keptLessonIds: input.keptLessonIds ?? [],
      refYmd,
      ...(params.versionId ? { versionId: params.versionId } : {}),
    };
    await tick();
    const diag = await proposalDiagnosis(db, stored);
    await tick();
    const diagCount = (c: Finding["category"]) => diag.filter((f) => f.category === c && f.severity !== "info").length;
    const metrics: RunMetrics = {
      score: result.score,
      breakdown: result.breakdown,
      unplaced: result.unplaced.length,
      units: input.units.length,
      steps: result.stats.iterations,
      improved: result.stats.improved,
      durationMs: Date.now() - t0,
      gaps: result.gaps,
      diag: { gaps: diagCount("gaps"), subjectDay: diagCount("subjectDay"), room: diagCount("room") },
      precheck: pre,
      pauses,
      ...(earlyAt !== null ? { cancelledAt: earlyAt } : {}),
    };
    if (earlyAt !== null) note("cancel", `Vorzeitig beendet bei ${earlyAt} % – der bisherige Stand ist ein gültiger Plan`, { percent: earlyAt });
    note("done", `Fertig: Bewertung ${result.score}, ${result.unplaced.length} nicht gesetzt, ${result.stats.iterations} Verbesserungsschritte (${result.stats.improved} Verbesserungen), ${Math.round(metrics.durationMs / 100) / 10} s${pauses ? `, ${pauses} Pausen für Anfragen` : ""}`, { score: result.score, durationMs: metrics.durationMs, pauses });
    await set({ status: "done", progress: 100, result: stored, metrics, log, finishedAt: new Date(), heartbeatAt: new Date() });
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note("error", `Fehler: ${message}`);
    await set({ status: "failed", error: message, finishedAt: new Date(), log });
    return "failed";
  }
}

// ---------------------------------------------------------------- Aufräumen

/** Je Schuljahr behalten so viele fertige Läufe ihr volles Ergebnis. */
export const KEEP_RESULTS_PER_YEAR = 20;
export const DISCARD_FAILED_AFTER_DAYS = 7;

/**
 * Nachtjob „solver-aufraeumen“ (Q-SP-11): fehlgeschlagene/abgebrochene Läufe ohne Ergebnis nach 7 Tagen löschen; von den
 * fertigen Läufen je Schuljahr nur die neuesten 20 mit vollem Ergebnis behalten, ältere behalten Kennzahlen und Protokoll
 * („Ergebnis entfernt“, nicht mehr übernehmbar). Übernommene Läufe bleiben unangetastet. Die Löschklasse LK-90 (Löschlauf) bleibt.
 */
export async function cleanupRuns(db: Db, now = new Date()): Promise<{ deleted: number; trimmed: number; undoCleared: number }> {
  const cutoff = new Date(now.getTime() - DISCARD_FAILED_AFTER_DAYS * 86_400_000);
  // SP-09: Rücknahme-Daten (mit Lehrkraft-IDs) nur, solange die Übernahme zurücknehmbar ist – ab dem Stichtag weg
  const undoCleared = (
    await db
      .update(timetableSolverRuns)
      .set({ undo: null })
      .where(and(eq(timetableSolverRuns.status, "applied"), sql`${timetableSolverRuns.undo} is not null`, lte(timetableSolverRuns.appliedFrom, toBerlinDate(now))))
      .returning({ id: timetableSolverRuns.id })
  ).length;
  const deleted = await db
    .delete(timetableSolverRuns)
    .where(and(inArray(timetableSolverRuns.status, ["failed", "cancelled"]), isNull(timetableSolverRuns.result), lt(timetableSolverRuns.createdAt, cutoff)))
    .returning({ id: timetableSolverRuns.id });
  const done = await db
    .select({ id: timetableSolverRuns.id, schoolYearId: timetableSolverRuns.schoolYearId, log: timetableSolverRuns.log })
    .from(timetableSolverRuns)
    .where(and(eq(timetableSolverRuns.status, "done"), sql`${timetableSolverRuns.result} is not null`))
    .orderBy(desc(timetableSolverRuns.createdAt), desc(timetableSolverRuns.id));
  const seen = new Map<string, number>();
  let trimmed = 0;
  for (const r of done) {
    const n = (seen.get(r.schoolYearId) ?? 0) + 1;
    seen.set(r.schoolYearId, n);
    if (n <= KEEP_RESULTS_PER_YEAR) continue;
    const log = [...((r.log as RunLogEntry[] | null) ?? []), logEntry("cleanup", "Ergebnis entfernt (Aufräumen: nur die neuesten 20 fertigen Läufe behalten den Vorschlag) – Kennzahlen und Protokoll bleiben", undefined, now)].slice(-LOG_LIMIT);
    await db.update(timetableSolverRuns).set({ result: null, log }).where(eq(timetableSolverRuns.id, r.id));
    trimmed++;
  }
  return { deleted: deleted.length, trimmed, undoCleared };
}

// ---------------------------------------------------------------- Vorschau

export interface ProposedLesson {
  /** gemeinsam für alle Zeilen einer Einheit (Kopplung) */
  unitId: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
  coupled: boolean;
  /** SP2-09: Lehrauftrag des Teils (fehlt bei Läufen vor SP-06) – für seine Gültigkeit bei der Übernahme */
  assignmentId?: string;
}

/** Rein: Platzierungen → Stunden-Zeilen (je Teil Gruppen × Lehrkräfte mit dem Raum des Teils, Doppelstunde = zwei Zeilen je Teil). */
export function proposedLessons(stored: StoredResult): ProposedLesson[] {
  const unitOf = new Map(stored.units.map((u) => [u.id, u]));
  const out: ProposedLesson[] = [];
  for (const p of stored.result.placements) {
    const u = unitOf.get(p.unitId);
    if (!u) continue;
    const parts = unitParts(u);
    const rooms = placementRooms(p, parts.length);
    const rowsPerSlot = parts.reduce((s, part) => s + part.groupIds.length * Math.max(1, part.teacherIds.length), 0);
    const coupled = rowsPerSlot > 1;
    for (let k = 0; k < u.length; k++)
      parts.forEach((part, i) => {
        const teachers = part.teacherIds.length ? part.teacherIds : [null];
        for (const g of part.groupIds)
          for (const t of teachers)
            out.push({
              unitId: `${u.id}@${k}`,
              groupId: g,
              subjectId: part.subjectId,
              teacherId: t,
              roomId: rooms[i] ?? null,
              weekday: p.weekday,
              periodNr: p.periodNr + k,
              coupled,
              ...(part.assignmentId ? { assignmentId: part.assignmentId } : {}),
            });
      });
  }
  return out;
}

/**
 * Rein: eine `coupling_id` je Einheit und Stunde für alle Zeilen einer Kopplung (geteilte Klasse, Band – SP2-02: ein Band ist je
 * Stunde eine Kopplung); Einzelstunden bleiben ohne. Übernahme und Demo-Seed nutzen dasselbe.
 */
export function withCouplingIds<T extends Pick<ProposedLesson, "unitId" | "coupled">>(rows: T[], newId: () => string = () => crypto.randomUUID()): (T & { couplingId: string | null })[] {
  const ids = new Map<string, string>();
  return rows.map((l) => {
    if (!l.coupled) return { ...l, couplingId: null };
    if (!ids.has(l.unitId)) ids.set(l.unitId, newId());
    return { ...l, couplingId: ids.get(l.unitId)! };
  });
}

/** Diagnose des Vorschlags (Hohlstunden, Fach mehrfach am Tag, Räume) inklusive der Stunden, die bleiben. */
/** Die Stunden, die ein Lauf behält (fixiert/ohne Lehrauftrag) – SP3-02: aus der Quelle des Laufs (Entwurf oder gültiger Plan). */
export async function keptLessons(db: Db, stored: StoredResult): Promise<DiagLesson[]> {
  if (!stored.keptLessonIds.length) return [];
  const kt = lessonCols(stored.versionId ? draftOf(stored.versionId) : LIVE);
  const out: DiagLesson[] = [];
  for (const part of chunks(stored.keptLessonIds))
    out.push(
      ...(await db
        .select({ id: kt.id, couplingId: kt.couplingId, groupId: kt.groupId, subjectId: kt.subjectId, teacherId: kt.teacherId, roomId: kt.roomId, weekday: kt.weekday, periodNr: kt.periodNr, week: kt.week })
        .from(kt)
        .where(inArray(kt.id, part))),
    );
  return out;
}

export async function proposalDiagnosis(db: Db, stored: StoredResult): Promise<Finding[]> {
  const kept = await keptLessons(db, stored);
  const lessons: DiagLesson[] = [
    ...proposedLessons(stored).map((l, i) => ({ ...l, id: `p${i}`, couplingId: l.coupled ? l.unitId : null, week: "all" as const })),
    ...kept.map((l) => ({
      id: l.id,
      couplingId: l.couplingId,
      groupId: l.groupId,
      subjectId: l.subjectId,
      teacherId: l.teacherId,
      roomId: l.roomId,
      weekday: l.weekday,
      periodNr: l.periodNr,
      week: l.week,
    })),
  ];
  const [periodRows, groupRows, sizes, teacherRows, subjectRows, roomRows] = await Promise.all([
    db.select({ nr: periods.nr }).from(periods).orderBy(periods.nr),
    db.select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel }).from(groups),
    db.select({ groupId: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.role, "member")),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")),
    db.select({ id: subjects.id, name: subjects.name, roomKind: subjects.roomKind }).from(subjects),
    db.select({ id: rooms.id, kind: rooms.kind, capacity: rooms.capacity, active: rooms.active }).from(rooms),
  ]);
  const sizeOf = new Map<string, number>();
  for (const s of sizes) sizeOf.set(s.groupId, (sizeOf.get(s.groupId) ?? 0) + 1);
  return diagnose({
    lessons,
    periods: periodRows.map((p) => p.nr),
    groups: groupRows.map((g) => ({ ...g, size: sizeOf.get(g.id) ?? 0 })),
    teachers: teacherRows,
    subjects: subjectRows,
    rooms: roomRows,
    distribution: { assignments: [], unmatched: [], curriculum: new Map() },
    accounts: [],
  }).filter((f) => f.category === "gaps" || f.category === "subjectDay" || f.category === "room");
}

// ---------------------------------------------------------------- Übernehmen

/** In Abfragen mit `inArray` höchstens so viele IDs je Aufruf. */
const CHUNK = 500;
const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

type LessonSlot = Pick<TimetableLesson, "weekday" | "periodNr" | "roomId" | "week" | "validFrom" | "validUntil">;

/**
 * Raumbuchungen und Klausuren ab `fromYmd` in einem Raum, den eine der Stunden zu dieser Zeit belegt (Wochentag, Stunde,
 * Gültigkeit, A/B-Woche grob: `week` ≠ `all` zählt jede Woche). Die Übernahme ändert daran nichts – die Zahl zeigt der
 * Planung, wo sie nach dem Übernehmen bzw. Zurücknehmen Räume prüfen sollte.
 */
async function roomClashes(db: Db, lessons: LessonSlot[], fromYmd: string): Promise<{ bookings: number; exams: number }> {
  const withRoom = lessons.filter((l) => l.roomId);
  if (!withRoom.length) return { bookings: 0, exams: 0 };
  const byRoom = new Map<string, LessonSlot[]>();
  for (const l of withRoom) byRoom.set(l.roomId!, [...(byRoom.get(l.roomId!) ?? []), l]);
  const hits = (roomId: string | null, date: string, from: number, to: number) => {
    if (!roomId || date < fromYmd) return false;
    const wd = weekdayMon0(date);
    return (byRoom.get(roomId) ?? []).some((l) => l.weekday === wd && l.periodNr >= from && l.periodNr <= to && l.validFrom <= date && (l.validUntil === null || l.validUntil >= date));
  };
  const [bookingRows, examRows] = await Promise.all([
    db
      .select({ roomId: bookingResources.roomId, date: bookings.date, periodNr: bookings.periodNr })
      .from(bookings)
      .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
      .where(and(gte(bookings.date, fromYmd), inArray(bookingResources.roomId, [...byRoom.keys()]))),
    db
      .select({ roomId: exams.roomId, date: exams.date, from: exams.periodFrom, to: exams.periodTo })
      .from(exams)
      .where(and(gte(exams.date, fromYmd), inArray(exams.roomId, [...byRoom.keys()]))),
  ]);
  return {
    bookings: bookingRows.filter((b) => hits(b.roomId, b.date, b.periodNr, b.periodNr)).length,
    exams: examRows.filter((e) => hits(e.roomId, e.date, e.from, e.to)).length,
  };
}

/** SP2-09: Gültigkeit der Lehraufträge der vorgeschlagenen Stunden (gelöschte fehlen – ihre Stunden gelten bis Schuljahresende). */
async function assignmentValidity(db: Db, proposal: ProposedLesson[]): Promise<Map<string, { validFrom: string | null; validUntil: string | null }>> {
  const ids = [...new Set(proposal.map((l) => l.assignmentId).filter((id): id is string => !!id))];
  const out = new Map<string, { validFrom: string | null; validUntil: string | null }>();
  for (const part of chunks(ids))
    for (const a of await db
      .select({ id: timetableAssignments.id, validFrom: timetableAssignments.validFrom, validUntil: timetableAssignments.validUntil })
      .from(timetableAssignments)
      .where(inArray(timetableAssignments.id, part)))
      out.set(a.id, { validFrom: a.validFrom, validUntil: a.validUntil });
  return out;
}

/**
 * R1a/A2: Planungszeitraum eines Laufs mit Planungsstand `refYmd` – der längste Zeitraum um `refYmd`, in dem kein Lehrauftrag gilt,
 * den der Lauf nicht kennt (der am Planungsstand nicht galt). Er endet am Vortag, an dem der nächste solche Lehrauftrag beginnt
 * (sonst am Schuljahresende), und beginnt am Tag nach dem Ende des letzten solchen (sonst am Schuljahresbeginn). Lehraufträge,
 * die der Lauf kennt, begrenzen ihn nicht: ihre Stunden enden mit ihnen (SP2-09), ein späterer Beginn lehnt die Übernahme ab.
 */
export function planningPeriod(
  refYmd: string,
  year: { startsOn: string; endsOn: string },
  assignments: { validFrom: string | null; validUntil: string | null }[],
): { from: string; until: string } {
  let from = year.startsOn;
  let until = year.endsOn;
  for (const a of assignments) {
    if (a.validFrom !== null && a.validFrom > refYmd) {
      const before = addDays(a.validFrom, -1);
      if (before < until) until = before;
    }
    if (a.validUntil !== null && a.validUntil < refYmd) {
      const after = addDays(a.validUntil, 1);
      if (after > from) from = after;
    }
  }
  return { from, until };
}

/** Planungszeitraum eines gespeicherten Laufs nach den aktuellen Lehraufträgen des Schuljahres. */
async function runPeriod(db: Db, year: { id: string; startsOn: string; endsOn: string }, stored: StoredResult) {
  const rows = await db
    .select({ validFrom: timetableAssignments.validFrom, validUntil: timetableAssignments.validUntil })
    .from(timetableAssignments)
    .where(eq(timetableAssignments.schoolYearId, year.id));
  return planningPeriod(stored.refYmd, year, rows);
}

/**
 * Stunden, die die Übernahme ab `fromYmd` ersetzen würde: gültig zwischen dem Stichtag und dem Ende des Planungszeitraums
 * (`untilYmd`), nicht fixiert, nicht „bleibt“ (ohne Lehrauftrag). Stunden, die erst nach dem Zeitraum beginnen, bleiben (A2).
 */
async function replaceableLessons(db: Db, untilYmd: string, fromYmd: string, kept: Set<string>): Promise<TimetableLesson[]> {
  return (
    await db
      .select()
      .from(timetableLessons)
      .where(and(lte(timetableLessons.validFrom, untilYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, fromYmd))))
  ).filter((l) => !l.fixed && !kept.has(l.id));
}

/**
 * R1a/A2: teilt ersetzbare Stunden, die über das Ende des Planungszeitraums hinaus gelten (wie „Periode kopieren“): die Stunde
 * endet am letzten Tag des Zeitraums, eine Kopie (neue Kopplungs-id je Kopplung, gleiche Herkunft und Anlagezeit) gilt danach bis
 * zum bisherigen Ende; Vertretungen (auch als aufnehmende Stunde), Klassenbuch und Material ab dann ziehen auf die Kopie um.
 */
async function splitAfter(tx: Db, lessons: TimetableLesson[], untilYmd: string): Promise<{ id: string; of: string }[]> {
  const cutoff = addDays(untilYmd, 1);
  const crossing = lessons.filter((l) => l.validUntil === null || l.validUntil > untilYmd);
  if (!crossing.length) return [];
  const couplings = new Map<string, string>();
  const copies = crossing.map((l) => {
    let couplingId: string | null = null;
    if (l.couplingId) {
      if (!couplings.has(l.couplingId)) couplings.set(l.couplingId, crypto.randomUUID());
      couplingId = couplings.get(l.couplingId)!;
    }
    return { ...l, id: crypto.randomUUID(), couplingId, validFrom: cutoff };
  });
  for (const part of chunks(copies)) await tx.insert(timetableLessons).values(part);
  for (const part of chunks(crossing.map((l) => l.id))) await tx.update(timetableLessons).set({ validUntil: untilYmd }).where(inArray(timetableLessons.id, part));
  const out = copies.map((c, i) => ({ id: c.id, of: crossing[i]!.id }));
  for (const { id, of } of out) await moveReferences(tx, of, id, cutoff);
  return out;
}

/** Vertretungen, Zusammenlegungen, Klassenbuch und Material einer Stunde ab `fromYmd` auf eine andere Stunde umhängen. */
async function moveReferences(tx: Db, fromId: string, toId: string, fromYmd: string): Promise<void> {
  await tx.update(timetableSubstitutions).set({ lessonId: toId }).where(and(eq(timetableSubstitutions.lessonId, fromId), gte(timetableSubstitutions.date, fromYmd)));
  await tx.update(timetableSubstitutions).set({ mergeLessonId: toId }).where(and(eq(timetableSubstitutions.mergeLessonId, fromId), gte(timetableSubstitutions.date, fromYmd)));
  await tx.update(classbookEntries).set({ lessonId: toId }).where(and(eq(classbookEntries.lessonId, fromId), gte(classbookEntries.date, fromYmd)));
  await tx.update(timetableAbsenceMaterials).set({ lessonId: toId }).where(and(eq(timetableAbsenceMaterials.lessonId, fromId), gte(timetableAbsenceMaterials.date, fromYmd)));
  // VT-01: die Historie hängt mit um
  await moveChangeHistory(tx, fromId, toId, fromYmd);
}

/** Vertretungen ab `fromYmd` an diesen Stunden – auch Zusammenlegungen anderer Gruppen in diese Stunden (R1a/A1). */
const substitutionsOn = (ids: string[], fromYmd: string) =>
  and(or(inArray(timetableSubstitutions.lessonId, ids), inArray(timetableSubstitutions.mergeLessonId, ids)), gte(timetableSubstitutions.date, fromYmd));

/** Was eine Übernahme ab `fromYmd` ändern würde (Hinweis vor dem Übernehmen, SP-09). */
export interface ApplyPreview {
  from: string;
  /** Stunden, die am Vortag enden */
  ended: number;
  /** Stunden, die ganz entfallen (sie beginnen erst ab dem Stichtag) */
  deleted: number;
  /** Vertretungen ab dem Stichtag an ersetzten Stunden – sie entfallen; das Zurücknehmen stellt sie wieder her, sofern ihre Stunde dann wieder gilt (SP-13) */
  substitutions: number;
  /** Raumbuchungen/Klausuren ab dem Stichtag in Räumen, die der Vorschlag zu dieser Zeit belegt */
  roomClashes: { bookings: number; exams: number };
  /** R1a/A2: Ende des Planungszeitraums, wenn er vor dem Schuljahresende endet (danach bleibt der Plan, wie er ist), sonst `null` */
  until: string | null;
}

export async function applyPreview(db: Db, run: SolverRun, fromYmd: string): Promise<ApplyPreview | null> {
  // SP3-02: im Entwurf gerechnete Läufe gehen nur in einen Entwurf
  if (!run.stored || run.stored.versionId) return null;
  const year = await planningYear(db);
  if (!year) return null;
  const period = await runPeriod(db, year, run.stored);
  const current = await replaceableLessons(db, period.until, fromYmd, new Set(run.stored.keptLessonIds));
  const ids = current.map((l) => l.id);
  const subIds = new Set<string>();
  // nach dem Zeitraumende ziehen Vertretungen auf die Kopie um (Teilen) – sie entfallen nicht
  for (const part of chunks(ids))
    for (const s of await db.select({ id: timetableSubstitutions.id }).from(timetableSubstitutions).where(and(substitutionsOn(part, fromYmd), lte(timetableSubstitutions.date, period.until))))
      subIds.add(s.id);
  const proposal = proposedLessons(run.stored).map((l) => ({ ...l, week: "all" as const, validFrom: fromYmd, validUntil: period.until }));
  return {
    from: fromYmd,
    ended: current.filter((l) => l.validFrom < fromYmd).length,
    deleted: current.filter((l) => l.validFrom >= fromYmd).length,
    substitutions: subIds.size,
    roomClashes: await roomClashes(db, proposal, fromYmd),
    until: period.until < year.endsOn ? period.until : null,
  };
}

/**
 * Übernimmt den Vorschlag ab `fromYmd` (ein Schultag in der Zukunft, im Schuljahr): alle übrigen Stunden des Schuljahres
 * (nicht fixiert, mit Lehrauftrag) enden am Vortag bzw. werden gelöscht, wenn sie erst danach beginnen; Vertretungen ab dem
 * Stichtag an diesen Stunden entfallen. Die vorgeschlagenen Stunden gelten ab dem Stichtag bis zum Schuljahresende und tragen
 * den Lauf als Herkunft (SP-06). Was geändert wurde, steht in `undo` – „Übernahme zurücknehmen“ (SP-09) stellt es bis zum
 * Stichtag wieder her, auch die entfernten Vertretungen, sofern ihre Stunde an dem Tag wieder gilt (SP-13).
 */
export async function applyRun(
  db: Db,
  actorId: string,
  runId: string,
  fromYmd: string,
  todayYmd: string,
): Promise<{ created: number; ended: number; deleted: number; removedSubstitutions: number; expired?: number }> {
  const run = await getRun(db, runId);
  if (!run || run.status !== "done") throw new ValidationError({ run: "Nur ein fertiger, noch nicht übernommener Lauf lässt sich übernehmen" });
  if (!run.stored) throw new ValidationError({ run: "Das Ergebnis dieses Laufs wurde beim Aufräumen entfernt – einen neuen Lauf starten" });
  // SP3-02: ein im Entwurf gerechneter Lauf behält Entwurfsstunden – er geht nur in einen Entwurf (F-10-1)
  if (run.stored.versionId || run.params?.versionId) throw new ValidationError({ run: "Dieser Lauf wurde in einem Entwurf gerechnet – in den Entwurf übernehmen" });
  const year = await planningYear(db);
  if (!year) throw new ValidationError({ run: "Kein Schuljahr" });
  if (!isCalendarDate(fromYmd) || fromYmd <= todayYmd) throw new ValidationError({ from: "Der Stichtag muss in der Zukunft liegen" });
  if (fromYmd < year.startsOn || fromYmd > year.endsOn) throw new ValidationError({ from: "Der Stichtag muss im Schuljahr liegen" });
  const cal = await loadSchoolCalendar(db);
  if (!cal.isSchoolDay(fromYmd)) {
    const next = cal.nextSchoolDay(fromYmd);
    const why = weekdayMon0(fromYmd) >= 5 ? "Wochenende" : (cal.dayOff(fromYmd)?.kind === "feiertag" ? "Feiertag" : "Ferien/frei");
    throw new ValidationError({ from: `Der Stichtag ${dayFmt.format(fromBerlinLocal(fromYmd))} ist kein Schultag (${why}) – nächster Schultag: ${next}` });
  }
  if (run.stored.result.unplaced.length)
    throw new ValidationError({ run: `${run.stored.result.unplaced.length} Stunden ließen sich nicht setzen – erst Lehraufträge oder Sperrzeiten anpassen` });
  const kept = new Set(run.stored.keptLessonIds);
  const proposal = proposedLessons(run.stored);
  const dayBefore = addDays(fromYmd, -1);
  // SP2-09: Gültigkeit der Lehraufträge (aktueller Stand) – eine Stunde endet mit ihrem Lehrauftrag; Lehraufträge, die erst nach dem
  // Stichtag beginnen, würden zu früh gesetzt → Übernahme erst ab ihrem Beginn. Ohne Gültigkeit (oder Lehrauftrag gelöscht): bis Schuljahresende.
  const validity = await assignmentValidity(db, proposal);
  const startsLater = [...validity.values()].map((v) => v.validFrom).filter((v): v is string => v !== null && v > fromYmd).sort();
  if (startsLater.length)
    throw new ValidationError({
      from: `Lehraufträge dieses Laufs gelten erst ab ${dayFmt.format(fromBerlinLocal(startsLater.at(-1)!))} – Übernahme frühestens ab diesem Tag (oder den Lauf mit einem anderen Planungsstand rechnen)`,
    });
  // R1a/A2: nur der Planungszeitraum des Laufs wird ersetzt – vorher (anderer Planungsstand) lässt er sich nicht übernehmen,
  // danach bleibt der Plan, wie er ist (dort gilt ein Lehrauftrag, den der Lauf nicht kennt)
  const period = await runPeriod(db, year, run.stored);
  const periodHint = `Planungsstand ${dayFmt.format(fromBerlinLocal(run.stored.refYmd))}`;
  if (fromYmd < period.from)
    throw new ValidationError({ from: `Dieser Lauf gilt erst ab ${dayFmt.format(fromBerlinLocal(period.from))} (${periodHint}) – Übernahme frühestens ab diesem Tag` });
  if (fromYmd > period.until)
    throw new ValidationError({
      from: `Dieser Lauf gilt nur bis ${dayFmt.format(fromBerlinLocal(period.until))} (${periodHint}; danach gelten andere Lehraufträge) – für einen späteren Stichtag einen Lauf mit passendem Planungsstand rechnen`,
    });
  const untilOf = (l: ProposedLesson) => {
    const v = l.assignmentId ? validity.get(l.assignmentId)?.validUntil : null;
    return v && v < period.until ? v : period.until;
  };
  const expired = proposal.filter((l) => untilOf(l) < fromYmd).length;

  const out = await db.transaction(async (tx) => {
    let current = await replaceableLessons(tx, period.until, fromYmd, kept);
    // Stunden über das Zeitraumende hinaus teilen; ersetzt wird dann nur der Teil im Zeitraum
    const split = period.until < year.endsOn ? await splitAfter(tx, current, period.until) : [];
    if (split.length) current = await replaceableLessons(tx, period.until, fromYmd, kept);
    const ids = current.map((l) => l.id);
    const later = current.filter((l) => l.validFrom >= fromYmd);
    const running = current.filter((l) => l.validFrom < fromYmd);
    const removed: UndoSubstitution[] = [];
    const gone: TimetableSubstitution[] = [];
    for (const part of chunks(ids))
      for (const s of await tx.delete(timetableSubstitutions).where(substitutionsOn(part, fromYmd)).returning()) {
        gone.push(s);
        removed.push({
          id: s.id,
          lessonId: s.lessonId,
          date: s.date,
          kind: s.kind,
          substituteId: s.substituteId,
          roomId: s.roomId,
          note: s.note,
          subjectId: s.subjectId,
          targetPeriod: s.targetPeriod,
          mergeLessonId: s.mergeLessonId,
          createdBy: s.createdBy,
          createdAt: s.createdAt.toISOString(),
          reason: s.reason,
          internalNote: s.internalNote,
          supervisionOnly: s.supervisionOnly,
        });
      }
    // VT-01: die bei der Übernahme entfernten Vertretungen stehen in der Historie (`plan_publish`)
    await recordSubstitutionChanges(tx, actorId, deletedEntries(gone, "plan_publish"));
    const removedSubstitutions = removed.length;
    for (const part of chunks(later.map((l) => l.id))) await tx.delete(timetableLessons).where(inArray(timetableLessons.id, part));
    for (const part of chunks(running.map((l) => l.id))) await tx.update(timetableLessons).set({ validUntil: dayBefore }).where(inArray(timetableLessons.id, part));
    const undo: UndoData = {
      ended: running.map((l) => ({ id: l.id, validUntil: l.validUntil })),
      deleted: later.map(({ id, groupId, weekday, periodNr, subjectId, teacherId, roomId, week, validFrom, validUntil, couplingId, fixed, solverRunId }) => ({ id, groupId, weekday, periodNr, subjectId, teacherId, roomId, week, validFrom, validUntil, couplingId, fixed, solverRunId })),
      removedSubstitutions,
      substitutions: removed,
      ...(split.length ? { split } : {}),
    };
    // SP-14: Lehrkräfte, deren Konto seit dem Lauf gelöscht wurde („gelöschte Lehrkraft“), werden leer – die Stunde bleibt offen
    const knownUsers = new Set((await tx.select({ id: users.id }).from(users)).map((u) => u.id));
    const rows = withCouplingIds(proposal.filter((l) => untilOf(l) >= fromYmd)).map((l) => ({
      groupId: l.groupId,
      subjectId: l.subjectId,
      teacherId: l.teacherId && knownUsers.has(l.teacherId) ? l.teacherId : null,
      roomId: l.roomId,
      weekday: l.weekday,
      periodNr: l.periodNr,
      week: "all" as const,
      validFrom: fromYmd,
      validUntil: untilOf(l),
      couplingId: l.couplingId,
      solverRunId: runId,
    }));
    for (const part of chunks(rows)) await tx.insert(timetableLessons).values(part);
    const result = { created: rows.length, ended: running.length, deleted: later.length, removedSubstitutions, ...(expired ? { expired } : {}) };
    const log = [
      ...run.log,
      logEntry(
        "apply",
        `Übernommen ab ${dayFmt.format(fromBerlinLocal(fromYmd))}: ${result.created} Stunden gesetzt, ${result.ended} bestehende enden am Vortag, ${result.deleted} später beginnende entfallen, ${removedSubstitutions} Vertretungen ab dem Stichtag entfallen${expired ? `, ${expired} Stunden nicht gesetzt (Lehrauftrag endet vor dem Stichtag)` : ""}${period.until < year.endsOn ? `; ersetzt nur bis ${dayFmt.format(fromBerlinLocal(period.until))}${split.length ? ` (${split.length} Stunden dort geteilt)` : ""}` : ""}`,
        { from: fromYmd, ...result, ...(period.until < year.endsOn ? { until: period.until } : {}) },
      ),
    ].slice(-LOG_LIMIT);
    const changed = await tx
      .update(timetableSolverRuns)
      .set({ status: "applied", appliedFrom: fromYmd, appliedBy: actorId, appliedAt: new Date(), undo, log })
      .where(and(eq(timetableSolverRuns.id, runId), eq(timetableSolverRuns.status, "done")))
      .returning({ id: timetableSolverRuns.id });
    if (!changed.length) throw new ValidationError({ run: "Der Lauf wurde inzwischen verändert – Seite neu laden" });
    return result;
  });
  await audit(db, actorId, "stundenplan.solver.apply", null, { run: runId, from: fromYmd, ...out });
  return out;
}

// ---------------------------------------------------------------- Übernahme in den Entwurf (SP3-02, F-10-1)

/** Ziel der Übernahme: ein offener Entwurf oder ein neuer Entwurf aus dem gültigen Plan ab Stichtag. */
export type DraftTarget = { versionId: string } | { newDraft: { validFrom: string; name?: string | null } };

/** Was die Übernahme in den Entwurf getan hat. */
export interface DraftApplyResult {
  versionId: string;
  /** Stichtag des Entwurfs (ab dann gelten die neuen Stunden) */
  from: string;
  /** neu gesetzte Stunden des Laufs */
  created: number;
  /** ersetzte Entwurfsstunden (ganz im Planungszeitraum, entfernt) */
  replaced: number;
  /** Entwurfsstunden, die über den Zeitraum hinausreichen – gekürzt, der Teil davor/danach bleibt */
  trimmed: number;
  /** behaltene Entwurfsstunden (fixiert, ohne Lehrauftrag, vom Lauf behalten) */
  kept: number;
  /** neue Stunden, die die Herkunft (`origin_lesson_id`) einer ersetzten Stunde übernommen haben */
  withOrigin: number;
  /** Stunden, deren Lehrauftrag vor dem Stichtag endet (nicht gesetzt) */
  expired?: number;
}

type OriginKey = Pick<ProposedLesson, "groupId" | "subjectId" | "teacherId" | "weekday" | "periodNr">;

/**
 * Rein (SP3-02): Herkunft je neuer Stunde aus den ersetzten Entwurfsstunden, damit das Veröffentlichen (SP3-04) „geändert“ statt
 * „entfallen + neu“ erkennt – zuerst gleicher Slot (Gruppe, Fach, Lehrkraft, Tag, Stunde), dann gleiche Gruppe/Fach/Lehrkraft, dann
 * gleiche Gruppe/Fach. Jede Herkunft wird höchstens einmal vergeben; ersetzte Stunden ohne Herkunft (neu im Entwurf) zählen nicht.
 */
export function carryOrigins(fresh: OriginKey[], replaced: (OriginKey & { originLessonId: string | null })[]): (string | null)[] {
  const out: (string | null)[] = fresh.map(() => null);
  const used = new Set<number>();
  const keys: ((l: OriginKey) => string)[] = [
    (l) => `${l.groupId}|${l.subjectId}|${l.teacherId ?? ""}|${l.weekday}|${l.periodNr}`,
    (l) => `${l.groupId}|${l.subjectId}|${l.teacherId ?? ""}`,
    (l) => `${l.groupId}|${l.subjectId}`,
  ];
  for (const key of keys) {
    const pool = new Map<string, number[]>();
    replaced.forEach((r, j) => {
      if (!r.originLessonId || used.has(j)) return;
      const k = key(r);
      pool.set(k, [...(pool.get(k) ?? []), j]);
    });
    fresh.forEach((f, i) => {
      if (out[i] !== null) return;
      const j = pool.get(key(f))?.find((x) => !used.has(x));
      if (j === undefined) return;
      used.add(j);
      out[i] = replaced[j]!.originLessonId;
    });
  }
  return out;
}

/** Offene, bearbeitbare Entwürfe des Schuljahres (Ziele der Übernahme), neueste zuerst. */
export async function draftTargets(db: Db, schoolYearId: string) {
  return db
    .select({ id: timetablePlanVersions.id, major: timetablePlanVersions.major, minor: timetablePlanVersions.minor, name: timetablePlanVersions.name, validFrom: timetablePlanVersions.validFrom })
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), eq(timetablePlanVersions.status, "entwurf")))
    .orderBy(desc(timetablePlanVersions.createdAt), desc(timetablePlanVersions.id));
}

/** Fachliche Felder einer Entwurfsstunde zum Kopieren. */
const draftRowFields = (r: typeof timetableDraftLessons.$inferSelect): NewLessonRow => ({
  groupId: r.groupId,
  weekday: r.weekday,
  periodNr: r.periodNr,
  subjectId: r.subjectId,
  teacherId: r.teacherId,
  roomId: r.roomId,
  week: r.week,
  validFrom: r.validFrom,
  validUntil: r.validUntil,
  couplingId: r.couplingId,
  fixed: r.fixed,
  solverRunId: r.solverRunId,
});

/**
 * SP3-02 (F-10-1): „Übernehmen“ füllt einen Entwurf statt des gültigen Plans. Ab dem Stichtag des Entwurfs ersetzt der Vorschlag im
 * Planungszeitraum des Laufs alle Entwurfsstunden, die nicht fixiert sind, die der Lauf nicht behalten hat und die einem Lehrauftrag
 * entsprechen (wie `applyRun()` im gültigen Plan). Stunden, die über den Zeitraum hinausreichen, werden gekürzt (Teil davor/danach
 * bleibt). Neue Stunden tragen den Lauf (`solver_run_id`), ihren Lehrauftrag und – wo möglich – die Herkunft der ersetzten Stunde
 * (`carryOrigins`). Der gültige Plan, Vertretungen und Klassenbuch bleiben unberührt; es gibt deshalb keine Rücknahme-Daten – der
 * Entwurf lässt sich verwerfen oder vorher als Variante sichern. Der Lauf bleibt „fertig“ (in weitere Entwürfe übernehmbar).
 */
export async function applyRunToDraft(db: Db, actorId: string, runId: string, target: DraftTarget, todayYmd: string): Promise<DraftApplyResult> {
  const run = await getRun(db, runId);
  if (!run || run.status !== "done") throw new ValidationError({ run: "Nur ein fertiger Lauf lässt sich in einen Entwurf übernehmen" });
  if (!run.stored) throw new ValidationError({ run: "Das Ergebnis dieses Laufs wurde beim Aufräumen entfernt – einen neuen Lauf starten" });
  if (run.stored.result.unplaced.length)
    throw new ValidationError({ run: `${run.stored.result.unplaced.length} Stunden ließen sich nicht setzen – erst Lehraufträge oder Sperrzeiten anpassen` });
  const stored = run.stored;
  const year = await planningYear(db);
  if (!year || year.id !== run.schoolYearId) throw new ValidationError({ run: "Der Lauf gehört nicht zum Planungsjahr" });
  let version = "versionId" in target ? await requireWritable(db, draftOf(target.versionId)) : null;
  if (version && version.schoolYearId !== year.id) throw new ValidationError({ versionId: "Entwurf des Planungsjahrs wählen" });
  const fromYmd = version ? version.validFrom : "newDraft" in target ? target.newDraft.validFrom : null;
  if (!fromYmd || !isCalendarDate(fromYmd)) throw new ValidationError({ from: "Stichtag wählen" });

  // Lehraufträge und Planungszeitraum wie bei der Übernahme in den gültigen Plan
  const proposal = proposedLessons(stored);
  const validity = await assignmentValidity(db, proposal);
  const startsLater = [...validity.values()].map((v) => v.validFrom).filter((v): v is string => v !== null && v > fromYmd).sort();
  if (startsLater.length)
    throw new ValidationError({
      from: `Lehraufträge dieses Laufs gelten erst ab ${dayFmt.format(fromBerlinLocal(startsLater.at(-1)!))} – einen Entwurf mit späterem Stichtag wählen (oder den Lauf mit einem anderen Planungsstand rechnen)`,
    });
  const period = await runPeriod(db, year, stored);
  const periodHint = `Planungsstand ${dayFmt.format(fromBerlinLocal(stored.refYmd))}`;
  if (fromYmd < period.from) throw new ValidationError({ from: `Dieser Lauf gilt erst ab ${dayFmt.format(fromBerlinLocal(period.from))} (${periodHint}) – einen Entwurf mit Stichtag ab diesem Tag wählen` });
  if (fromYmd > period.until)
    throw new ValidationError({ from: `Dieser Lauf gilt nur bis ${dayFmt.format(fromBerlinLocal(period.until))} (${periodHint}; danach gelten andere Lehraufträge) – einen Entwurf mit früherem Stichtag wählen` });
  const untilOf = (l: ProposedLesson) => {
    const v = l.assignmentId ? validity.get(l.assignmentId)?.validUntil : null;
    return v && v < period.until ? v : period.until;
  };
  const expired = proposal.filter((l) => untilOf(l) < fromYmd).length;

  // neuer Entwurf erst nach den Prüfungen: Kopie des gültigen Plans ab Stichtag, Quelle „Solver-Lauf“
  if (!version && "newDraft" in target) {
    const name = (target.newDraft.name?.trim() || `Aus Solver-Lauf${run.label ? ` „${run.label}“` : ""}`).slice(0, 80);
    const created = await createDraft(db, actorId, { schoolYearId: year.id, source: "live_copy", validFrom: fromYmd, numbering: "major", name }, todayYmd);
    const [updated] = await db.update(timetablePlanVersions).set({ source: "solver_run", sourceRunId: run.id }).where(eq(timetablePlanVersions.id, created.id)).returning();
    version = updated!;
  }
  const v = version!;
  const source = draftOf(v.id);

  const out = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const rows = await t
      .select()
      .from(timetableDraftLessons)
      .where(eq(timetableDraftLessons.versionId, v.id))
      .orderBy(asc(timetableDraftLessons.createdAt), asc(timetableDraftLessons.id));
    // behalten: fixiert, vom Lauf behalten (gleicher Entwurf: die Stunde; sonst über ihre Herkunft) und Stunden ohne Lehrauftrag im Entwurf
    const keptIds = new Set(stored.keptLessonIds);
    const sameSource = stored.versionId === v.id;
    const unmatched = new Set((await distribution(t, year, fromYmd, { source })).unmatched.map((l) => l.id));
    const isKept = (r: (typeof rows)[number]) =>
      r.fixed || keptIds.has(r.id) || (!sameSource && r.originLessonId !== null && keptIds.has(r.originLessonId)) || unmatched.has(r.id);
    const kept = rows.filter(isKept);
    const replaceable = rows.filter((r) => !isKept(r) && r.validFrom <= period.until && (r.validUntil === null || r.validUntil >= fromYmd));
    const dayBefore = addDays(fromYmd, -1);
    const dayAfter = addDays(period.until, 1);
    let replaced = 0;
    let trimmed = 0;
    for (const r of replaceable) {
      const head = r.validFrom < fromYmd;
      const tail = r.validUntil === null || r.validUntil > period.until;
      if (!head && !tail) {
        await tx.delete(timetableDraftLessons).where(eq(timetableDraftLessons.id, r.id));
        replaced++;
        continue;
      }
      trimmed++;
      if (head) await tx.update(timetableDraftLessons).set({ validUntil: dayBefore }).where(eq(timetableDraftLessons.id, r.id));
      // Teil nach dem Zeitraum: an der Zeile (nur Ende) bzw. als Kopie mit gleicher Herkunft (Anfang und Ende)
      if (tail && head) await insertLessonRows(t, source, [{ ...draftRowFields(r), validFrom: dayAfter, validUntil: r.validUntil, originLessonId: r.originLessonId, assignmentId: r.assignmentId }]);
      else if (tail) await tx.update(timetableDraftLessons).set({ validFrom: dayAfter }).where(eq(timetableDraftLessons.id, r.id));
    }
    // SP-14: Lehrkräfte, deren Konto seit dem Lauf gelöscht wurde, werden leer – die Stunde bleibt offen
    const knownUsers = new Set((await tx.select({ id: users.id }).from(users)).map((u) => u.id));
    const fresh = withCouplingIds(proposal.filter((l) => untilOf(l) >= fromYmd));
    const origins = carryOrigins(fresh, replaceable);
    const assignmentOfOrigin = new Map(replaceable.filter((r) => r.originLessonId).map((r) => [r.originLessonId!, r.assignmentId]));
    const newRows: NewLessonRow[] = fresh.map((l, i) => ({
      groupId: l.groupId,
      subjectId: l.subjectId,
      teacherId: l.teacherId && knownUsers.has(l.teacherId) ? l.teacherId : null,
      roomId: l.roomId,
      weekday: l.weekday,
      periodNr: l.periodNr,
      week: "all",
      validFrom: fromYmd,
      validUntil: untilOf(l),
      couplingId: l.couplingId,
      solverRunId: runId,
      originLessonId: origins[i],
      assignmentId: l.assignmentId ?? (origins[i] ? (assignmentOfOrigin.get(origins[i]!) ?? null) : null),
    }));
    await insertLessonRows(t, source, newRows);
    await tx.update(timetablePlanVersions).set({ sourceRunId: runId }).where(eq(timetablePlanVersions.id, v.id));
    const result: DraftApplyResult = {
      versionId: v.id,
      from: fromYmd,
      created: newRows.length,
      replaced,
      trimmed,
      kept: kept.length,
      withOrigin: origins.filter(Boolean).length,
      ...(expired ? { expired } : {}),
    };
    const log = [
      ...run.log,
      logEntry(
        "apply",
        `In den Entwurf ${versionNumber(v)} „${v.name}“ übernommen (ab ${dayFmt.format(fromBerlinLocal(fromYmd))}): ${result.created} Stunden gesetzt, ${replaced} Entwurfsstunden ersetzt${trimmed ? `, ${trimmed} gekürzt` : ""}, ${kept.length} behalten${expired ? `, ${expired} Stunden nicht gesetzt (Lehrauftrag endet vor dem Stichtag)` : ""} – der gültige Plan bleibt unverändert`,
        { draft: v.id, version: versionNumber(v), ...result },
      ),
    ].slice(-LOG_LIMIT);
    await tx.update(timetableSolverRuns).set({ log }).where(and(eq(timetableSolverRuns.id, runId), eq(timetableSolverRuns.status, "done")));
    return result;
  });
  await audit(db, actorId, "stundenplan.solver.apply_draft", null, { run: runId, draft: v.id, version: versionNumber(v), from: fromYmd, created: out.created, replaced: out.replaced, trimmed: out.trimmed, kept: out.kept });
  return out;
}

// ---------------------------------------------------------------- Zurücknehmen (SP-09)

/** Was „Übernahme zurücknehmen“ tun würde bzw. getan hat – mit den Konfliktfällen, die die Planung kennen sollte. */
export interface UndoPreview {
  /** Stunden des Laufs, die entfernt werden */
  lessons: number;
  /** davon seit der Übernahme von Hand verändert (verschoben, andere Lehrkraft/anderer Raum, fixiert) – sie werden trotzdem entfernt */
  changed: number;
  /** Vertretungen an Stunden des Laufs – gehen verloren */
  substitutions: number;
  /** Klassenbucheinträge an Stunden des Laufs – bleiben, verlieren aber den Bezug zur Stunde */
  classbook: number;
  /** Vertretungsmaterial an Stunden des Laufs – geht verloren */
  materials: number;
  /** beendete Stunden, die wieder bis zu ihrem früheren Ende gelten */
  restorable: number;
  /** beendete Stunden, die sich nicht wiederherstellen lassen (inzwischen gelöscht oder von Hand verändert) */
  notRestorable: number;
  /** entfernte Stunden, die wieder angelegt werden */
  reinsert: number;
  /** davon ohne Gruppe oder Fach (inzwischen gelöscht) – entfallen */
  reinsertSkipped: number;
  /** Stunden ab dem Stichtag, die nach der Übernahme von Hand angelegt wurden – bleiben; Kollisionen mit dem alten Plan prüfen */
  foreign: number;
  /** SP-13: Vertretungen, die die Übernahme entfernt hatte und die wiederhergestellt werden (ihre Stunde gilt an dem Tag wieder) */
  restoredSubstitutions: number;
  /** Vertretungen, die die Übernahme entfernt hatte und die nicht zurückkommen (Stunde gilt nicht mehr bzw. Übernahme vor SP-13) */
  lostSubstitutions: number;
  /** Raumbuchungen/Klausuren ab dem Stichtag in Räumen, die der alte Plan zu dieser Zeit belegt */
  roomClashes: { bookings: number; exams: number };
}

/** Schlüssel einer Stunde für den Vergleich mit dem Vorschlag (verändert = verschoben, andere Lehrkraft, anderer Raum). */
const lessonKey = (l: { groupId: string; subjectId: string; teacherId: string | null; roomId: string | null; weekday: number; periodNr: number }) =>
  `${l.groupId}|${l.subjectId}|${l.teacherId ?? ""}|${l.roomId ?? ""}|${l.weekday}|${l.periodNr}`;

async function countOnLessons(db: Db, ids: string[]): Promise<Pick<UndoPreview, "substitutions" | "classbook" | "materials">> {
  const out = { substitutions: 0, classbook: 0, materials: 0 };
  for (const part of chunks(ids)) {
    out.substitutions += await db.$count(timetableSubstitutions, inArray(timetableSubstitutions.lessonId, part));
    out.classbook += await db.$count(classbookEntries, inArray(classbookEntries.lessonId, part));
    out.materials += await db.$count(timetableAbsenceMaterials, inArray(timetableAbsenceMaterials.lessonId, part));
  }
  return out;
}

type Validity = Pick<TimetableLesson, "validFrom" | "validUntil">;
interface ExistingIds {
  users: Set<string>;
  rooms: Set<string>;
  subjects: Set<string>;
}

/**
 * SP-13: die bei der Übernahme entfernten Vertretungen, deren Stunde nach dem Zurücknehmen am Tag der Vertretung wieder gilt, als
 * Zeilen zum Wiederanlegen (alte ID). Inzwischen gelöschte Lehrkraft/Raum/Fach werden leer – wie es die Fremdschlüssel beim Löschen
 * auch täten. Bänder/Kopplungen: jede Vertretung hängt an genau einer Stunde (einem Teil); die Teile kommen mit ihrer alten
 * `coupling_id` zurück, ihre Vertretungen damit je Teil.
 */
function substitutionsToRestore(subs: UndoSubstitution[], lessons: Map<string, Validity>, ids: ExistingIds): (typeof timetableSubstitutions.$inferInsert)[] {
  const keep = (id: string | null, set: Set<string>) => (id && set.has(id) ? id : null);
  const holds = (id: string, date: string) => {
    const l = lessons.get(id);
    return l !== undefined && l.validFrom <= date && (l.validUntil === null || l.validUntil >= date);
  };
  return subs
    // R1a/A1: eine Zusammenlegung nur, wenn auch die aufnehmende Stunde an dem Tag wieder gilt
    .filter((s) => holds(s.lessonId, s.date) && (!s.mergeLessonId || holds(s.mergeLessonId, s.date)))
    .map((s) => ({
      id: s.id,
      lessonId: s.lessonId,
      date: s.date,
      kind: s.kind,
      substituteId: keep(s.substituteId, ids.users),
      roomId: keep(s.roomId, ids.rooms),
      note: s.note,
      subjectId: s.kind === "substitute" ? keep(s.subjectId, ids.subjects) : null,
      targetPeriod: s.targetPeriod ?? null,
      mergeLessonId: s.mergeLessonId ?? null,
      createdBy: keep(s.createdBy, ids.users),
      createdAt: new Date(s.createdAt),
      reason: s.reason ?? null,
      internalNote: s.internalNote ?? null,
      supervisionOnly: s.kind === "substitute" && (s.supervisionOnly ?? false),
    }));
}

/** Stunden, an denen die Vertretungen hängen – auch die aufnehmenden Stunden von Zusammenlegungen. */
const referencedLessons = (subs: UndoSubstitution[]) => [...new Set(subs.flatMap((s) => (s.mergeLessonId ? [s.lessonId, s.mergeLessonId] : [s.lessonId])))];

async function lessonValidity(db: Db, ids: string[]): Promise<Map<string, Validity>> {
  const out = new Map<string, Validity>();
  for (const part of chunks(ids))
    for (const l of await db.select({ id: timetableLessons.id, validFrom: timetableLessons.validFrom, validUntil: timetableLessons.validUntil }).from(timetableLessons).where(inArray(timetableLessons.id, part)))
      out.set(l.id, { validFrom: l.validFrom, validUntil: l.validUntil });
  return out;
}

/** Stand für das Zurücknehmen: Stunden des Laufs, wiederherstellbare und fremde Stunden – gemeinsam für Vorschau und Rücknahme. */
async function undoState(db: Db, run: SolverRun) {
  const undo = run.undo!;
  const from = run.appliedFrom!;
  const dayBefore = addDays(from, -1);
  const own = await db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, run.id));
  const proposal = new Map<string, number>();
  if (run.stored) for (const l of proposedLessons(run.stored)) proposal.set(lessonKey(l), (proposal.get(lessonKey(l)) ?? 0) + 1);
  let changed = 0;
  for (const l of own) {
    const k = lessonKey(l);
    const n = proposal.get(k) ?? 0;
    if (l.fixed || l.validFrom !== from || n === 0) changed++;
    else proposal.set(k, n - 1);
  }
  const endedIds = undo.ended.map((e) => e.id);
  const endedRows = new Map<string, TimetableLesson>();
  for (const part of chunks(endedIds)) for (const l of await db.select().from(timetableLessons).where(inArray(timetableLessons.id, part))) endedRows.set(l.id, l);
  const restorable = undo.ended.filter((e) => endedRows.get(e.id)?.validUntil === dayBefore);
  const [groupRows, subjectRows, teacherRows, roomRows] = await Promise.all([
    db.select({ id: groups.id }).from(groups),
    db.select({ id: subjects.id }).from(subjects),
    db.select({ id: users.id }).from(users),
    db.select({ id: rooms.id }).from(rooms),
  ]);
  const has = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
  const groupIds = has(groupRows);
  const subjectIds = has(subjectRows);
  const teacherIds = has(teacherRows);
  const roomIds = has(roomRows);
  const reinsert = undo.deleted
    .filter((l) => groupIds.has(l.groupId) && subjectIds.has(l.subjectId))
    .map((l) => ({ ...l, teacherId: l.teacherId && teacherIds.has(l.teacherId) ? l.teacherId : null, roomId: l.roomId && roomIds.has(l.roomId) ? l.roomId : null, solverRunId: null }));
  const foreign = run.appliedAt
    ? await db.$count(
        timetableLessons,
        and(
          or(isNull(timetableLessons.solverRunId), ne(timetableLessons.solverRunId, run.id)),
          sql`${timetableLessons.createdAt} > ${run.appliedAt.toISOString()}::timestamptz`,
          or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, from)),
        ),
      )
    : 0;
  const restored: LessonSlot[] = [
    ...restorable.map((e) => ({ ...endedRows.get(e.id)!, validUntil: e.validUntil })),
    ...reinsert,
  ];
  // SP-13: Gültigkeit der Stunden nach dem Zurücknehmen – beendete wie jetzt bzw. wieder verlängert, entfernte wie wieder angelegt
  const after = new Map<string, Validity>([...endedRows].map(([id, l]) => [id, { validFrom: l.validFrom, validUntil: l.validUntil }]));
  for (const e of restorable) after.set(e.id, { validFrom: endedRows.get(e.id)!.validFrom, validUntil: e.validUntil });
  for (const l of reinsert) if (!after.has(l.id)) after.set(l.id, { validFrom: l.validFrom, validUntil: l.validUntil });
  const existing: ExistingIds = { users: teacherIds, rooms: roomIds, subjects: subjectIds };
  const subs = undo.substitutions ?? [];
  // R1a/A1: Stunden, die das Zurücknehmen nicht anfasst (z. B. fixierte Gäste einer Zusammenlegung), gelten wie jetzt
  for (const [id, v] of await lessonValidity(db, referencedLessons(subs).filter((id) => !after.has(id)))) after.set(id, v);
  const restoredSubstitutions = substitutionsToRestore(subs, after, existing).length;
  return { undo, from, dayBefore, own, changed, restorable, reinsert, foreign, subs, existing, restoredSubstitutions, roomClashes: await roomClashes(db, restored, from) };
}

/** Vorschau für „Übernahme zurücknehmen“ – `null`, wenn die Übernahme nicht (mehr) zurücknehmbar ist. */
export async function undoPreview(db: Db, run: SolverRun, todayYmd: string): Promise<UndoPreview | null> {
  if (!isUndoable(run, todayYmd)) return null;
  const s = await undoState(db, run);
  return {
    lessons: s.own.length,
    changed: s.changed,
    ...(await countOnLessons(db, s.own.map((l) => l.id))),
    restorable: s.restorable.length,
    notRestorable: s.undo.ended.length - s.restorable.length,
    reinsert: s.reinsert.length,
    reinsertSkipped: s.undo.deleted.length - s.reinsert.length,
    foreign: s.foreign,
    restoredSubstitutions: s.restoredSubstitutions,
    lostSubstitutions: s.undo.removedSubstitutions - s.restoredSubstitutions,
    roomClashes: s.roomClashes,
  };
}

/**
 * „Übernahme zurücknehmen“ (SP-09), solange der Stichtag in der Zukunft liegt: alle Stunden des Laufs werden entfernt (nur
 * die eigenen – auch wenn sie seit der Übernahme verändert wurden; Vertretungen und Material daran gehen mit, Klassenbuch-
 * einträge verlieren den Bezug), beendete Stunden gelten wieder bis zu ihrem früheren Ende (nur, wenn sie seitdem unverändert
 * sind), entfernte Stunden werden wieder angelegt (mit ihrer alten ID; fehlt inzwischen Gruppe oder Fach, entfallen sie; eine
 * gelöschte Lehrkraft oder ein gelöschter Raum wird leer). Nach der Übernahme von Hand angelegte Stunden bleiben. Die bei der
 * Übernahme entfernten Vertretungen kommen zurück, sofern ihre Stunde an dem Tag wieder gilt (SP-13, Q-SP-9-1). Der Lauf ist
 * danach wieder „fertig“ und erneut übernehmbar.
 */
export async function undoApply(db: Db, actorId: string, runId: string, todayYmd: string): Promise<UndoPreview> {
  const run = await getRun(db, runId);
  if (!run) throw new ValidationError({ run: "Lauf gibt es nicht" });
  if (run.status !== "applied") throw new ValidationError({ run: "Dieser Lauf ist nicht übernommen" });
  if (!run.undo) throw new ValidationError({ run: "Zu dieser Übernahme gibt es keine Rücknahme-Daten (vor SP-09 übernommen oder Stichtag erreicht)" });
  if (!isUndoable(run, todayYmd))
    throw new ValidationError({ run: `Die Übernahme gilt seit ${dayFmt.format(fromBerlinLocal(run.appliedFrom!))} und lässt sich nicht mehr zurücknehmen` });

  const out = await db.transaction(async (tx) => {
    const s = await undoState(tx, run);
    const ownIds = s.own.map((l) => l.id);
    const counts = await countOnLessons(tx, ownIds);
    // 1. eigene Stunden weg (Vertretungen/Material per Cascade, Klassenbuch-Bezug wird leer); VT-01: die Vertretungen in die Historie
    await recordLessonCascade(tx, actorId, ownIds, "plan_undo");
    for (const part of chunks(ownIds)) await tx.delete(timetableLessons).where(inArray(timetableLessons.id, part));
    // 2. beendete Stunden wieder verlängern – nur, wenn sie noch so enden, wie die Übernahme sie hinterlassen hat
    let restored = 0;
    for (const e of s.restorable) {
      const r = await tx
        .update(timetableLessons)
        .set({ validUntil: e.validUntil })
        .where(and(eq(timetableLessons.id, e.id), eq(timetableLessons.validUntil, s.dayBefore)))
        .returning({ id: timetableLessons.id });
      restored += r.length;
    }
    // 3. entfernte Stunden wieder anlegen (gleiche ID; gibt es sie wider Erwarten schon, bleibt die vorhandene)
    let reinserted = 0;
    for (const part of chunks(s.reinsert)) reinserted += (await tx.insert(timetableLessons).values(part).onConflictDoNothing().returning({ id: timetableLessons.id })).length;
    // 3b. R1a/A2: geteilte Stunden wieder zusammenfügen – nur, wenn der Teil im Zeitraum wieder bis zum Ende des Zeitraums gilt
    for (const { id, of } of s.undo.split ?? []) {
      const [copy] = await tx.select().from(timetableLessons).where(eq(timetableLessons.id, id));
      if (!copy) continue;
      const until = addDays(copy.validFrom, -1);
      const joined = await tx
        .update(timetableLessons)
        .set({ validUntil: copy.validUntil })
        .where(and(eq(timetableLessons.id, of), eq(timetableLessons.validUntil, until)))
        .returning({ id: timetableLessons.id });
      if (!joined.length) continue;
      await moveReferences(tx, id, of, copy.validFrom);
      await tx.delete(timetableLessons).where(eq(timetableLessons.id, id));
    }
    // 4. SP-13: entfernte Vertretungen wieder anlegen, sofern ihre Stunde (bei Zusammenlegungen auch die aufnehmende) an dem Tag jetzt wieder gilt
    const lessonsNow = await lessonValidity(tx, referencedLessons(s.subs));
    let restoredSubstitutions = 0;
    for (const part of chunks(substitutionsToRestore(s.subs, lessonsNow, s.existing))) {
      const back = await tx
          .insert(timetableSubstitutions)
          .values(part)
          // eine inzwischen aufgehobene Zusammenlegung (aufnehmende Stunde gelöscht, `merge_lesson_id` leer) am selben Tag weicht der alten Vertretung
          .onConflictDoUpdate({
            target: [timetableSubstitutions.lessonId, timetableSubstitutions.date],
            set: {
              id: sql`excluded.id`,
              kind: sql`excluded.kind`,
              substituteId: sql`excluded.substitute_id`,
              roomId: sql`excluded.room_id`,
              note: sql`excluded.note`,
              subjectId: sql`excluded.subject_id`,
              targetPeriod: sql`excluded.target_period`,
              mergeLessonId: sql`excluded.merge_lesson_id`,
              createdBy: sql`excluded.created_by`,
              createdAt: sql`excluded.created_at`,
              reason: sql`excluded.reason`,
              internalNote: sql`excluded.internal_note`,
              supervisionOnly: sql`excluded.supervision_only`,
              updatedBy: sql`null`,
              updatedAt: sql`null`,
              acknowledgedAt: sql`null`,
            },
            setWhere: sql`${timetableSubstitutions.kind} = 'merge' and ${timetableSubstitutions.mergeLessonId} is null`,
          })
          .returning();
      restoredSubstitutions += back.length;
      // VT-01: wiederhergestellte Vertretungen stehen in der Historie (`plan_undo`)
      await recordSubstitutionChanges(
        tx,
        actorId,
        back.map((r) => ({ action: "plan_undo" as const, date: r.date, lessonId: r.lessonId, substitutionId: r.id, before: null, after: snapshotOf(r) })),
      );
    }
    const result: UndoPreview = {
      lessons: ownIds.length,
      changed: s.changed,
      ...counts,
      restorable: restored,
      notRestorable: s.undo.ended.length - restored,
      reinsert: reinserted,
      reinsertSkipped: s.undo.deleted.length - reinserted,
      foreign: s.foreign,
      restoredSubstitutions,
      lostSubstitutions: s.undo.removedSubstitutions - restoredSubstitutions,
      roomClashes: s.roomClashes,
    };
    const log = [
      ...run.log,
      logEntry(
        "undo",
        `Übernahme ab ${dayFmt.format(fromBerlinLocal(s.from))} zurückgenommen: ${result.lessons} Stunden entfernt (${result.changed} davon seit der Übernahme verändert), ${result.restorable} beendete wieder verlängert${result.notRestorable ? ` (${result.notRestorable} nicht mehr wiederherstellbar)` : ""}, ${result.reinsert} entfernte wieder angelegt${result.foreign ? `, ${result.foreign} von Hand angelegte Stunden bleiben` : ""}${result.restoredSubstitutions ? `, ${result.restoredSubstitutions} bei der Übernahme entfernte Vertretungen wiederhergestellt` : ""}${result.lostSubstitutions ? `, ${result.lostSubstitutions} bei der Übernahme entfernte Vertretungen kommen nicht zurück` : ""}`,
        { ...result },
      ),
    ].slice(-LOG_LIMIT);
    const changed = await tx
      .update(timetableSolverRuns)
      .set({ status: "done", appliedFrom: null, appliedBy: null, appliedAt: null, undo: null, log })
      .where(and(eq(timetableSolverRuns.id, runId), eq(timetableSolverRuns.status, "applied")))
      .returning({ id: timetableSolverRuns.id });
    if (!changed.length) throw new ValidationError({ run: "Der Lauf wurde inzwischen verändert – Seite neu laden" });
    return result;
  });
  await audit(db, actorId, "stundenplan.solver.undo", null, { run: runId, from: run.appliedFrom, ...out });
  return out;
}

/** Stunde (bzw. alle Teile ihrer Kopplung) fixieren oder lösen – im gültigen Plan oder im Entwurf (SP3-02). */
export async function setFixed(db: Db, actorId: string, lessonId: string, fixed: boolean, source: PlanSource = LIVE): Promise<void> {
  await requireWritable(db, source);
  const t = lessonCols(source);
  const [l] = await db.select({ id: t.id, groupId: t.groupId, couplingId: t.couplingId }).from(t).where(idWhere(source, lessonId));
  if (!l) throw new ValidationError({ id: "Stunde gibt es nicht" });
  await db
    .update(t)
    .set({ fixed })
    .where(and(versionWhere(source), l.couplingId ? eq(t.couplingId, l.couplingId) : eq(t.id, lessonId)));
  if (source.kind === "draft") await audit(db, actorId, fixed ? "stundenplan.draft.lesson.fix" : "stundenplan.draft.lesson.unfix", l.groupId, { lesson: lessonId, draft: source.versionId });
  else await audit(db, actorId, fixed ? "stundenplan.lesson.fix" : "stundenplan.lesson.unfix", l.groupId, { lesson: lessonId });
}

export type { PrecheckFinding };
