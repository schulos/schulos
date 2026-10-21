// Solver-Kern (P2b-22): automatische Stundenplanerstellung – reines TypeScript, deterministisch (fester Startwert).
//
// Harte Regeln: Lehrkraft, Gruppe und Raum nie doppelt; Gruppen mit gemeinsamen Schüler:innen nie parallel;
// Kopplungen und Bänder liegen als eine Einheit gemeinsam; gesperrte Zeiten (Zeitwünsche); fixierte Stunden bleiben;
// Doppelstunden nicht über eine große Pause (SP-G-04a). Weiche Regeln (gewichtet, erklärbar): Zeitwünsche,
// Hohlstunden (Lehrkraft/Klasse), Fach mehrfach am Tag, Raumwunsch, späte Stunden. Doppelstunden werden als Zweier-Block gesetzt.
// Räume werden je Teil einer Einheit vergeben (SP-G-02): eine geteilte Klasse mit zwei Lehrkräften bekommt zwei Räume.
// Bänder (SP2-02): eine Einheit mit einem Teil je Mitglied – eigenes Fach, eigene Lehrkraft, eigener Raum je Teil; Fachsperren,
// Zeitwünsche des Fachs und „Fach mehrfach am Tag“ gelten je Teil. Gruppen eines Bands mit gemeinsamen Schüler:innen dürfen parallel
// liegen (Q-SP2-6 – die Diagnose warnt). Tagesgrenzen und Ganztag je Klasse (SP2-03): höchstens n Stunden am Tag, höchstens n
// Nachmittage, Mittagsstunde frei bei Unterricht danach – Kurse des Jahrgangs zählen für die Klasse mit (`tagesgrenzen.ts`).
//
// Verfahren: gierige Konstruktion (schwierigste Einheiten zuerst, je Einheit der günstigste zulässige Slot), danach
// lokale Suche (Verschieben/Tauschen, nur Verbesserungen oder Gleichstand). Beides läuft in Schritten, damit ein
// Hintergrundlauf (solverlauf.ts) zwischendurch die Ereignisschleife freigibt.

import { ruleSummary, type DayRule } from "./tagesgrenzen";

export interface SolverWeights {
  /** je Wunschpunkt (Zeitwunsch +3 spart 3 × pref, −3 kostet 3 × pref) */
  pref: number;
  teacherGap: number;
  classGap: number;
  /** je weiterem Block desselben Fachs am Tag in einer Gruppe */
  subjectTwice: number;
  /** Raumwunsch (Wunschraum, Raumart des Fachs, Stammraum) nicht erfüllt */
  roomWish: number;
  noRoom: number;
  /** je Stunde nach der `lateFrom`-ten */
  late: number;
  lateFrom: number;
}

export const DEFAULT_WEIGHTS: SolverWeights = { pref: 2, teacherGap: 3, classGap: 10, subjectTwice: 8, roomWish: 4, noRoom: 20, late: 2, lateFrom: 6 };

export interface SolverRoom {
  id: string;
  kind: string;
  capacity: number | null;
}

/**
 * Ein Teil einer Einheit (Q-SP-13, bandfähiges Format): ein Lehrauftrag (Gruppe × Lehrkraft, ein Fach) – bei Teamteaching ein
 * Teil je Lehrkraft, bei Bändern (SP2-02) ein Teil je Mitglied mit eigener Lehrkraft, eigenem Fach und Raum.
 */
export interface UnitPart {
  /** Lehrauftrag dieses Teils */
  assignmentId: string;
  groupIds: string[];
  teacherIds: string[];
  subjectId: string;
  /** gewünschter Raum (Lehrauftrag) */
  roomId: string | null;
  /** gewünschte Raumart (Fach) */
  roomKind: string | null;
  /** Stammraum (eine Klasse) */
  homeRoomId: string | null;
  /** Personen (für die Raumgröße) */
  size: number;
}

export interface SolverUnit {
  id: string;
  /** Lehrauftrag (bei Bändern: das erste Mitglied) – für die Erklärung und das Zusammenfassen */
  assignmentId: string;
  label: string;
  /** alle Gruppen über alle Teile (harte Regeln, Kosten) */
  groupIds: string[];
  /** alle Lehrkräfte über alle Teile */
  teacherIds: string[];
  /** Fach des ersten Teils; Sperrzeiten, Zeitwünsche und „Fach mehrfach am Tag“ gelten je Teil (`parts[].subjectId`) */
  subjectId: string;
  /** 1 = Einzelstunde, 2 = Doppelstunde */
  length: 1 | 2;
  /** gewünschter Raum (Lehrauftrag) */
  roomId: string | null;
  /** gewünschte Raumart (Fach) */
  roomKind: string | null;
  /** Stammraum (eine Klasse) */
  homeRoomId: string | null;
  /** Personen (für die Raumgröße) */
  size: number;
  /** Teile der Einheit (Vorschau/Übernahme erzeugen je Teil Gruppen × Lehrkräfte Stunden-Zeilen) */
  parts: UnitPart[];
}

/** Teile einer Einheit – auch für gespeicherte Einheiten aus Läufen vor SP-06, die noch kein `parts` haben. */
export function unitParts(u: Pick<SolverUnit, "groupIds" | "teacherIds" | "subjectId"> & Partial<Pick<SolverUnit, "parts" | "assignmentId" | "roomId" | "roomKind" | "homeRoomId" | "size">>): UnitPart[] {
  if (u.parts?.length) return u.parts;
  return [
    {
      assignmentId: u.assignmentId ?? "",
      groupIds: u.groupIds,
      teacherIds: u.teacherIds,
      subjectId: u.subjectId,
      roomId: u.roomId ?? null,
      roomKind: u.roomKind ?? null,
      homeRoomId: u.homeRoomId ?? null,
      size: u.size ?? 0,
    },
  ];
}

export interface FixedLesson {
  groupId: string;
  teacherId: string | null;
  roomId: string | null;
  subjectId: string;
  weekday: number;
  periodNr: number;
}

