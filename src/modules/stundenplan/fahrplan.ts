// SP3-06 (docs/STUNDENPLAN-LEBENSZYKLUS.md §4, Kernentscheidung D): Planungsfahrplan – eine Checkliste mit acht Schritten statt eines
// Assistenten. Der Status jedes Schritts wird **aus den Daten berechnet** (`fahrplanStatus()`, rein und getestet); manuelle Häkchen,
// optionale Termine und die Quittierungen von Diagnose-Warnungen liegen in `timetable_plan_versions.checklist` (keine Migration).
// Schritt 7 („Prüfen“) ist zugleich die Bedingung fürs Veröffentlichen: keine Diagnose-Fehler, jede Warnung mit Begründung quittiert
// (`publishGate`, von `publishVersion()` erzwungen). Der Lader (`loadFahrplan`) sammelt die Zahlen aus den vorhandenen Services – gegen
// den Entwurf der Version an ihrem Stichtag.
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { periods, rooms, schoolYears, schoolYearTransitions, timetableAbsences, timetableRoomBlocks, timetableSolverRuns } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { readSchoolSettings } from "@/core/settings";
import { addDays, isCalendarDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { defaultObligation, deputyAccounts } from "./deputate";
import { DIAGNOSIS_CATEGORIES, DIAGNOSIS_LABELS, diagnoseYear, type DiagnosisCategory, type Finding } from "./diagnose";
import { activeTeacherIds, teacherSubjectMap } from "./lehrfaecher";
import { createNewYearDraft, newYearTemplate } from "./neues-schuljahr";
import { templateOffers, type TemplateOffer } from "./laufzeit";
import { diffLessons, planDiff, type DiffLesson } from "./plan-diff";
import { draftOf } from "./plan-quelle";
import { openCommentCounts } from "./planpruefung";
import { createDraft, getVersion, OPEN_STATUSES, suggestedValidFrom, versionNumber } from "./planversionen";
import { timetableDraftLessons, timetablePlanVersions, type PlanVersionStatus, type TimetablePlanVersion } from "./schema";
import { correctionsSince } from "./sofortkorrektur";
import { planGaps } from "./solververgleich";
import { distribution } from "./verteilung";
import { allPrefs, prefKey } from "./zeitwuensche";
import { activeTeachers, readPrefWindow, submissions, windowState, type PrefWindowState } from "./zeitwunsch-fenster";

// ---------------------------------------------------------------- Schritte und Checkliste

export const FAHRPLAN_STEPS = ["rahmen", "personal", "lerngruppen", "verteilung", "wuensche", "setzen", "pruefen", "veroeffentlichen"] as const;
export type FahrplanStep = (typeof FAHRPLAN_STEPS)[number];

export const STEP_TITLES: Record<FahrplanStep, string> = {
  rahmen: "Rahmen",
  personal: "Personal",
  lerngruppen: "Lerngruppen",
  verteilung: "Unterrichtsverteilung",
  wuensche: "Wünsche & Sperrzeiten",
  setzen: "Setzen",
  pruefen: "Prüfen",
  veroeffentlichen: "Vorschau & Veröffentlichen",
};

/**
 * Vorlagen des Fahrplans (§4): „Neues Halbjahr“ und „Änderung im laufenden Plan“ (SP3-05, `laufzeit.ts`), „Leerer Entwurf“ und
 * „Neues Schuljahr“ – Letzteres ist der Erweiterungspunkt für SP3-07 (Entwurf aus dem Vorjahr, hochgestuft mit `class_map`).
 */
export const FAHRPLAN_TEMPLATES = ["halbjahr", "schuljahr", "aenderung", "leer"] as const;
export type FahrplanTemplate = (typeof FAHRPLAN_TEMPLATES)[number];

/** Manuelle Häkchen – was sich aus den Daten nicht ablesen lässt. */
export const FAHRPLAN_TICKS = ["prognose", "sperren"] as const;
export type FahrplanTick = (typeof FAHRPLAN_TICKS)[number];
export const TICK_LABELS: Record<FahrplanTick, string> = {
  prognose: "Abgänge und Zugänge (Prognose) gepflegt",
  sperren: "Raumsperren und Fixtermine geprüft",
};

/** Begründung einer Quittierung: Pflicht, höchstens 120 Zeichen (wie die Begründung einer Sofort-Korrektur). */
export const ACK_REASON_MAX = 120;
/** Rücklauf der Zeitwünsche, ab dem Schritt 5 grün ist (Vorgabe 100 %). */
export const PREF_RETURN_THRESHOLD = 1;
/** Abwesenheiten über den Stichtag ab so vielen Tagen gelten als „lang“ (Elternzeit, Abordnung) – nur Hinweis. */
export const LONG_ABSENCE_DAYS = 14;

/** Eine quittierte Warnung – ohne Text der Warnung (der kann Namen tragen), nur mit ihrem Bezug. */
export interface Acknowledgement {
  category: DiagnosisCategory;
  /** Bezug der Warnung: Lehrkraft, Klasse/Kurs oder Band (eigene Schlüssel, damit die Kontolöschung die Lehrkraft findet) */
  teacherId?: string;
  groupId?: string;
  bandId?: string;
  reason: string;
  createdBy: string | null;
  at: string;
}

export interface Checklist {
  template?: FahrplanTemplate;
  /** Quittierungen je Warnung (Schlüssel: `warningKey`) */
  acks: Record<string, Acknowledgement>;
  ticks: Partial<Record<FahrplanTick, { createdBy: string | null; at: string }>>;
  /** optionale Termine je Schritt (YYYY-MM-DD) */
  dates: Partial<Record<FahrplanStep, string>>;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Rein: Checkliste aus dem JSON der Version lesen – Unbekanntes fällt still weg. */
export function readChecklist(raw: unknown): Checklist {
  const out: Checklist = { acks: {}, ticks: {}, dates: {} };
  if (!isObject(raw)) return out;
  if ((FAHRPLAN_TEMPLATES as readonly unknown[]).includes(raw.template)) out.template = raw.template as FahrplanTemplate;
  if (isObject(raw.acks))
    for (const [k, a] of Object.entries(raw.acks)) {
      if (!isObject(a) || !(DIAGNOSIS_CATEGORIES as readonly unknown[]).includes(a.category) || typeof a.reason !== "string") continue;
      out.acks[k] = {
        category: a.category as DiagnosisCategory,
        ...(typeof a.teacherId === "string" ? { teacherId: a.teacherId } : {}),
        ...(typeof a.groupId === "string" ? { groupId: a.groupId } : {}),
        ...(typeof a.bandId === "string" ? { bandId: a.bandId } : {}),
        reason: a.reason,
        createdBy: typeof a.createdBy === "string" ? a.createdBy : null,
        at: typeof a.at === "string" ? a.at : "",
      };
    }
  if (isObject(raw.ticks))
    for (const t of FAHRPLAN_TICKS) {
      const v = raw.ticks[t];
      if (isObject(v)) out.ticks[t] = { createdBy: typeof v.createdBy === "string" ? v.createdBy : null, at: typeof v.at === "string" ? v.at : "" };
    }
  if (isObject(raw.dates))
    for (const s of FAHRPLAN_STEPS) {
      const d = raw.dates[s];
      if (typeof d === "string" && isCalendarDate(d)) out.dates[s] = d;
    }
  return out;
}

// ---------------------------------------------------------------- Quittierungen (rein)

/**
 * Rein: stabiler Schlüssel einer Warnung – Kategorie, Bezug und Text. Ändert sich die Warnung (andere Zahl, andere Stunden), gilt sie als
 * neu und braucht eine neue Quittierung; im JSON steht nur der Hash, nicht der Text.
 */
export function warningKey(f: Pick<Finding, "category" | "target" | "message">): string {
  return createHash("sha256").update(`${f.category}\u0000${f.target.kind}\u0000${f.target.id}\u0000${f.message}`).digest("hex").slice(0, 24);
}

export interface WarningView {
  key: string;
  finding: Finding;
  ack: Acknowledgement | null;
}

export interface GateResult {
  errors: Finding[];
  warnings: WarningView[];
  /** Warnungen ohne Quittierung */
  open: number;
  /** Quittierungen, deren Warnung es nicht mehr gibt (zählen nicht, stören nicht) */
  stale: number;
  ok: boolean;
}

/** Rein: Schritt 7 – Fehler blockieren immer, Warnungen nur, solange sie nicht quittiert sind; Hinweise (`info`) zählen nicht. */
export function gateOf(findings: readonly Finding[], acks: Checklist["acks"]): GateResult {
  const errors = findings.filter((f) => f.severity === "error");
  const seen = new Set<string>();
  const warnings: WarningView[] = [];
  for (const f of findings) {
    if (f.severity !== "warn") continue;
    const key = warningKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({ key, finding: f, ack: acks[key] ?? null });
  }
  const open = warnings.filter((w) => !w.ack).length;
  const stale = Object.keys(acks).filter((k) => !seen.has(k)).length;
  return { errors, warnings, open, stale, ok: errors.length === 0 && open === 0 };
}

/** Rein: Begründung einer Quittierung prüfen (Pflicht, ≤ 120 Zeichen, Leerraum zusammengefasst). */
export function cleanAckReason(raw: string | null | undefined): string {
  const r = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!r) throw new ValidationError({ reason: "Begründung angeben – warum ist die Warnung in Ordnung?" });
  if (r.length > ACK_REASON_MAX) throw new ValidationError({ reason: `Höchstens ${ACK_REASON_MAX} Zeichen` });
  return r;
}

// ---------------------------------------------------------------- Kennzahlen (rein)

export interface PlanKennzahlen {
  gaps: { teacherTotal: number; teacherMax: number; classTotal: number; classMax: number };
  /** Stunden in der ersten oder letzten Stunde des Zeitrasters */
  edgeLessons: number;
  /** erfüllte Zeitwünsche der Lehrkräfte in % (Slots „lieber nicht“/„gesperrt“, die frei bleiben); `null` ohne solche Wünsche */
  wishesMet: number | null;
  /** belegte Raum-Slots je Woche in % der Slots aller aktiven Räume (Mo–Fr × Zeitraster); `null` ohne Räume/Zeitraster */
  roomUse: number | null;
}

/**
 * Rein: Kennzahlen eines Wochenplans für Schritt 7 – Hohlstunden (wie der Variantenvergleich), Randstunden, erfüllte Wünsche,
 * Raumauslastung. A/B-Wochen zählen wie jede Woche.
 */
export function planKennzahlen(
  lessons: readonly Pick<DiffLesson, "groupId" | "teacherId" | "roomId" | "weekday" | "periodNr">[],
  input: { periodNrs: number[]; classIds: ReadonlySet<string>; teacherPrefs: ReadonlyMap<string, ReadonlyMap<string, number | null>>; activeRooms: number },
): PlanKennzahlen {
  const sorted = [...input.periodNrs].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted.at(-1);
  const edgeLessons = first === undefined ? 0 : lessons.filter((l) => l.periodNr === first || l.periodNr === last).length;
  const busy = new Set(lessons.filter((l) => l.teacherId).map((l) => `${l.teacherId}|${prefKey(l.weekday, l.periodNr)}`));
  let wishes = 0;
  let met = 0;
  for (const [teacherId, grid] of input.teacherPrefs)
    for (const [slot, v] of grid) {
      if (v !== null && v >= 0) continue;
      wishes++;
      if (!busy.has(`${teacherId}|${slot}`)) met++;
    }
  const roomSlots = new Set(lessons.filter((l) => l.roomId).map((l) => `${l.roomId}|${l.weekday}|${l.periodNr}`));
  const capacity = input.activeRooms * 5 * sorted.length;
  const pct = (a: number, b: number) => Math.round((a / b) * 1000) / 10;
  return {
    gaps: planGaps(lessons, sorted, input.classIds),
    edgeLessons,
    wishesMet: wishes ? pct(met, wishes) : null,
    roomUse: capacity ? Math.min(100, pct(roomSlots.size, capacity)) : null,
  };
}

// ---------------------------------------------------------------- Status (rein)

export type Ampel = "gruen" | "gelb" | "rot";
export const AMPEL_LABELS: Record<Ampel, string> = { gruen: "erledigt", gelb: "Hinweise", rot: "offen" };

export interface StepPoint {
  text: string;
  /** danger = offen (zählt), warn = Hinweis, info = zur Kenntnis, ok = erfüllt */
  tone: "danger" | "warn" | "info" | "ok";
}

export interface StepLink {
  label: string;
  href: string;
}

export interface StepStatus {
  step: FahrplanStep;
  nr: number;
  title: string;
  ampel: Ampel;
  /** offene Punkte (Zahl auf der Kachel) */
  open: number;
  points: StepPoint[];
  links: StepLink[];
  /** manuelle Häkchen dieses Schritts */
  ticks: { tick: FahrplanTick; label: string; done: boolean }[];
  /** bei „Änderung im laufenden Plan“ sind die Schritte 2–5 eingeklappt */
  collapsed: boolean;
  due: string | null;
  overdue: boolean;
}

/** Was der Lader aus den Daten sammelt – alles Zahlen, damit `fahrplanStatus()` rein bleibt. */
export interface FahrplanFacts {
  version: { id: string; label: string; name: string; status: PlanVersionStatus; validFrom: string | null; validUntil: string | null; validFromIsSchoolDay: boolean; createdAt: Date };
  year: { id: string; name: string; startsOn: string; endsOn: string };
  /** Seiten mit Stammdaten (`verwaltung.school`) verlinken */
  schoolData: boolean;
  rahmen: { periods: number };
  personal: { activeTeachers: number; withoutSubjects: number; longAbsences: number };
  lerngruppen: {
    classes: number;
    classesWithoutCurriculum: number;
    emptyBands: number;
    bands: number;
    /** Schuljahreswechsel ins Jahr der Version: Versetzung erledigt? `null` = kein Wechsel erfasst (SP3-07 nutzt es für „Neues Schuljahr“) */
    promoted: boolean | null;
  };
  verteilung: { assignments: number; classesBelowCurriculum: number; withoutTeacher: number; deputyOff: number };
  wuensche: { window: PrefWindowState; closesOn: string | null; submitted: number; teachers: number; roomBlocks: number; fixed: number };
  setzen: { lessons: number; openAssignments: number; openHours: number; lastRun: { id: string; status: string; unplaced: number | null } | null };
  pruefen: {
    gate: GateResult;
    /** Zähler je Kategorie (Fehler/Warnungen) */
    byCategory: { category: DiagnosisCategory; error: number; warn: number }[];
    diff: { changed: number; added: number; removed: number; teachers: number; groups: number } | null;
    corrections: { actions: number; lessons: number };
    /** andere offene Entwürfe desselben Schuljahrs (Variantenvergleich) */
    variants: string[];
    kennzahlen: PlanKennzahlen;
  };
  veroeffentlichen: { teacherPreview: boolean; openComments: number; approved: boolean; undoUntil: string | null };
}

export interface Fahrplan {
  steps: StepStatus[];
  done: number;
  /** erster nicht erledigter Schritt (für „Weiter mit …“) */
  next: FahrplanStep | null;
  gate: GateResult;
  template: FahrplanTemplate | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Rein: welche Vorlage eine Version hat – gespeichert, sonst aus der Nummer (Folgeversion = Änderung im laufenden Plan). */
export function templateOf(v: { minor: number }, checklist: Checklist): FahrplanTemplate | null {
  return checklist.template ?? (v.minor > 0 ? "aenderung" : null);
}

/**
 * Rein: Status der acht Schritte (§4 Tabelle) aus den gesammelten Zahlen, den Häkchen/Terminen der Checkliste und dem heutigen Tag.
 * Ampel: grün = erledigt, gelb = nur Hinweise (oder bereit für die nächste Handlung), rot = offene Punkte. Nur Schritt 7 entscheidet,
 * ob veröffentlicht werden darf; die übrigen Schritte führen nur.
 */
export function fahrplanStatus(facts: FahrplanFacts, checklist: Checklist, today: string, template: FahrplanTemplate | null = checklist.template ?? null): Fahrplan {
  const v = facts.version;
  const q = encodeURIComponent(v.id);
  const published = v.status === "gueltig" || v.status === "archiviert";
  const steps: StepStatus[] = [];
  const add = (step: FahrplanStep, points: StepPoint[], links: StepLink[], ticks: FahrplanTick[] = [], forceAmpel?: Ampel) => {
    const tickViews = ticks.map((t) => ({ tick: t, label: TICK_LABELS[t], done: Boolean(checklist.ticks[t]) }));
    const all: StepPoint[] = [...points, ...tickViews.map((t) => ({ text: t.done ? `${t.label} ✓` : `${t.label}?`, tone: t.done ? ("ok" as const) : ("danger" as const) }))];
    const open = all.filter((p) => p.tone === "danger").length;
    const ampel: Ampel = forceAmpel ?? (open > 0 ? "rot" : all.some((p) => p.tone === "warn") ? "gelb" : "gruen");
    const due = checklist.dates[step] ?? null;
    steps.push({
      step,
      nr: FAHRPLAN_STEPS.indexOf(step) + 1,
      title: STEP_TITLES[step],
      ampel,
      open,
      points: all,
      links,
      ticks: tickViews,
      collapsed: template === "aenderung" && ["personal", "lerngruppen", "verteilung", "wuensche"].includes(step),
      due,
      overdue: Boolean(due && due < today && ampel !== "gruen"),
    });
  };

  // 1 Rahmen
  add(
    "rahmen",
    [
      { text: `Version ${v.label} „${v.name}“ angelegt`, tone: "ok" },
      facts.rahmen.periods > 0 ? { text: `Zeitraster mit ${plural(facts.rahmen.periods, "Stunde", "Stunden")}`, tone: "ok" } : { text: "Kein Zeitraster angelegt", tone: "danger" },
      !v.validFrom
        ? { text: "Kein Stichtag „gültig ab“ vorgemerkt", tone: "danger" }
        : v.validFromIsSchoolDay
          ? { text: "Stichtag ist ein Schultag", tone: "ok" }
          : { text: "Der vorgemerkte Stichtag ist kein Schultag", tone: "danger" },
    ],
    [
      { label: "Versionskarte", href: `/planung/versionen?jahr=${encodeURIComponent(facts.year.id)}` },
      ...(facts.schoolData ? [{ label: "Stammdaten: Zeitraster, Schuljahr, Ferien", href: "/verwaltung/stammdaten" }] : []),
    ],
  );

  // 2 Personal
  const p = facts.personal;
  add(
    "personal",
    [
      { text: `${plural(p.activeTeachers, "aktive Lehrkraft", "aktive Lehrkräfte")}`, tone: "info" },
      p.withoutSubjects ? { text: `${plural(p.withoutSubjects, "Lehrkraft", "Lehrkräfte")} ohne Lehrfach`, tone: "danger" } : { text: "Alle Lehrkräfte haben Lehrfächer", tone: "ok" },
      ...(p.longAbsences ? [{ text: `${plural(p.longAbsences, "lange Abwesenheit", "lange Abwesenheiten")} über den Stichtag (ab ${LONG_ABSENCE_DAYS} Tagen)`, tone: "warn" as const }] : []),
    ],
    [
      { label: "Deputate", href: `/planung/unterricht?ansicht=lehrkraefte&quelle=${q}` },
      { label: "Lehrfächer", href: "/planung/unterricht/lehrfaecher" },
      { label: "Fachbedarf und Prognose", href: "/planung/bedarf" },
    ],
    ["prognose"],
  );

  // 3 Lerngruppen
  const g = facts.lerngruppen;
  add(
    "lerngruppen",
    [
      g.classes ? { text: `${plural(g.classes, "Klasse", "Klassen")} im Schuljahr`, tone: "ok" } : { text: "Keine Klassen im Schuljahr", tone: "danger" },
      ...(g.classesWithoutCurriculum ? [{ text: `${plural(g.classesWithoutCurriculum, "Klasse", "Klassen")} ohne Stundentafel des Jahrgangs`, tone: "danger" as const }] : []),
      ...(g.emptyBands ? [{ text: `${plural(g.emptyBands, "Band", "Bänder")} ohne Lehraufträge`, tone: "danger" as const }] : []),
      ...(template === "schuljahr" && g.promoted !== true ? [{ text: "Schuljahreswechsel: Versetzung noch nicht erledigt", tone: "danger" as const }] : []),
    ],
    [
      { label: "Klassen und Kurse", href: `/planung/unterricht?quelle=${q}` },
      { label: "Bänder", href: `/planung/unterricht?ansicht=baender&quelle=${q}` },
      ...(template === "schuljahr" && facts.schoolData ? [{ label: "Schuljahreswechsel", href: "/verwaltung/schuljahreswechsel" }] : []),
    ],
  );

  // 4 Unterrichtsverteilung
  const d = facts.verteilung;
  add(
    "verteilung",
    [
      { text: `${plural(d.assignments, "Lehrauftrag", "Lehraufträge")} am Stichtag`, tone: d.assignments ? "info" : "danger" },
      d.classesBelowCurriculum ? { text: `${plural(d.classesBelowCurriculum, "Klasse erreicht", "Klassen erreichen")} die Stundentafel nicht`, tone: "danger" } : { text: "Alle Klassen erreichen die Stundentafel", tone: "ok" },
      ...(d.withoutTeacher ? [{ text: `${plural(d.withoutTeacher, "Lehrauftrag", "Lehraufträge")} ohne Lehrkraft`, tone: "danger" as const }] : []),
      ...(d.deputyOff ? [{ text: `${plural(d.deputyOff, "Deputat", "Deputate")} mehr als 0,5 Std. über/unter Soll`, tone: "warn" as const }] : []),
    ],
    [
      { label: "Matrix", href: `/planung/unterricht?ansicht=matrix&quelle=${q}` },
      { label: "Deputate", href: `/planung/unterricht?ansicht=lehrkraefte&quelle=${q}` },
    ],
  );

  // 5 Wünsche & Sperrzeiten
  const w = facts.wuensche;
  const windowDone = w.window === "none" || w.window === "closed" || (w.closesOn !== null && w.closesOn < today);
  const returned = w.teachers ? w.submitted / w.teachers : 1;
  add(
    "wuensche",
    [
      w.window === "none"
        ? { text: "Kein Eingabefenster – Wünsche pflegt die Planung", tone: "info" }
        : windowDone
          ? { text: `Eingabefenster geschlossen`, tone: "ok" }
          : { text: `Eingabefenster ${w.window === "planned" ? "geplant" : "offen"}${w.closesOn ? ` bis ${w.closesOn}` : ""}`, tone: "danger" },
      ...(w.window === "none"
        ? []
        : [{ text: `${w.submitted} von ${w.teachers} Lehrkräften abgegeben`, tone: returned >= PREF_RETURN_THRESHOLD ? ("ok" as const) : ("danger" as const) }]),
      { text: `${plural(w.roomBlocks, "Raumsperre", "Raumsperren")} im Zeitraum · ${plural(w.fixed, "fixierte Stunde", "fixierte Stunden")}`, tone: "info" },
    ],
    [
      { label: "Zeitwünsche", href: `/planung/zeitwuensche?jahr=${encodeURIComponent(facts.year.id)}` },
      { label: "Raumsperren", href: "/stundenplan/raeume?ansicht=sperrungen" },
    ],
    ["sperren"],
  );

  // 6 Setzen
  const s = facts.setzen;
  const run = s.lastRun;
  add(
    "setzen",
    [
      { text: `${plural(s.lessons, "Wochenstunde", "Wochenstunden")} im Entwurf`, tone: "info" },
      s.openHours ? { text: `${plural(s.openHours, "Wochenstunde", "Wochenstunden")} offen (${plural(s.openAssignments, "Lehrauftrag", "Lehraufträge")})`, tone: "danger" } : { text: "Alle Lehraufträge gesetzt", tone: "ok" },
      ...(run
        ? [
            {
              text: `Letzter Solver-Lauf: ${run.status === "done" || run.status === "applied" ? "fertig" : run.status === "failed" ? "Fehler" : run.status === "cancelled" ? "abgebrochen" : "läuft"}${run.unplaced ? ` · ${plural(run.unplaced, "Einheit", "Einheiten")} nicht gesetzt` : ""}`,
              tone: "info" as const,
            },
          ]
        : []),
    ],
    [
      { label: "Im Entwurf setzen", href: `/planung/stundenplan?quelle=${q}` },
      { label: "Automatisch planen", href: `/planung/solver?quelle=${q}` },
      ...(run ? [{ label: "Letzter Lauf", href: `/planung/solver/${encodeURIComponent(run.id)}` }] : []),
    ],
  );

  // 7 Prüfen – entscheidet über das Veröffentlichen
  const pr = facts.pruefen;
  const gate = pr.gate;
  const k = pr.kennzahlen;
  add(
    "pruefen",
    [
      gate.errors.length ? { text: `${plural(gate.errors.length, "Fehler", "Fehler")} in der Diagnose`, tone: "danger" } : { text: "Diagnose ohne Fehler", tone: "ok" },
      !gate.warnings.length
        ? { text: "Keine Warnungen", tone: "ok" }
        : gate.open
          ? { text: `${plural(gate.open, "Warnung", "Warnungen")} nicht quittiert (von ${gate.warnings.length})`, tone: "danger" }
          : { text: `Alle ${plural(gate.warnings.length, "Warnung", "Warnungen")} quittiert`, tone: "ok" },
      ...(pr.diff
        ? [
            {
              text: `Zum gültigen Plan: ${pr.diff.changed} geändert, ${pr.diff.added} neu, ${pr.diff.removed} entfällt – ${plural(pr.diff.teachers, "Lehrkraft", "Lehrkräfte")}, ${plural(pr.diff.groups, "Klasse/Kurs", "Klassen/Kurse")} betroffen`,
              tone: "info" as const,
            },
          ]
        : []),
      ...(pr.corrections.actions
        ? [{ text: `Seit Entwurfsbeginn ${plural(pr.corrections.actions, "Sofort-Korrektur", "Sofort-Korrekturen")} im gültigen Plan (${plural(pr.corrections.lessons, "Stunde", "Stunden")}) – der Entwurf hat sie nachgezogen`, tone: "warn" as const }]
        : []),
      {
        text: `Hohlstunden Lehrkräfte ${k.gaps.teacherTotal} (höchstens ${k.gaps.teacherMax}), Klassen ${k.gaps.classTotal} (höchstens ${k.gaps.classMax}) · Randstunden ${k.edgeLessons} · erfüllte Wünsche ${k.wishesMet === null ? "–" : `${String(k.wishesMet).replace(".", ",")} %`} · Raumauslastung ${k.roomUse === null ? "–" : `${String(k.roomUse).replace(".", ",")} %`}`,
        tone: "info",
      },
    ],
    [
      { label: "Diagnose im Entwurf", href: `/planung/unterricht?ansicht=diagnose&quelle=${q}` },
      { label: "Änderungen zum gültigen Plan", href: `/planung/versionen/aenderungen?version=${q}` },
      ...(pr.variants.length ? [{ label: "Varianten vergleichen", href: `/planung/solver/vergleich?versionen=${[v.id, ...pr.variants].slice(0, 3).map(encodeURIComponent).join(",")}` }] : []),
      ...(pr.corrections.actions ? [{ label: "Korrektur-Protokoll", href: `/planung/versionen/korrekturen?jahr=${encodeURIComponent(facts.year.id)}` }] : []),
    ],
    [],
    published ? "gruen" : undefined,
  );

  // 8 Vorschau & Veröffentlichen
  const pub = facts.veroeffentlichen;
  const statusPoint: StepPoint =
    v.status === "entwurf"
      ? { text: "Noch nicht zur Prüfung gegeben", tone: "danger" }
      : v.status === "pruefung"
        ? { text: "In Prüfung – Freigabe durch die Schulleitung steht aus", tone: "danger" }
        : v.status === "freigegeben"
          ? gate.ok && v.validFrom
            ? { text: `Freigegeben – bereit zum Veröffentlichen ab ${v.validFrom}`, tone: "warn" }
            : { text: "Freigegeben – vor dem Veröffentlichen Schritt 7 abschließen", tone: "danger" }
          : published
            ? { text: `Veröffentlicht – gültig ab ${v.validFrom}${pub.undoUntil ? `; Rücknahme bis ${pub.undoUntil} möglich` : ""}`, tone: "ok" }
            : { text: "Verworfen", tone: "info" };
  add(
    "veroeffentlichen",
    [
      statusPoint,
      ...(published ? [] : [{ text: pub.teacherPreview ? "Vorschau für Lehrkräfte an" : "Vorschau für Lehrkräfte aus", tone: "info" as const }]),
      ...(pub.openComments ? [{ text: `${plural(pub.openComments, "Kommentar", "Kommentare")} offen`, tone: "warn" as const }] : []),
    ],
    [
      { label: "Prüfung & Freigabe", href: `/planung/versionen/pruefung?version=${q}` },
      ...(v.status === "freigegeben" || published ? [{ label: published ? "Veröffentlichung ansehen" : "Veröffentlichen …", href: `/planung/versionen/veroeffentlichen?version=${q}` }] : []),
    ],
    [],
    published ? "gruen" : undefined,
  );

  const done = steps.filter((x) => x.ampel === "gruen").length;
  const next = steps.find((x) => x.ampel === "rot" && !x.collapsed)?.step ?? steps.find((x) => x.ampel !== "gruen")?.step ?? null;
  return { steps, done, next, gate, template };
}

// ---------------------------------------------------------------- Lader

/** Offene Entwürfe eines Schuljahrs, die der Fahrplan führt (neueste zuerst). */
export async function fahrplanVersions(db: Db, schoolYearId: string): Promise<TimetablePlanVersion[]> {
  return db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), inArray(timetablePlanVersions.status, [...OPEN_STATUSES])))
    .orderBy(desc(timetablePlanVersions.createdAt), desc(timetablePlanVersions.id));
}

/** Diagnose des Entwurfs an seinem Stichtag (wie die Diagnose-Seite mit `?quelle=`). */
async function draftDiagnosis(db: Db, v: TimetablePlanVersion, year: { id: string; startsOn: string; endsOn: string }, today: string) {
  const school = await readSchoolSettings(db);
  const ref = v.validFrom ?? today;
  return diagnoseYear(db, year, ref, defaultObligation(school.profile.form), undefined, { source: draftOf(v.id) });
}

/**
 * Schritt 7 als Bedingung fürs Veröffentlichen (§2.3/§4): Diagnose des Entwurfs an seinem Stichtag ohne Fehler, jede Warnung quittiert.
 * Wirft eine `ValidationError` mit dem Grund; `publishVersion()` ruft es vor der Transaktion auf.
 */
export async function publishGate(db: Db, v: TimetablePlanVersion, today: string): Promise<GateResult> {
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, v.schoolYearId));
  if (!year) throw new ValidationError({ version: "Das Schuljahr der Version gibt es nicht mehr" });
  const report = await draftDiagnosis(db, v, year, today);
  return gateOf(report.findings, readChecklist(v.checklist).acks);
}

/** Text der Sperre fürs Veröffentlichen (`null` = frei). */
export function gateProblem(gate: GateResult): string | null {
  if (gate.ok) return null;
  const parts = [gate.errors.length ? plural(gate.errors.length, "Fehler", "Fehler") : null, gate.open ? `${plural(gate.open, "Warnung", "Warnungen")} nicht quittiert` : null].filter(Boolean);
  return `Diagnose des Entwurfs: ${parts.join(", ")} – erst im Planungsfahrplan, Schritt 7 „Prüfen“, beheben bzw. mit Begründung quittieren`;
}