export interface SolverInput {
  weekdays: number[];
  /** Stundennummern, aufsteigend; aufeinanderfolgende Nummern gelten als Doppelstunden-fähig … */
  periods: number[];
  /** … außer über eine große Pause: nach diesen Stunden beginnt keine Doppelstunde (SP-G-04a; leer = wie bisher) */
  breakAfter?: number[];
  units: SolverUnit[];
  fixed: FixedLesson[];
  rooms: SolverRoom[];
  /** `${kind}:${id}` → `${wd}-${nr}` → −3 … +3 | null (gesperrt) */
  prefs: Map<string, Map<string, number | null>>;
  /** Gruppen mit gemeinsamen Mitgliedern dürfen nicht parallel liegen */
  conflicts: Map<string, Set<string>>;
  /** Gruppen, deren Hohlstunden zählen (Klassen) */
  classIds: Set<string>;
  /**
   * Jahrgangsstufe je Gruppe (Klassen und Kurse). SP2-02: Stunden eines Kurses (Wahlpflicht, Förderkurs, Kursband) zählen für die
   * Klassen desselben Jahrgangs als belegt – die Klasse ist dort beschäftigt, keine Hohlstunde. Fehlt die Angabe, zählen nur eigene Stunden.
   */
  gradeOf?: Map<string, number>;
  weights?: Partial<SolverWeights>;
  seed?: number;
  iterations?: number;
  /**
   * SP2-03: Tagesgrenzen je Klasse (aus der Regel ihres Jahrgangs). Stunden der Kurse desselben Jahrgangs (`gradeOf`) zählen für die
   * Klasse mit. Fehlt die Angabe, gibt es keine Tagesgrenzen.
   */
  dayRules?: Map<string, DayRule>;
  /** Anzeigenamen für Lehrkräfte, Gruppen und Fächer (Erklärungen); sonst die id */
  names?: Map<string, string>;
  /** Stunden, die bleiben (fixiert bzw. ohne Lehrauftrag) – nur für die Übernahme, der Solver selbst nutzt `fixed` */
  keptLessonIds?: string[];
}

export interface Placement {
  unitId: string;
  weekday: number;
  periodNr: number;
  /** Raum des ersten Teils (Läufe vor SP-09: der eine Raum aller Teile) */
  roomId: string | null;
  /** SP-G-02: Raum je Teil der Einheit (gleiche Reihenfolge wie `unit.parts`); fehlt bei Läufen vor SP-09 */
  roomIds?: (string | null)[];
}

/** Räume einer Platzierung je Teil – auch für Platzierungen aus Läufen vor SP-09 (dann für alle Teile derselbe Raum). */
export function placementRooms(p: Pick<Placement, "roomId" | "roomIds">, parts: number): (string | null)[] {
  if (p.roomIds && p.roomIds.length === parts) return p.roomIds;
  return Array.from({ length: parts }, () => p.roomId);
}

/** Was ein Teil für die Raumwahl braucht. */
type RoomNeed = Pick<UnitPart, "roomId" | "roomKind" | "homeRoomId" | "size">;

/** Fächer einer Einheit (je Teil eines, ohne Doppelte) – bei Bändern mehrere. */
export function unitSubjects(u: Pick<SolverUnit, "subjectId"> & Partial<Pick<SolverUnit, "parts">>): string[] {
  if (!u.parts?.length) return [u.subjectId];
  return [...new Set(u.parts.map((p) => p.subjectId))];
}