export interface LoadedFahrplan {
  version: TimetablePlanVersion;
  checklist: Checklist;
  facts: FahrplanFacts;
  fahrplan: Fahrplan;
}

/** Alle Zahlen eines Fahrplans laden (gegen den Entwurf der Version an ihrem Stichtag) und den Status berechnen. */
export async function loadFahrplan(db: Db, v: TimetablePlanVersion, today: string, opts: { schoolData?: boolean } = {}): Promise<LoadedFahrplan> {
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, v.schoolYearId));
  if (!year) throw new ValidationError({ version: "Das Schuljahr der Version gibt es nicht mehr" });
  const checklist = readChecklist(v.checklist);
  const ref = v.validFrom ?? today;
  const open = (OPEN_STATUSES as readonly string[]).includes(v.status);
  const source = open ? draftOf(v.id) : { kind: "live" as const, refYmd: ref };
  const d = await distribution(db, year, ref, { source });
  const school = await readSchoolSettings(db);
  const fallback = defaultObligation(school.profile.form);
  const until = v.validUntil ?? year.endsOn;

  const [
    report,
    accounts,
    cal,
    periodRows,
    subjectsOf,
    active,
    absences,
    transitions,
    window,
    submitted,
    teachers,
    blocks,
    fixedRows,
    runs,
    after,
    before,
    corrections,
    others,
    comments,
    prefs,
    roomRows,
  ] = await Promise.all([
    diagnoseYear(db, year, ref, fallback, d, { source }),
    deputyAccounts(db, year.id, d.teachers, fallback, d.refYmd),
    loadSchoolCalendar(db),
    db.select({ nr: periods.nr }).from(periods).orderBy(asc(periods.nr)),
    teacherSubjectMap(db),
    activeTeacherIds(db),
    db
      .select({ teacherId: timetableAbsences.teacherId, startsOn: timetableAbsences.startsOn, endsOn: timetableAbsences.endsOn })
      .from(timetableAbsences)
      .where(and(lte(timetableAbsences.startsOn, ref), gte(timetableAbsences.endsOn, ref), eq(timetableAbsences.status, "aktiv"))),
    db.select({ promotedAt: schoolYearTransitions.promotedAt }).from(schoolYearTransitions).where(eq(schoolYearTransitions.toYearId, year.id)),
    readPrefWindow(db),
    submissions(db, year.id),
    activeTeachers(db),
    db.select({ n: count() }).from(timetableRoomBlocks).where(and(lte(timetableRoomBlocks.startsOn, until), gte(timetableRoomBlocks.endsOn, ref))),
    open ? db.select({ n: count() }).from(timetableDraftLessons).where(and(eq(timetableDraftLessons.versionId, v.id), eq(timetableDraftLessons.fixed, true))) : Promise.resolve([{ n: 0 }]),
    db
      .select({ id: timetableSolverRuns.id, status: timetableSolverRuns.status, unplaced: sql<string | number | null>`jsonb_array_length(${timetableSolverRuns.result} -> 'result' -> 'unplaced')` })
      .from(timetableSolverRuns)
      .where(and(eq(timetableSolverRuns.schoolYearId, year.id), sql`${timetableSolverRuns.params} ->> 'versionId' = ${v.id}`))
      .orderBy(desc(timetableSolverRuns.createdAt), desc(timetableSolverRuns.id))
      .limit(1),
    diffLessons(db, { source, refYmd: ref }),
    open ? diffLessons(db, { source: { kind: "live", refYmd: ref }, refYmd: ref }) : Promise.resolve(null),
    open ? correctionsSince(db, year.id, v.createdAt) : Promise.resolve({ actions: 0, lessons: 0 }),
    fahrplanVersions(db, year.id),
    openCommentCounts(db, [v.id]),
    // SP3-09b: Zeitwünsche und Rücklauf im Schuljahr der Version (auch im Folgejahr)
    allPrefs(db, year.id),
    db.select({ id: rooms.id }).from(rooms).where(eq(rooms.active, true)),
  ]);

  const classes = d.groups.filter((g) => g.kind === "klasse");
  const classIds = new Set(classes.map((g) => g.id));
  const openAssignments = d.assignments.filter((a) => a.planned < a.hours);
  const teacherPrefs = new Map<string, Map<string, number | null>>();
  for (const [key, grid] of prefs) if (key.startsWith("teacher:")) teacherPrefs.set(key.slice("teacher:".length), grid);
  const diff = before ? planDiff(before, after) : null;
  const w = window && window.schoolYearId === year.id ? window : null;
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
  const counts = DIAGNOSIS_CATEGORIES.map((c) => ({ category: c, error: report.counts[c].error, warn: report.counts[c].warn })).filter((c) => c.error + c.warn > 0);
  const lastRun = runs[0] ? { id: runs[0].id, status: runs[0].status, unplaced: runs[0].unplaced === null || runs[0].unplaced === undefined ? null : Number(runs[0].unplaced) } : null;

  const facts: FahrplanFacts = {
    version: {
      id: v.id,
      label: versionNumber(v),
      name: v.name,
      status: v.status,
      validFrom: v.validFrom,
      validUntil: v.validUntil,
      validFromIsSchoolDay: v.validFrom ? cal.isSchoolDay(v.validFrom) : false,
      createdAt: v.createdAt,
    },
    year: { id: year.id, name: year.name, startsOn: year.startsOn, endsOn: year.endsOn },
    schoolData: opts.schoolData ?? false,
    rahmen: { periods: periodRows.length },
    personal: {
      activeTeachers: active.size,
      withoutSubjects: [...active].filter((id) => !(subjectsOf.get(id)?.length ?? 0)).length,
      longAbsences: absences.filter((a) => a.teacherId && days(a.startsOn, a.endsOn) >= LONG_ABSENCE_DAYS).length,
    },
    lerngruppen: {
      classes: classes.length,
      classesWithoutCurriculum: classes.filter((g) => g.curriculum === null).length,
      emptyBands: d.bands.filter((b) => b.memberIds.length === 0).length,
      bands: d.bands.length,
      promoted: transitions.length ? transitions.some((t) => t.promotedAt !== null) : null,
    },
    verteilung: {
      assignments: d.assignments.length,
      classesBelowCurriculum: classes.filter((g) => g.curriculum !== null && g.assigned < g.curriculum).length,
      withoutTeacher: d.assignments.filter((a) => a.teachers.length === 0).length,
      deputyOff: accounts.filter((a) => Math.abs(a.balance) > 0.5).length,
    },
    wuensche: {
      window: windowState(w, today),
      closesOn: w?.closesOn ?? null,
      submitted: teachers.filter((t) => submitted.has(t)).length,
      teachers: teachers.length,
      roomBlocks: Number(blocks[0]?.n ?? 0),
      fixed: Number(fixedRows[0]?.n ?? 0),
    },
    setzen: {
      lessons: after.length,
      openAssignments: openAssignments.length,
      openHours: openAssignments.reduce((s, a) => s + (a.hours - a.planned), 0),
      lastRun,
    },
    pruefen: {
      gate: gateOf(report.findings, checklist.acks),
      byCategory: counts,
      diff: diff ? { changed: diff.counts.changed, added: diff.counts.added, removed: diff.counts.removed, teachers: diff.byTeacher.size, groups: diff.byGroup.size } : null,
      corrections,
      variants: others.filter((o) => o.id !== v.id).map((o) => o.id),
      kennzahlen: planKennzahlen(after, { periodNrs: periodRows.map((x) => x.nr), classIds, teacherPrefs, activeRooms: roomRows.length }),
    },
    veroeffentlichen: {
      teacherPreview: v.teacherPreview,
      openComments: comments.get(v.id) ?? 0,
      approved: Boolean(v.approvedAt),
      undoUntil: v.status === "gueltig" && v.validFrom && v.undo && v.validFrom > today ? addDays(v.validFrom, -1) : null,
    },
  };
  const template = templateOf(v, checklist);
  return { version: v, checklist, facts, fahrplan: fahrplanStatus(facts, checklist, today, template) };
}

/** Kategorie-Beschriftung für die Quittier-Ansicht. */
export const categoryLabel = (c: DiagnosisCategory) => DIAGNOSIS_LABELS[c];

// ---------------------------------------------------------------- Schreiben (Checkliste)

/** Die Checkliste einer offenen Version ändern – unter Zeilensperre, nur in Entwurf/Prüfung/freigegeben (Inhalt bleibt unberührt). */
async function updateChecklist(db: Db, versionId: string, change: (c: Checklist, v: TimetablePlanVersion) => Checklist): Promise<TimetablePlanVersion> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [v] = await tx.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, versionId)).for("update");
    if (!v) throw new ValidationError({ version: "Version nicht gefunden" });
    if (!(OPEN_STATUSES as readonly string[]).includes(v.status)) throw new ValidationError({ version: `Version ${versionNumber(v)} ist nicht mehr offen – der Fahrplan ist abgeschlossen` });
    const next = change(readChecklist(v.checklist), v);
    const [out] = await tx.update(timetablePlanVersions).set({ checklist: next }).where(eq(timetablePlanVersions.id, versionId)).returning();
    return out!;
  });
}

/**
 * Warnungen quittieren (Schritt 7): je Schlüssel eine Quittierung mit derselben Begründung. Nur Warnungen, die die Diagnose des Entwurfs
 * gerade meldet (Fehler lassen sich nicht quittieren). Audit `stundenplan.plan.acknowledge` mit Zahl und Kategorien – ohne Begründung.
 */