/** Paare Gruppe × Fach einer Einheit (je Teil, ohne Doppelte) – was eine Gruppe an diesem Tag hat. */
function unitGroupSubjects(u: SolverUnit): { g: string; s: string }[] {
  const seen = new Set<string>();
  const out: { g: string; s: string }[] = [];
  for (const part of unitParts(u))
    for (const g of part.groupIds) {
      const k = `${g}|${part.subjectId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ g, s: part.subjectId });
    }
  return out;
}

export interface CostItem {
  category: "pref" | "teacherGap" | "classGap" | "subjectTwice" | "roomWish" | "noRoom" | "late";
  cost: number;
  text: string;
}

export const COST_LABELS: Record<CostItem["category"], string> = {
  pref: "Zeitwünsche",
  teacherGap: "Hohlstunden Lehrkräfte",
  classGap: "Hohlstunden Klassen",
  subjectTwice: "Fach mehrfach am Tag",
  roomWish: "Raumwunsch",
  noRoom: "ohne Raum",
  late: "späte Stunden",
};

/** Woran es bei einer nicht gesetzten Einheit hängt (SP-G-03): je Beteiligtem die Zahl der Slots, die für ihn allein frei wären. */
export interface UnplacedCause {
  kind: "teacher" | "group" | "conflict" | "subject" | "double" | "day";
  id: string | null;
  label: string;
  /** Slots, in denen dieser Beteiligte allein nichts im Weg hätte */
  free: number;
  of: number;
  /** davon belegt (fixiert oder schon gesetzt) bzw. gesperrt (Zeitwunsch) */
  busy: number;
  blocked: number;
}

export interface Unplaced {
  unitId: string;
  label: string;
  /** lesbarer Grund („kein Slot frei – Lehrkraft LIN: 0 von 30 frei …“) */
  reason: string;
  /** Zählung je Beteiligtem, engster zuerst (SP-07 zeigt sie an) */
  causes: UnplacedCause[];
}

export interface GapStats {
  /** Hohlstunden aller Lehrkräfte in der Woche (Summe) und das Maximum einer Lehrkraft */
  teacherTotal: number;
  teacherMax: number;
  classTotal: number;
  classMax: number;
}

export interface SolverResult {
  placements: Placement[];
  /** Einheiten, die sich unter den harten Regeln nicht setzen ließen */
  unplaced: Unplaced[];
  score: number;
  /** Summe je Kategorie */
  breakdown: Record<CostItem["category"], number>;
  /** teuerste Einzelposten zuerst */
  items: CostItem[];
  stats: { units: number; iterations: number; improved: number };
  gaps: GapStats;
}

// ---------------------------------------------------------------- Hilfen

/** Deterministischer Zufall (Mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slotKey = (wd: number, nr: number) => `${wd}-${nr}`;

/** Lücken zwischen erster und letzter belegter Stunde (bezogen auf das Zeitraster). */
function holes(taken: Iterable<number>, periods: number[]): number[] {
  const set = new Set(taken);
  if (set.size < 2) return [];
  const min = Math.min(...set);
  const max = Math.max(...set);
  return periods.filter((p) => p > min && p < max && !set.has(p));
}

/** Anzahl Blöcke aufeinanderfolgender Stunden. */
function blockCount(ps: number[]): number {
  const s = [...new Set(ps)].sort((a, b) => a - b);
  let n = 0;
  for (let i = 0; i < s.length; i++) if (i === 0 || s[i]! !== s[i - 1]! + 1) n++;
  return n;
}

// ---------------------------------------------------------------- Zustand

class State {
  readonly w: SolverWeights;
  readonly place = new Map<string, Placement>();
  /** belegt: `t:${id}` / `g:${id}` / `r:${id}` → Set(slotKey) */
  private readonly busy = new Map<string, Set<string>>();
  /** Stunden je Lehrkraft-Tag bzw. Gruppen-Tag (inkl. fixierter), für Kosten */
  readonly teacherDay = new Map<string, number[]>();
  readonly groupDay = new Map<string, { nr: number; subjectId: string }[]>();
  /** Kurs-Stunden je Jahrgang × Tag (`${grade}|${wd}`): zählen für die Klassen des Jahrgangs als belegt (SP2-02) */
  private readonly gradeDay = new Map<string, number[]>();
  /** Klassen je Jahrgang (für die berührten Tage einer Kurs-Einheit) */
  private readonly classesByGrade = new Map<number, string[]>();
  readonly unitById: Map<string, SolverUnit>;
  /** je Einheit: Fächer und Paare Gruppe × Fach über alle Teile (einmal berechnet – `feasible` ist die heiße Schleife) */
  private readonly meta = new Map<string, { subjects: string[]; gs: { g: string; s: string }[]; dayClasses: string[] }>();
  /** SP2-03: Tagesgrenzen je Klasse (leer = keine) */
  private readonly dayRules: Map<string, DayRule>;
  /** SP2-03: belegte Stunden je Klasse × Tag (inkl. Kurse des Jahrgangs) mit letzter Stunde – zwischengespeichert, beim Ändern verworfen */
  private readonly dayCache = new Map<string, { set: Set<number>; max: number }>();
  readonly periodSet: Set<number>;
  /** nach diesen Stunden beginnt keine Doppelstunde (große Pause) */
  readonly noDoubleAfter: Set<number>;

  constructor(readonly input: SolverInput) {
    this.w = { ...DEFAULT_WEIGHTS, ...input.weights };
    this.unitById = new Map(input.units.map((u) => [u.id, u]));
    this.dayRules = input.dayRules ?? new Map();
    for (const [g, grade] of input.gradeOf ?? []) if (input.classIds.has(g)) this.classesByGrade.set(grade, [...(this.classesByGrade.get(grade) ?? []), g]);
    for (const u of input.units) this.meta.set(u.id, { subjects: unitSubjects(u), gs: unitGroupSubjects(u), dayClasses: this.dayClassesOf(u) });
    this.periodSet = new Set(input.periods);
    this.noDoubleAfter = new Set(input.breakAfter ?? []);
    for (const f of input.fixed) {
      this.mark(`g:${f.groupId}`, f.weekday, f.periodNr, true);
      if (f.teacherId) this.mark(`t:${f.teacherId}`, f.weekday, f.periodNr, true);
      if (f.roomId) this.mark(`r:${f.roomId}`, f.weekday, f.periodNr, true);
      if (f.teacherId) this.addDay(this.teacherDay, `${f.teacherId}|${f.weekday}`, f.periodNr);
      this.addGroupDay(f.groupId, f.weekday, f.periodNr, f.subjectId);
    }
  }

  private mark(key: string, wd: number, nr: number, on: boolean) {
    if (!this.busy.has(key)) this.busy.set(key, new Set());
    const s = this.busy.get(key)!;
    if (on) s.add(slotKey(wd, nr));
    else s.delete(slotKey(wd, nr));
  }
  isBusy(key: string, wd: number, nr: number) {
    return this.busy.get(key)?.has(slotKey(wd, nr)) ?? false;
  }
  private addDay(m: Map<string, number[]>, k: string, nr: number) {
    m.set(k, [...(m.get(k) ?? []), nr]);
  }
  private removeDay(m: Map<string, number[]>, k: string, nr: number) {
    const arr = m.get(k) ?? [];
    const i = arr.indexOf(nr);
    if (i >= 0) arr.splice(i, 1);
  }
  /** Jahrgang eines Kurses (keine Klasse) – dessen Stunden zählen für die Klassen des Jahrgangs */
  private courseGrade(g: string): number | undefined {
    return this.input.classIds.has(g) ? undefined : this.input.gradeOf?.get(g);
  }
  /** verwirft zwischengespeicherte Klassentage, die eine Stunde der Gruppe berührt (die Klasse bzw. die Klassen des Kurs-Jahrgangs) */
  private dropDays(g: string, wd: number) {
    if (!this.dayRules.size) return;
    this.dayCache.delete(`${g}|${wd}`);
    const grade = this.courseGrade(g);
    if (grade !== undefined) for (const c of this.classesByGrade.get(grade) ?? []) this.dayCache.delete(`${c}|${wd}`);
  }
  private addGroupDay(g: string, wd: number, nr: number, subjectId: string) {
    this.dropDays(g, wd);
    const k = `${g}|${wd}`;
    this.groupDay.set(k, [...(this.groupDay.get(k) ?? []), { nr, subjectId }]);
    const grade = this.courseGrade(g);
    if (grade !== undefined) this.addDay(this.gradeDay, `${grade}|${wd}`, nr);
  }
  private removeGroupDay(g: string, wd: number, nr: number, subjectId: string) {
    this.dropDays(g, wd);
    const arr = this.groupDay.get(`${g}|${wd}`) ?? [];
    const i = arr.findIndex((x) => x.nr === nr && x.subjectId === subjectId);
    if (i >= 0) arr.splice(i, 1);
    const grade = this.courseGrade(g);
    if (grade !== undefined) this.removeDay(this.gradeDay, `${grade}|${wd}`, nr);
  }
  /** Fächer einer Einheit (je Teil) */
  subjectsOf(u: SolverUnit): string[] {
    return this.meta.get(u.id)?.subjects ?? unitSubjects(u);
  }
  private groupSubjectsOf(u: SolverUnit): { g: string; s: string }[] {
    return this.meta.get(u.id)?.gs ?? unitGroupSubjects(u);
  }

  /** Stunden, die eine Einheit ab `nr` belegt (Doppelstunde: zwei aufeinanderfolgende, nicht über eine große Pause). */
  span(u: SolverUnit, nr: number): number[] | null {
    if (u.length === 1) return [nr];
    return this.periodSet.has(nr + 1) && !this.noDoubleAfter.has(nr) ? [nr, nr + 1] : null;
  }

  /**
   * Harte Regeln ohne Raum: Lehrkräfte/Gruppen frei, keine Konfliktgruppe parallel, nichts gesperrt (Fächer je Teil). Gruppen
   * derselben Einheit (Band) zählen nicht als Konflikt untereinander (Q-SP2-6). Tagesgrenzen der betroffenen Klassen (SP2-03) zuletzt.
   */
  feasible(u: SolverUnit, wd: number, nr: number): boolean {
    const span = this.span(u, nr);
    if (!span) return false;
    const subjects = this.subjectsOf(u);
    for (const p of span) {
      for (const t of u.teacherIds) if (this.isBusy(`t:${t}`, wd, p) || this.blocked("teacher", t, wd, p)) return false;
      for (const g of u.groupIds) {
        if (this.isBusy(`g:${g}`, wd, p) || this.blocked("group", g, wd, p)) return false;
        for (const c of this.input.conflicts.get(g) ?? []) if (!u.groupIds.includes(c) && this.isBusy(`g:${c}`, wd, p)) return false;
      }
      for (const s of subjects) if (this.blocked("subject", s, wd, p)) return false;
    }
    return !this.dayBlocked(u, wd, span);
  }

  /** SP2-03: Klassen mit Tagesgrenzen, die eine Einheit betrifft – die Klasse selbst bzw. bei Kursen die Klassen ihres Jahrgangs. */
  private dayClassesOf(u: SolverUnit): string[] {
    if (!this.dayRules.size) return [];
    const out = new Set<string>();
    for (const g of u.groupIds) {
      if (this.dayRules.has(g)) out.add(g);
      const grade = this.courseGrade(g);
      if (grade !== undefined) for (const c of this.classesByGrade.get(grade) ?? []) if (this.dayRules.has(c)) out.add(c);
    }
    return [...out];
  }

  /** Belegte Stunden einer Klasse am Tag: eigene und die der Kurse ihres Jahrgangs (SP2-02) – nicht verändern (Zwischenspeicher). */
  private classDay(classId: string, wd: number): { set: Set<number>; max: number } {
    const k = `${classId}|${wd}`;
    let v = this.dayCache.get(k);
    if (!v) {
      const set = new Set<number>();
      for (const x of this.groupDay.get(k) ?? []) set.add(x.nr);
      const grade = this.input.gradeOf?.get(classId);
      if (grade !== undefined) for (const nr of this.gradeDay.get(`${grade}|${wd}`) ?? []) set.add(nr);
      let max = 0;
      for (const p of set) if (p > max) max = p;
      v = { set, max };
      this.dayCache.set(k, v);
    }
    return v;
  }

  /**
   * SP2-03: Welche Tagesgrenze der Klasse verletzt `span` am Tag `wd` (mit allem, was schon liegt)? `null` = passt. Alle Regeln sind
   * monoton – wegnehmen verletzt nie etwas, deshalb genügt die Prüfung beim Hinzufügen.
   */
  dayViolation(classId: string, wd: number, span: readonly number[]): "max" | "lunch" | "afternoons" | null {
    const rule = this.dayRules.get(classId);
    if (!rule) return null;
    // dieselben Regeln wie `dayProblems`/`violationsWith` (tagesgrenzen.ts), ohne Kopien – `feasible` ist die heiße Schleife
    const day = this.classDay(classId, wd);
    const lunch = rule.lunchPeriod;
    let size = day.set.size;
    let max = day.max;
    let hasLunch = lunch !== null && day.set.has(lunch);
    for (const p of span) {
      if (!day.set.has(p)) size++;
      if (p > max) max = p;
      if (p === lunch) hasLunch = true;
    }
    if (rule.maxPerDay !== null && size > rule.maxPerDay) return "max";
    if (hasLunch && max > lunch!) return "lunch";
    const from = rule.afternoonFrom;
    if (rule.afternoonsPerWeek !== null && from !== null && day.max < from && max >= from) {
      let n = 1;
      for (const d of this.input.weekdays) if (d !== wd && this.classDay(classId, d).max >= from) n++;
      if (n > rule.afternoonsPerWeek) return "afternoons";
    }
    return null;
  }

  /** SP2-03: verletzt die Einheit im Slot eine Tagesgrenze einer betroffenen Klasse? */
  dayBlocked(u: SolverUnit, wd: number, span: readonly number[]): boolean {
    for (const c of this.meta.get(u.id)?.dayClasses ?? []) if (this.dayViolation(c, wd, span)) return true;
    return false;
  }

  blocked(kind: string, id: string, wd: number, nr: number) {
    return this.input.prefs.get(`${kind}:${id}`)?.get(slotKey(wd, nr)) === null;
  }
  pref(kind: string, id: string, wd: number, nr: number) {
    return this.input.prefs.get(`${kind}:${id}`)?.get(slotKey(wd, nr)) ?? 0;
  }

  /**
   * Warum passt die Einheit nirgends (SP-G-03)? Zählt je Beteiligtem die Slots, in denen er allein frei wäre –
   * engster Beteiligter zuerst. „Doppelstunde“ zählt die Startstunden, an denen ein Zweier-Block überhaupt möglich ist.
   */
  explain(u: SolverUnit): UnplacedCause[] {
    const name = (id: string) => this.input.names?.get(id) ?? id;
    const starts = this.input.weekdays.flatMap((wd) => this.input.periods.map((nr) => ({ wd, nr, span: this.span(u, nr) })));
    const possible = starts.filter((s) => s.span);
    const causes: UnplacedCause[] = [];
    if (u.length === 2) causes.push({ kind: "double", id: null, label: "Doppelstunde", free: possible.length, of: starts.length, busy: 0, blocked: starts.length - possible.length });
    const count = (kind: UnplacedCause["kind"], id: string | null, label: string, isBusy: (wd: number, p: number) => boolean, isBlocked: (wd: number, p: number) => boolean) => {
      let busy = 0;
      let blocked = 0;
      for (const s of possible) {
        if (s.span!.some((p) => isBlocked(s.wd, p))) blocked++;
        else if (s.span!.some((p) => isBusy(s.wd, p))) busy++;
      }
      causes.push({ kind, id, label, free: possible.length - busy - blocked, of: possible.length, busy, blocked });
    };
    for (const t of u.teacherIds)
      count(
        "teacher",
        t,
        `Lehrkraft ${name(t)}`,
        (wd, p) => this.isBusy(`t:${t}`, wd, p),
        (wd, p) => this.blocked("teacher", t, wd, p),
      );
    for (const g of u.groupIds) {
      count(
        "group",
        g,
        `${this.input.classIds.has(g) ? "Klasse" : "Gruppe"} ${name(g)}`,
        (wd, p) => this.isBusy(`g:${g}`, wd, p),
        (wd, p) => this.blocked("group", g, wd, p),
      );
      const others = [...(this.input.conflicts.get(g) ?? [])].filter((c) => !u.groupIds.includes(c));
      if (others.length)
        count(
          "conflict",
          g,
          `Kurse mit gemeinsamen Schüler:innen von ${name(g)}`,
          (wd, p) => others.some((c) => this.isBusy(`g:${c}`, wd, p)),
          () => false,
        );
    }
    for (const s of this.subjectsOf(u))
      if (this.input.prefs.has(`subject:${s}`))
        count(
          "subject",
          s,
          `Fach ${name(s)}`,
          () => false,
          (wd, p) => this.blocked("subject", s, wd, p),
        );
    // SP2-03: Tagesgrenzen je betroffener Klasse – Slots, in denen die Klasse (mit allem, was schon liegt) eine Grenze überschritte
    for (const c of this.meta.get(u.id)?.dayClasses ?? []) {
      const blocked = possible.filter((s) => this.dayViolation(c, s.wd, s.span!)).length;
      causes.push({ kind: "day", id: c, label: `Tagesgrenzen ${name(c)} (${ruleSummary(this.dayRules.get(c)!)})`, free: possible.length - blocked, of: possible.length, busy: 0, blocked });
    }
    return causes.sort((a, b) => a.free - b.free || a.label.localeCompare(b.label, "de"));
  }

  /**
   * Bester freier Raum für einen Teil im Slot: Wunschraum, Raumart, Stammraum, sonst ein Klassenraum. `taken` sind Räume,
   * die andere Teile derselben Einheit in diesem Slot schon haben.
   */
  chooseRoom(need: RoomNeed, wd: number, span: number[], taken?: ReadonlySet<string>): string | null {
    const free = (r: string) => !taken?.has(r) && span.every((p) => !this.isBusy(`r:${r}`, wd, p) && !this.blocked("room", r, wd, p));
    const fits = (r: SolverRoom) => r.capacity === null || need.size === 0 || r.capacity >= need.size;
    const byCap = (a: SolverRoom, b: SolverRoom) => (a.capacity ?? 999) - (b.capacity ?? 999) || a.id.localeCompare(b.id);
    if (need.roomId && free(need.roomId)) return need.roomId;
    if (need.roomKind) {
      // Fachraum: passende Größe zuerst, sonst trotzdem der Fachraum (lieber eng im Fachraum als im Klassenraum)
      const kindRooms = this.input.rooms.filter((x) => x.kind === need.roomKind).sort(byCap);
      const r = kindRooms.find((x) => fits(x) && free(x.id)) ?? kindRooms.find((x) => free(x.id));
      if (r) return r.id;
    }
    if (need.homeRoomId && free(need.homeRoomId)) return need.homeRoomId;
    const kind = need.roomKind ?? "klassenraum";
    const same = this.input.rooms
      .filter((x) => x.kind === kind && fits(x))
      .sort(byCap)
      .find((x) => free(x.id));
    if (same) return same.id;
    return (
      this.input.rooms
        .filter((x) => x.kind === "klassenraum" && fits(x))
        .sort(byCap)
        .find((x) => free(x.id))?.id ?? null
    );
  }

  /**
   * Räume je Teil der Einheit (SP-G-02): jeder Teil bekommt seinen eigenen Raum (geteilte Klasse mit zwei Lehrkräften → zwei
   * Räume); Teile mit einer gemeinsamen Lehrkraft teilen sich den Raum (eine Lehrkraft ist nur in einem Raum).
   */
  chooseRooms(u: SolverUnit, wd: number, span: number[]): (string | null)[] {
    if (u.parts.length === 1) return [this.chooseRoom(u.parts[0]!, wd, span)];
    const out: (string | null)[] = [];
    const taken = new Set<string>();
    const byTeacher = new Map<string, string | null>();
    u.parts.forEach((part, i) => {
      const shared = part.teacherIds.find((t) => byTeacher.has(t));
      let room: string | null;
      if (shared !== undefined) room = byTeacher.get(shared)!;
      else {
        // Teile, die sich mit dieser Lehrkraft den Raum teilen (eine Lehrkraft, mehrere Gruppen), zählen zur Raumgröße mit
        const size = u.parts.slice(i + 1).reduce((s, q) => (q.teacherIds.some((t) => part.teacherIds.includes(t)) ? s + q.size : s), part.size);
        room = this.chooseRoom(size === part.size ? part : { ...part, size }, wd, span, taken);
      }
      if (room) taken.add(room);
      for (const t of part.teacherIds) byTeacher.set(t, room);
      out.push(room);
    });
    return out;
  }

  /** Platzierung einer Einheit im Slot mit Räumen je Teil. */
  placeAt(u: SolverUnit, wd: number, nr: number): Placement {
    const roomIds = this.chooseRooms(u, wd, this.span(u, nr)!);
    return { unitId: u.id, weekday: wd, periodNr: nr, roomId: roomIds[0] ?? null, roomIds };
  }

  roomWishMet(need: RoomNeed, roomId: string | null): boolean {
    if (!roomId) return false;
    if (need.roomId) return roomId === need.roomId;
    if (need.roomKind) return this.input.rooms.find((r) => r.id === roomId)?.kind === need.roomKind;
    if (need.homeRoomId) return roomId === need.homeRoomId;
    return true;
  }

  /** belegte Räume einer Platzierung (je Raum einmal); ein Teil = der häufige Fall, ohne Umwege */
  private roomsOf(u: SolverUnit, p: Placement): string[] {
    if (u.parts.length <= 1) return p.roomId ? [p.roomId] : [];
    return [...new Set(placementRooms(p, u.parts.length).filter((r): r is string => r !== null))];
  }

  apply(p: Placement) {
    const u = this.unitById.get(p.unitId)!;
    const rooms = this.roomsOf(u, p);
    const gs = this.groupSubjectsOf(u);
    for (const nr of this.span(u, p.periodNr)!) {
      for (const t of u.teacherIds) {
        this.mark(`t:${t}`, p.weekday, nr, true);
        this.addDay(this.teacherDay, `${t}|${p.weekday}`, nr);
      }
      for (const g of u.groupIds) this.mark(`g:${g}`, p.weekday, nr, true);
      for (const x of gs) this.addGroupDay(x.g, p.weekday, nr, x.s);
      for (const r of rooms) this.mark(`r:${r}`, p.weekday, nr, true);
    }
    this.place.set(u.id, p);
  }

  unapply(unitId: string) {
    const p = this.place.get(unitId);
    if (!p) return;
    const u = this.unitById.get(unitId)!;
    const rooms = this.roomsOf(u, p);
    const gs = this.groupSubjectsOf(u);
    for (const nr of this.span(u, p.periodNr)!) {
      for (const t of u.teacherIds) {
        this.mark(`t:${t}`, p.weekday, nr, false);
        this.removeDay(this.teacherDay, `${t}|${p.weekday}`, nr);
      }
      for (const g of u.groupIds) this.mark(`g:${g}`, p.weekday, nr, false);
      for (const x of gs) this.removeGroupDay(x.g, p.weekday, nr, x.s);
      for (const r of rooms) this.mark(`r:${r}`, p.weekday, nr, false);
    }
    this.place.delete(unitId);
  }

  // ------------------------------------------------------------ Kosten

  unitCost(u: SolverUnit, p: Placement, items?: CostItem[]): number {
    let c = 0;
    const w = this.w;
    const rooms = u.parts.length <= 1 ? [p.roomId] : placementRooms(p, u.parts.length);
    const distinctRooms = this.roomsOf(u, p);
    const subjects = this.subjectsOf(u);
    for (const nr of this.span(u, p.periodNr)!) {
      let pv = 0;
      for (const t of u.teacherIds) pv += this.pref("teacher", t, p.weekday, nr);
      for (const g of u.groupIds) pv += this.pref("group", g, p.weekday, nr);
      for (const s of subjects) pv += this.pref("subject", s, p.weekday, nr);
      for (const r of distinctRooms) pv += this.pref("room", r, p.weekday, nr);
      if (pv !== 0) {
        c -= pv * w.pref;
        items?.push({ category: "pref", cost: -pv * w.pref, text: `${u.label}: ${pv > 0 ? "erwünschte" : "ungünstige"} Zeit (${pv > 0 ? "+" : ""}${pv})` });
      }
      if (nr > w.lateFrom) {
        const lc = (nr - w.lateFrom) * w.late;
        c += lc;
        items?.push({ category: "late", cost: lc, text: `${u.label}: ${nr}. Stunde` });
      }
    }
    // Raum je Teil (SP-G-02): jeder Teil ohne Raum bzw. ohne Wunschraum kostet
    u.parts.forEach((part, i) => {
      const room = rooms[i] ?? null;
      const who = u.parts.length > 1 && part.teacherIds.length ? ` (${part.teacherIds.map((t) => this.input.names?.get(t) ?? t).join(" + ")})` : "";
      if (!room) {
        c += w.noRoom;
        items?.push({ category: "noRoom", cost: w.noRoom, text: `${u.label}${who}: kein Raum frei` });
      } else if (!this.roomWishMet(part, room)) {
        c += w.roomWish;
        items?.push({ category: "roomWish", cost: w.roomWish, text: `${u.label}${who}: Raum ${room} statt Wunsch` });
      }
    });
    return c;
  }

  teacherHoles(key: string): number {
    return holes(this.teacherDay.get(key) ?? [], this.input.periods).length;
  }

  teacherDayCost(key: string, items?: CostItem[], label?: string): number {
    const h = this.teacherHoles(key);
    if (h && items) items.push({ category: "teacherGap", cost: h * this.w.teacherGap, text: `${label}: ${h} Hohlstunde${h > 1 ? "n" : ""}` });
    return h * this.w.teacherGap;
  }

  /** Hohlstunden einer Klasse an einem Tag; Kurs-Stunden des Jahrgangs (Kursband) zählen als belegt, wenn die Klasse an dem Tag Unterricht hat. */
  classHoles(key: string): number {
    const [g, wd] = key.split("|");
    if (!this.input.classIds.has(g!)) return 0;
    const own = (this.groupDay.get(key) ?? []).map((x) => x.nr);
    if (!own.length) return 0;
    const grade = this.input.gradeOf?.get(g!);
    const band = grade === undefined ? [] : (this.gradeDay.get(`${grade}|${wd}`) ?? []);
    return holes(band.length ? [...own, ...band] : own, this.input.periods).length;
  }

  groupDayCost(key: string, items?: CostItem[], label?: string): number {
    const day = this.groupDay.get(key) ?? [];
    let c = 0;
    const h = this.classHoles(key);
    if (h) {
      c += h * this.w.classGap;
      items?.push({ category: "classGap", cost: h * this.w.classGap, text: `${label}: ${h} Hohlstunde${h > 1 ? "n" : ""}` });
    }
    const bySubject = new Map<string, number[]>();
    for (const x of day) bySubject.set(x.subjectId, [...(bySubject.get(x.subjectId) ?? []), x.nr]);
    for (const [s, ps] of bySubject) {
      const extra = blockCount(ps) - 1 + (ps.length > 2 ? ps.length - 2 : 0);
      if (extra > 0) {
        c += extra * this.w.subjectTwice;
        items?.push({ category: "subjectTwice", cost: extra * this.w.subjectTwice, text: `${label}: ${this.input.names?.get(s) ?? s} ${ps.length}× am Tag` });
      }
    }
    return c;
  }

  /** Kosten aller Tage, die eine Einheit berührt (für Deltas) – ein Kurs berührt auch die Klassen seines Jahrgangs (Hohlstunden). */
  touchedDays(u: SolverUnit, wds: number[]): { t: string[]; g: string[] } {
    const t: string[] = [];
    const g: string[] = [];
    for (const wd of new Set(wds)) {
      for (const x of u.teacherIds) t.push(`${x}|${wd}`);
      for (const x of u.groupIds) {
        g.push(`${x}|${wd}`);
        const grade = this.courseGrade(x);
        if (grade !== undefined) for (const c of this.classesByGrade.get(grade) ?? []) g.push(`${c}|${wd}`);
      }
    }
    return { t, g };
  }

  localCost(units: SolverUnit[], wds: number[]): number {
    const t = new Set<string>();
    const g = new Set<string>();
    for (const u of units) {
      const d = this.touchedDays(u, wds);
      d.t.forEach((x) => t.add(x));
      d.g.forEach((x) => g.add(x));
    }
    let c = 0;
    for (const k of t) c += this.teacherDayCost(k);
    for (const k of g) c += this.groupDayCost(k);
    for (const u of units) {
      const p = this.place.get(u.id);
      if (p) c += this.unitCost(u, p);
    }
    return c;
  }

  total(items?: CostItem[], labels?: (kind: "t" | "g", id: string, wd: number) => string): number {
    let c = 0;
    for (const u of this.input.units) {
      const p = this.place.get(u.id);
      if (p) c += this.unitCost(u, p, items);
    }
    for (const k of this.teacherDay.keys()) {
      const [id, wd] = k.split("|");
      c += this.teacherDayCost(k, items, labels?.("t", id!, Number(wd)));
    }
    for (const k of this.groupDay.keys()) {
      const [id, wd] = k.split("|");
      c += this.groupDayCost(k, items, labels?.("g", id!, Number(wd)));
    }
    return c;
  }

  /** Hohlstunden je Lehrkraft und Klasse in der Woche: Summe und Maximum (Kennzahlen eines Laufs). */
  gapStats(): GapStats {
    const perTeacher = new Map<string, number>();
    for (const k of this.teacherDay.keys()) {
      const id = k.split("|")[0]!;
      perTeacher.set(id, (perTeacher.get(id) ?? 0) + this.teacherHoles(k));
    }
    const perClass = new Map<string, number>();
    for (const k of this.groupDay.keys()) {
      const id = k.split("|")[0]!;
      if (!this.input.classIds.has(id)) continue;
      perClass.set(id, (perClass.get(id) ?? 0) + this.classHoles(k));
    }
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + x, 0);
    const max = (m: Map<string, number>) => Math.max(0, ...m.values());
    return { teacherTotal: sum(perTeacher), teacherMax: max(perTeacher), classTotal: sum(perClass), classMax: max(perClass) };
  }
}

// ---------------------------------------------------------------- Lösen

/** Wie schwer ist eine Einheit unterzubringen? Mehr Beteiligte, Doppelstunden, Fachräume (in einem Teil) und Sperren zuerst. */
function difficulty(s: State, u: SolverUnit): number {
  let free = 0;
  for (const wd of s.input.weekdays) for (const nr of s.input.periods) if (s.feasible(u, wd, nr)) free++;
  const roomKind = u.parts.length ? u.parts.some((p) => p.roomKind) : Boolean(u.roomKind);
  return -free * 10 + u.groupIds.length * 5 + u.teacherIds.length * 5 + (u.length === 2 ? 20 : 0) + (roomKind ? 10 : 0);
}

/** Lesbarer Grund aus der Zählung: engste Beteiligte zuerst, höchstens drei. */
export function unplacedReason(causes: UnplacedCause[]): string {
  const part = (c: UnplacedCause) => {
    if (c.kind === "double") return `${c.label}: nur ${c.free} von ${c.of} Startstunden möglich`;
    const why = [c.busy ? `${c.busy} belegt` : null, c.blocked ? `${c.blocked} gesperrt` : null].filter(Boolean).join(", ");
    return `${c.label}: ${c.free} von ${c.of} Slots frei${why ? ` (${why})` : ""}`;
  };
  const tight = causes.filter((c) => c.free < c.of).slice(0, 3);
  return `kein Slot frei${tight.length ? ` – ${tight.map(part).join(" · ")}` : " (alle Beteiligten einzeln frei, zusammen nie)"}`;
}

/**
 * Solver in Schritten (für Hintergrundjobs mit Fortschritt): construct() → improve(n) beliebig oft → result().
 * Gleicher Input und Startwert ergeben dieselbe Lösung, egal in wie vielen Schritten konstruiert oder verbessert wird.
 */
export function createSolver(input: SolverInput) {
  const s = new State(input);
  const random = rng(input.seed ?? 1);
  const unplaced: Unplaced[] = [];
  let placedUnits: SolverUnit[] = [];
  const slots = input.weekdays.flatMap((wd) => input.periods.map((nr) => ({ wd, nr })));
  const byGroup = new Map<string, SolverUnit[]>();
  let done = 0;
  let improved = 0;
  let total = 0;
  /** Schwierigkeit je Einheit (einmal berechnet, in Scheiben), daraus die Reihenfolge der Konstruktion und wie weit sie ist */
  const rank = new Map<string, number>();
  let order: SolverUnit[] | null = null;
  let constructed = 0;

  /** Günstigster zulässiger Slot für eine Einheit (oder null). */
  function bestSlot(u: SolverUnit): Placement | null {
    let best: { p: Placement; cost: number } | null = null;
    for (const wd of input.weekdays) {
      for (const nr of input.periods) {
        if (!s.feasible(u, wd, nr)) continue;
        const p = s.placeAt(u, wd, nr);
        const before = s.localCost([u], [wd]);
        s.apply(p);
        const cost = s.localCost([u], [wd]) - before;
        s.unapply(u.id);
        if (!best || cost < best.cost) best = { p, cost };
      }
    }
    return best?.p ?? null;
  }

  /** Gesetzte Einheiten, die `u` im Slot im Weg stehen (gleiche Lehrkraft, Gruppe oder Konfliktgruppe). */
  function blockersAt(u: SolverUnit, wd: number, nr: number): SolverUnit[] | null {
    const span = s.span(u, nr);
    if (!span) return null;
    // Sperrzeiten und fixierte Stunden lassen sich nicht verdrängen
    for (const p of span) {
      if (
        u.teacherIds.some((t) => s.blocked("teacher", t, wd, p)) ||
        u.groupIds.some((g) => s.blocked("group", g, wd, p)) ||
        s.subjectsOf(u).some((x) => s.blocked("subject", x, wd, p))
      )
        return null;
    }
    // Tagesgrenzen (SP2-03): Verdrängen im selben Slot ändert die belegten Stunden des Tages nicht – hier hilft keine Reparatur
    if (s.dayBlocked(u, wd, span)) return null;
    const related = (g: string) => [g, ...(input.conflicts.get(g) ?? [])];
    const groupsHit = new Set(u.groupIds.flatMap(related));
    const out: SolverUnit[] = [];
    for (const [id, p] of s.place) {
      const v = s.unitById.get(id)!;
      if (p.weekday !== wd) continue;
      const vs = s.span(v, p.periodNr)!;
      if (!vs.some((x) => span.includes(x))) continue;
      if (v.teacherIds.some((t) => u.teacherIds.includes(t)) || v.groupIds.some((g) => groupsHit.has(g))) out.push(v);
    }
    return out;
  }

  /** Reparatur: bis zu zwei blockierende Einheiten verdrängen, `u` setzen, die Verdrängten anderswo neu setzen. */
  function repair(u: SolverUnit): boolean {
    for (const wd of input.weekdays) {
      for (const nr of input.periods) {
        const blockers = blockersAt(u, wd, nr);
        if (!blockers || !blockers.length || blockers.length > 2) continue;
        const old = blockers.map((v) => s.place.get(v.id)!);
        blockers.forEach((v) => s.unapply(v.id));
        if (s.feasible(u, wd, nr)) {
          s.apply(s.placeAt(u, wd, nr));
          const moved: string[] = [];
          for (const v of blockers) {
            const p = bestSlot(v);
            if (!p) break;
            s.apply(p);
            moved.push(v.id);
          }
          if (moved.length === blockers.length) return true;
          moved.forEach((id) => s.unapply(id));
          s.unapply(u.id);
        }
        old.forEach((p) => s.apply(p));
      }
    }
    return false;
  }

  /**
   * 1. Konstruktion: schwierigste zuerst, je Einheit der günstigste zulässige Slot; Sackgassen per Reparatur lösen.
   * Mit `budget` werden nur so viele Einheiten gesetzt, bis `budget()` false liefert (mindestens eine); liefert die Zahl
   * der noch nicht konstruierten Einheiten – 0 heißt fertig, erst dann sind improve()/result() sinnvoll.
   */
  function construct(budget?: () => boolean): number {
    if (!order) {
      // Schwierigkeit vor der ersten Platzierung bewerten (der Zustand ändert sich dabei nicht) – je Einheit einmal, in Scheiben
      for (const u of input.units) {
        if (rank.has(u.id)) continue;
        rank.set(u.id, difficulty(s, u));
        if (budget && rank.size < input.units.length && !budget()) return input.units.length;
      }
      order = [...input.units].sort((a, b) => rank.get(b.id)! - rank.get(a.id)! || a.id.localeCompare(b.id));
    }
    while (constructed < order.length) {
      const u = order[constructed++]!;
      const p = bestSlot(u);
      if (p) s.apply(p);
      else if (!repair(u)) {
        const causes = s.explain(u);
        unplaced.push({ unitId: u.id, label: u.label, reason: unplacedReason(causes), causes });
      }
      if (budget && constructed < order.length && !budget()) return order.length - constructed;
    }
    if (!placedUnits.length && !byGroup.size) {
      placedUnits = input.units.filter((u) => s.place.has(u.id));
      for (const u of placedUnits) for (const g of u.groupIds) byGroup.set(g, [...(byGroup.get(g) ?? []), u]);
      total = input.iterations ?? Math.min(40000, placedUnits.length * 40);
    }
    return 0;
  }

  /**
   * 2. Lokale Suche: `n` Schritte Verschieben/Tauschen, nur wenn es nicht schlechter wird (`Infinity` = bis zum Richtwert `total`;
   * mehr Schritte als `total` sind erlaubt – Gründlichkeit „gründlich“ rechnet das Vierfache). Liefert die bis `total` verbleibenden Schritte.
   */
  function improve(n: number): number {
    const stop = Number.isFinite(n) ? done + n : Math.max(total, done);
    for (; done < stop && placedUnits.length; done++) step();
    return Math.max(0, total - done);
  }

  function step() {
    const u = placedUnits[Math.floor(random() * placedUnits.length)]!;
    const old = s.place.get(u.id)!;
    if (random() < 0.6) {
      // Verschieben
      const t = slots[Math.floor(random() * slots.length)]!;
      if (t.wd === old.weekday && t.nr === old.periodNr) return;
      const before = s.localCost([u], [old.weekday, t.wd]);
      s.unapply(u.id);
      if (!s.feasible(u, t.wd, t.nr)) {
        s.apply(old);
        return;
      }
      s.apply(s.placeAt(u, t.wd, t.nr));
      const after = s.localCost([u], [old.weekday, t.wd]);
      if (after <= before) {
        if (after < before) improved++;
      } else {
        s.unapply(u.id);
        s.apply(old);
      }
      return;
    }
    // Tauschen mit einer anderen Einheit derselben Gruppe (gleiche Länge)
    const peers = (byGroup.get(u.groupIds[0]!) ?? []).filter((v) => v.id !== u.id && v.length === u.length);
    if (!peers.length) return;
    const v = peers[Math.floor(random() * peers.length)]!;
    const pv = s.place.get(v.id)!;
    const days = [old.weekday, pv.weekday];
    const before = s.localCost([u, v], days);
    s.unapply(u.id);
    s.unapply(v.id);
    let ok = s.feasible(u, pv.weekday, pv.periodNr);
    let pu: Placement | null = null;
    if (ok) {
      pu = s.placeAt(u, pv.weekday, pv.periodNr);
      s.apply(pu);
      ok = s.feasible(v, old.weekday, old.periodNr);
    }
    if (ok) {
      s.apply(s.placeAt(v, old.weekday, old.periodNr));
      const after = s.localCost([u, v], days);
      if (after <= before) {
        if (after < before) improved++;
        return;
      }
      s.unapply(v.id);
    }
    if (pu) s.unapply(u.id);
    s.apply(old);
    s.apply(pv);
  }

  /** Aktuelle Bewertung ohne Einzelposten (Zwischenstand im Protokoll). */
  function score(): number {
    return s.total();
  }

  /** 3. Ergebnis mit Bewertung. */
  function result(): SolverResult {
    const items: CostItem[] = [];
    const wdName = ["Mo", "Di", "Mi", "Do", "Fr"];
    const score = s.total(items, (_kind, id, wd) => `${input.names?.get(id) ?? id} ${wdName[wd] ?? wd}`);
    const breakdown = Object.fromEntries(Object.keys(COST_LABELS).map((k) => [k, 0])) as SolverResult["breakdown"];
    for (const i of items) breakdown[i.category] += i.cost;
    return {
      placements: input.units.filter((u) => s.place.has(u.id)).map((u) => s.place.get(u.id)!),
      unplaced,
      score,
      breakdown,
      items: items.filter((i) => i.cost > 0).sort((a, b) => b.cost - a.cost),
      stats: { units: input.units.length, iterations: done, improved },
      gaps: s.gapStats(),
    };
  }

  return {
    construct,
    improve,
    score,
    result,
    get total() {
      return total;
    },
    /** Zahl der gesetzten Einheiten nach der Konstruktion */
    get placed() {
      return placedUnits.length;
    },
  };
}

/** Erstellt einen Stundenplan aus den Einheiten (deterministisch bei gleichem Input und Startwert). */
export function solve(input: SolverInput): SolverResult {
  const solver = createSolver(input);
  solver.construct();
  solver.improve(Number.POSITIVE_INFINITY);
  return solver.result();
}

/** Prüft eine Lösung gegen die harten Regeln (für Tests und vor dem Übernehmen). Liefert Verstöße als Text. */
export function validate(input: SolverInput, placements: Placement[]): string[] {
  const errors: string[] = [];
  const s = new State(input);
  for (const p of placements) {
    const u = s.unitById.get(p.unitId);
    if (!u) {
      errors.push(`unbekannte Einheit ${p.unitId}`);
      continue;
    }
    if (!s.feasible(u, p.weekday, p.periodNr)) errors.push(`${u.label}: ${p.weekday}-${p.periodNr} verletzt eine harte Regel`);
    const span = s.span(u, p.periodNr) ?? [];
    for (const room of new Set(placementRooms(p, u.parts.length)))
      if (room && span.some((nr) => s.isBusy(`r:${room}`, p.weekday, nr))) errors.push(`${u.label}: Raum ${room} doppelt belegt`);
    if (s.feasible(u, p.weekday, p.periodNr)) s.apply(p);
  }
  return errors;
}