export async function acknowledgeWarnings(db: Db, actorId: string, versionId: string, keys: readonly string[], rawReason: string, today: string, now = new Date()): Promise<number> {
  const reason = cleanAckReason(rawReason);
  const v = await getVersion(db, versionId);
  if (!v) throw new ValidationError({ version: "Version nicht gefunden" });
  const gate = await publishGate(db, v, today);
  const byKey = new Map(gate.warnings.map((w) => [w.key, w.finding]));
  const wanted = [...new Set(keys)].filter((k) => byKey.has(k));
  if (!wanted.length) throw new ValidationError({ keys: "Mindestens eine aktuelle Warnung wählen" });
  await updateChecklist(db, versionId, (c) => {
    const acks = { ...c.acks };
    for (const k of wanted) {
      const f = byKey.get(k)!;
      const t = f.target;
      acks[k] = {
        category: f.category,
        ...(t.kind === "teacher" ? { teacherId: t.id } : t.kind === "group" ? { groupId: t.id } : { bandId: t.id }),
        reason,
        createdBy: actorId,
        at: now.toISOString(),
      };
    }
    return { ...c, acks };
  });
  await audit(db, actorId, "stundenplan.plan.acknowledge", versionId, { count: wanted.length, categories: [...new Set(wanted.map((k) => byKey.get(k)!.category))].sort() });
  return wanted.length;
}

/** Alle offenen Warnungen mit einer Begründung quittieren (z. B. „alle Deputats-Warnungen bekannt“) – Rückgabe: Zahl. */
export async function acknowledgeOpenWarnings(db: Db, actorId: string, versionId: string, reason: string, today: string, opts: { category?: DiagnosisCategory } = {}): Promise<number> {
  const v = await getVersion(db, versionId);
  if (!v) throw new ValidationError({ version: "Version nicht gefunden" });
  const gate = await publishGate(db, v, today);
  const keys = gate.warnings.filter((w) => !w.ack && (!opts.category || w.finding.category === opts.category)).map((w) => w.key);
  if (!keys.length) return 0;
  return acknowledgeWarnings(db, actorId, versionId, keys, reason, today);
}

/** Quittierung zurücknehmen (oder eine nicht mehr aktuelle entfernen). */
export async function revokeAcknowledgement(db: Db, actorId: string, versionId: string, key: string): Promise<void> {
  let found = false;
  await updateChecklist(db, versionId, (c) => {
    found = key in c.acks;
    const acks = { ...c.acks };
    delete acks[key];
    return { ...c, acks };
  });
  if (found) await audit(db, actorId, "stundenplan.plan.acknowledge_revoke", versionId, { count: 1 });
}

/** Nicht mehr aktuelle Quittierungen entfernen (deren Warnung es nicht mehr gibt). */
export async function pruneAcknowledgements(db: Db, actorId: string, versionId: string, today: string): Promise<number> {
  const v = await getVersion(db, versionId);
  if (!v) throw new ValidationError({ version: "Version nicht gefunden" });
  const gate = await publishGate(db, v, today);
  const current = new Set(gate.warnings.map((w) => w.key));
  let removed = 0;
  await updateChecklist(db, versionId, (c) => {
    const acks = Object.fromEntries(Object.entries(c.acks).filter(([k]) => current.has(k)));
    removed = Object.keys(c.acks).length - Object.keys(acks).length;
    return { ...c, acks };
  });
  if (removed) await audit(db, actorId, "stundenplan.plan.acknowledge_revoke", versionId, { count: removed, stale: true });
  return removed;
}

/** Manuelles Häkchen setzen/entfernen. */
export async function setTick(db: Db, actorId: string, versionId: string, tick: FahrplanTick, on: boolean, now = new Date()): Promise<void> {
  if (!(FAHRPLAN_TICKS as readonly string[]).includes(tick)) throw new ValidationError({ tick: "Häkchen wählen" });
  await updateChecklist(db, versionId, (c) => {
    const ticks = { ...c.ticks };
    if (on) ticks[tick] = { createdBy: actorId, at: now.toISOString() };
    else delete ticks[tick];
    return { ...c, ticks };
  });
  await audit(db, actorId, "stundenplan.plan.checklist", versionId, { tick, on });
}

/** Optionalen Termin eines Schritts setzen (leer = entfernen); im Schuljahr der Version. */
export async function setStepDate(db: Db, actorId: string, versionId: string, step: FahrplanStep, ymd: string | null): Promise<void> {
  if (!(FAHRPLAN_STEPS as readonly string[]).includes(step)) throw new ValidationError({ step: "Schritt wählen" });
  const v = await getVersion(db, versionId);
  if (!v) throw new ValidationError({ version: "Version nicht gefunden" });
  if (ymd) {
    if (!isCalendarDate(ymd)) throw new ValidationError({ date: "Datum wählen" });
    const [y] = await db.select({ startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.id, v.schoolYearId));
    // ein Termin liegt vor dem Stichtag – aber nicht vor dem Jahr davor (Planung beginnt oft im alten Schuljahr)
    if (y && (ymd > y.endsOn || ymd < addDays(y.startsOn, -366))) throw new ValidationError({ date: "Termin bis zum Ende des Schuljahrs wählen" });
  }
  await updateChecklist(db, versionId, (c) => {
    const dates = { ...c.dates };
    if (ymd) dates[step] = ymd;
    else delete dates[step];
    return { ...c, dates };
  });
  await audit(db, actorId, "stundenplan.plan.checklist", versionId, { step, date: ymd ? "gesetzt" : "entfernt" });
}

/** Vorlage an der Version vermerken (beim Anlegen aus dem Fahrplan bzw. den Vorlagen). */
export async function markTemplate(db: Db, versionId: string, template: FahrplanTemplate): Promise<TimetablePlanVersion> {
  return updateChecklist(db, versionId, (c) => ({ ...c, template }));
}

// ---------------------------------------------------------------- Vorlagen

export type FahrplanOffer = TemplateOffer;

/** Das Schuljahr nach `year` (beginnt nach dessen Ende), sonst `null`. */
async function nextYear(db: Db, year: { endsOn: string }) {
  const [y] = await db.select().from(schoolYears).where(gt(schoolYears.startsOn, year.endsOn)).orderBy(asc(schoolYears.startsOn)).limit(1);
  return y ?? null;
}

/**
 * Was die Vorlagen gerade anbieten: „Neues Halbjahr“/„Änderung im laufenden Plan“ aus SP3-05, „Leerer Entwurf“ ab dem vorgeschlagenen
 * Stichtag, „Neues Schuljahr“ aus SP3-07 (`newYearTemplate`) für das Schuljahr nach `year`.
 */
export async function fahrplanOffers(db: Db, year: { id: string; startsOn: string; endsOn: string; term2StartsOn: string | null }, today: string): Promise<Record<FahrplanTemplate, FahrplanOffer>> {
  const [laufzeit, suggestion, schuljahr] = await Promise.all([templateOffers(db, year, today), suggestedValidFrom(db, year, today), schuljahrOffer(db, year, today)]);
  return {
    halbjahr: laufzeit.halbjahr,
    schuljahr,
    aenderung: laufzeit.aenderung,
    leer: suggestion ? { ok: true, validFrom: suggestion, number: "", name: "Neuplanung" } : { ok: false, reason: "Im Schuljahr gibt es keinen Schultag mehr nach heute." },
  };
}

/** SP3-07: Vorlage „Neues Schuljahr“ für das folgende Schuljahr (Schritte Schuljahreswechsel → Versetzung → Entwurf). */
export async function schuljahrOffer(db: Db, year: { id: string; endsOn: string }, today: string): Promise<FahrplanOffer> {
  const next = await nextYear(db, year);
  if (!next) return { ok: false, reason: "Das nächste Schuljahr ist noch nicht angelegt (Stammdaten → Schuljahre); danach Schuljahreswechsel bis zur Versetzung." };
  const t = await newYearTemplate(db, next, today, year.id);
  if (t.offer.ok) return { ...t.offer, name: `${t.offer.name} (Schuljahr ${next.name})` };
  const open = t.steps.find((s) => !s.done);
  return { ok: false, reason: open ? `${t.offer.reason} – offen: ${open.label}` : t.offer.reason };
}

/** SP3-07: Entwurf „Neues Schuljahr“ (Plan des Vorjahrs hochgestuft) im folgenden Schuljahr anlegen und als Fahrplan vermerken. */
export async function createNewYearFahrplan(db: Db, actorId: string, year: { id: string; endsOn: string }, today: string): Promise<TimetablePlanVersion> {
  const next = await nextYear(db, year);
  if (!next) throw new ValidationError({ template: "Das nächste Schuljahr ist noch nicht angelegt." });
  const v = await createNewYearDraft(db, actorId, next.id, "vorjahr", today);
  return markTemplate(db, v.id, "schuljahr");
}

/** Entwurf für „Leerer Entwurf“ (neue Planung ab dem vorgeschlagenen Stichtag) anlegen und als Fahrplan vermerken. */
export async function createEmptyFahrplan(db: Db, actorId: string, year: { id: string; startsOn: string; endsOn: string; term2StartsOn: string | null }, today: string): Promise<TimetablePlanVersion> {
  const offer = (await fahrplanOffers(db, year, today)).leer;
  if (!offer.ok) throw new ValidationError({ template: offer.reason });
  const v = await createDraft(db, actorId, { schoolYearId: year.id, source: "empty", validFrom: offer.validFrom, numbering: "major", name: offer.name, withFixed: true }, today);
  return markTemplate(db, v.id, "leer");
}
