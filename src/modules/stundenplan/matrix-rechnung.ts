// SP3-LA: Lehraufträge schnell anlegen – Matrix Klasse × Fach. Reine Rechnung ohne DB (auch im Browser: Matrix, Typeahead, Live-Bilanz).

/** Lehrauftrag in einer Zelle (am Stichtag gültig) */
export interface MatrixAssignment {
  id: string;
  hours: number;
  teacherIds: string[];
  teacherCodes: string[];
  bandId: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

export interface MatrixCell {
  groupId: string;
  subjectId: string;
  /** Stundentafel-Soll des Jahrgangs für das Fach; `null` = steht nicht in der Stundentafel */
  soll: number | null;
  assignments: MatrixAssignment[];
  /**
   * In der Matrix bearbeitbar: leer oder genau ein eigenständiger Lehrauftrag mit höchstens einer Lehrkraft. Bänder und Teamteaching
   * bleiben im Formular (Link aus der Zelle).
   */
  editable: boolean;
}

export interface MatrixRow {
  groupId: string;
  name: string;
  gradeLevel: number | null;
  /** Summe der Stundentafel des Jahrgangs */
  curriculum: number | null;
  cells: MatrixCell[];
}

export interface MatrixColumn {
  subjectId: string;
  name: string;
  color: string;
}

export interface Matrix {
  columns: MatrixColumn[];
  rows: MatrixRow[];
}

export const cellKey = (groupId: string, subjectId: string) => `${groupId}|${subjectId}`;

export interface MatrixSource {
  classes: { id: string; name: string; gradeLevel: number | null }[];
  subjects: { id: string; name: string; color: string; sortOrder?: number }[];
  /** Stundentafel je Jahrgang und Fach */
  curriculum: ReadonlyMap<number, ReadonlyMap<string, number>>;
  /** am Stichtag gültige Lehraufträge (je genau eine Gruppe) */
  assignments: {
    id: string;
    subjectId: string;
    hours: number;
    bandId: string | null;
    validFrom: string | null;
    validUntil: string | null;
    groups: { id: string }[];
    teachers: { id: string; code: string | null; name: string }[];
  }[];
  /** zusätzliche Spalten (z. B. Fächer aus Vorschlägen) */
  extraSubjects?: readonly string[];
}

/**
 * Rein: Matrix für die gegebenen Klassen. Spalten = Fächer der Stundentafel dieser Jahrgänge, dazu Fächer mit Lehraufträgen in diesen
 * Klassen (und `extraSubjects`), in der Reihenfolge der Fächerliste.
 */
export function buildMatrix(src: MatrixSource): Matrix {
  const classIds = new Set(src.classes.map((c) => c.id));
  const used = new Set<string>(src.extraSubjects ?? []);
  for (const c of src.classes) if (c.gradeLevel !== null) for (const [s, h] of src.curriculum.get(c.gradeLevel) ?? []) if (h > 0) used.add(s);
  const inClasses = src.assignments.filter((a) => a.groups.some((g) => classIds.has(g.id)));
  for (const a of inClasses) used.add(a.subjectId);
  const columns = src.subjects.filter((s) => used.has(s.id)).map((s) => ({ subjectId: s.id, name: s.name, color: s.color }));
  const rows = src.classes.map((c) => {
    const tafel = c.gradeLevel === null ? undefined : src.curriculum.get(c.gradeLevel);
    const cells = columns.map((col): MatrixCell => {
      const list = inClasses
        .filter((a) => a.subjectId === col.subjectId && a.groups.some((g) => g.id === c.id))
        .map((a) => ({
          id: a.id,
          hours: a.hours,
          teacherIds: a.teachers.map((t) => t.id),
          teacherCodes: a.teachers.map((t) => t.code ?? t.name),
          bandId: a.bandId,
          validFrom: a.validFrom,
          validUntil: a.validUntil,
        }));
      const soll = tafel?.get(col.subjectId);
      return {
        groupId: c.id,
        subjectId: col.subjectId,
        soll: soll === undefined || soll === 0 ? null : soll,
        assignments: list,
        editable: list.length === 0 || (list.length === 1 && !list[0]!.bandId && list[0]!.teacherIds.length <= 1),
      };
    });
    const curriculum = tafel ? [...tafel.values()].reduce((s, h) => s + h, 0) : null;
    return { groupId: c.id, name: c.name, gradeLevel: c.gradeLevel, curriculum, cells };
  });
  return { columns, rows };
}

// ---------------------------------------------------------------- Zellwerte und Änderungen

/** Wert einer bearbeitbaren Zelle (Lehrkraft leer = offen; Stunden 0 = kein Lehrauftrag) */
export interface CellValue {
  teacherId: string | null;
  hours: number;
}

/** Ausgangswert einer Zelle (nur bearbeitbare Zellen) */
export function cellValue(cell: MatrixCell): CellValue {
  const a = cell.assignments[0];
  return a ? { teacherId: a.teacherIds[0] ?? null, hours: a.hours } : { teacherId: null, hours: 0 };
}

export const sameValue = (a: CellValue, b: CellValue) => a.teacherId === b.teacherId && a.hours === b.hours;

/** Änderung, die an den Server geht */
export interface MatrixEdit {
  groupId: string;
  subjectId: string;
  /** bestehender Lehrauftrag der Zelle; `null` = neu anlegen */
  assignmentId: string | null;
  teacherId: string | null;
  /** 1–12; 0 = Lehrauftrag löschen bzw. nichts anlegen */
  hours: number;
  /** „Trotzdem zuweisen“ für die fachfremde Lehrkraft (R2-P3: gilt nur für diese Lehrkraft) */
  offSubjectOk?: string | null;
}

/** Art der Änderung einer Zelle */
export function editKind(e: Pick<MatrixEdit, "assignmentId" | "hours">): "create" | "update" | "delete" | "none" {
  if (e.assignmentId) return e.hours > 0 ? "update" : "delete";
  return e.hours > 0 ? "create" : "none";
}

// ---------------------------------------------------------------- Live-Bilanz

export interface BalanceAccount {
  id: string;
  code: string | null;
  name: string;
  /** Soll am Stichtag */
  target: number;
  /** Wochenstunden in Lehraufträgen am Stichtag (Server-Stand) */
  assigned: number;
}

export interface LiveBalance extends BalanceAccount {
  /** Lehraufträge mit den ungespeicherten Änderungen */
  live: number;
  /** live − Server-Stand */
  delta: number;
  /** Soll − live (negativ = Überhang) */
  rest: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Rein: Deputatsbilanz mit ungespeicherten Änderungen. Je geänderter Zelle zählen die Stunden der bisherigen Lehrkraft ab und die neuen
 * der neuen Lehrkraft hinzu (Bänder und Teamteaching sind in der Matrix nicht bearbeitbar – kein Doppelzählen). Gibt die betroffenen
 * Lehrkräfte zurück (bisherige und neue), sortiert nach Kürzel.
 */
export function liveBalance(accounts: readonly BalanceAccount[], changes: readonly { before: CellValue; after: CellValue }[]): LiveBalance[] {
  const delta = new Map<string, number>();
  const add = (id: string | null, h: number) => {
    if (!id || h === 0) return;
    delta.set(id, (delta.get(id) ?? 0) + h);
  };
  const touched = new Set<string>();
  for (const { before, after } of changes) {
    if (sameValue(before, after)) continue;
    add(before.teacherId, -before.hours);
    add(after.teacherId, after.hours);
    if (before.teacherId) touched.add(before.teacherId);
    if (after.teacherId) touched.add(after.teacherId);
  }
  return accounts
    .filter((a) => touched.has(a.id))
    .map((a) => {
      const d = r1(delta.get(a.id) ?? 0);
      const live = r1(a.assigned + d);
      return { ...a, live, delta: d, rest: r1(a.target - live) };
    })
    .sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name, "de") || a.id.localeCompare(b.id));
}

/** Rein: Restdeputat je Lehrkraft mit den ungespeicherten Änderungen (für die Vorschlagsliste des Typeaheads). */
export function liveRest(accounts: readonly BalanceAccount[], changes: readonly { before: CellValue; after: CellValue }[]): Map<string, number> {
  const touched = new Map(liveBalance(accounts, changes).map((b) => [b.id, b.rest]));
  return new Map(accounts.map((a) => [a.id, touched.get(a.id) ?? r1(a.target - a.assigned)]));
}

// ---------------------------------------------------------------- Typeahead

export interface TypeaheadTeacher {
  id: string;
  code: string | null;
  name: string;
  inactive?: boolean;
}

/**
 * Rein: Eingabe im Lehrkraft-Feld auflösen – Kürzel (ohne Groß-/Kleinschreibung), der Vorschlagstext „KÜR – Name …“ oder der volle Name.
 * Leer = offen. `null` = nicht gefunden.
 */
export function resolveTeacher<T extends TypeaheadTeacher>(text: string, list: readonly T[]): { teacher: T | null } | null {
  const q = text.trim();
  if (!q) return { teacher: null };
  const low = q.toLocaleLowerCase("de");
  const byCode = list.find((t) => t.code && t.code.toLocaleLowerCase("de") === low);
  if (byCode) return { teacher: byCode };
  const head = low.split(" – ")[0]!.trim();
  const byHead = list.find((t) => t.code && t.code.toLocaleLowerCase("de") === head);
  if (byHead && low.includes(" – ")) return { teacher: byHead };
  const byName = list.filter((t) => t.name.toLocaleLowerCase("de") === low);
  return byName.length === 1 ? { teacher: byName[0]! } : null;
}

/** Anzeige einer Lehrkraft im Feld: Kürzel, sonst Name */
export const teacherText = (t: Pick<TypeaheadTeacher, "code" | "name"> | undefined | null) => (t ? (t.code ?? t.name) : "");

// ---------------------------------------------------------------- Gültigkeit neuer Lehraufträge

const nextDay = (ymd: string, days: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
};

/**
 * Rein: Gültigkeit eines neuen Lehrauftrags aus der Matrix – er füllt die Lücke am Stichtag zwischen den Lehraufträgen derselben Zelle,
 * die zu anderer Zeit gelten (z. B. Übernahme aus dem 1. Halbjahr: ab Beginn des 2. Halbjahrs). Ohne solche: ganzes Schuljahr (`null`).
 */
export function gapAround(refYmd: string, others: readonly { validFrom: string | null; validUntil: string | null }[]): { validFrom: string | null; validUntil: string | null } {
  let from: string | null = null;
  let until: string | null = null;
  for (const o of others) {
    if (o.validUntil !== null && o.validUntil < refYmd) {
      const f = nextDay(o.validUntil, 1);
      if (from === null || f > from) from = f;
    }
    if (o.validFrom !== null && o.validFrom > refYmd) {
      const u = nextDay(o.validFrom, -1);
      if (until === null || u < until) until = u;
    }
  }
  return { validFrom: from, validUntil: until };
}

// ---------------------------------------------------------------- Übernahme (F-10-7)

export interface PreviousAssignment {
  groupId: string;
  subjectId: string;
  hours: number;
  teacherIds: string[];
  bandId: string | null;
}

export interface Suggestion {
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  hours: number;
  /** Herkunft für die Anzeige, z. B. „Klasse 7b: BRA“ */
  from: string;
}

/**
 * Rein (F-10-7): Vorschläge „Lehrkraft folgt der Klasse“. Je Lehrauftrag der Quelle (nur eigenständige Lehraufträge von Klassen –
 * Kurse und Bänder werden nicht übernommen) wird die Klasse über `classMap` zugeordnet; ein Vorschlag entsteht nur für eine leere,
 * bearbeitbare Zelle der Matrix. Stunden: Stundentafel-Soll der Zelle, sonst die bisherigen. Nicht aktive Lehrkräfte werden nicht
 * vorgeschlagen (Zelle bleibt mit den Stunden, Lehrkraft offen). Mehrere Lehraufträge in einer Zielzelle (Teamteaching, mehrere Quellen
 * auf eine Klasse) → kein Vorschlag, weil die Lehrkraft nicht eindeutig folgt.
 */
export function suggestFrom(
  prev: readonly PreviousAssignment[],
  classMap: ReadonlyMap<string, string>,
  matrix: Matrix,
  opts: { active: ReadonlySet<string>; groupName: ReadonlyMap<string, string>; teacherCode: ReadonlyMap<string, string> },
): Suggestion[] {
  const cells = new Map<string, MatrixCell>();
  for (const r of matrix.rows) for (const c of r.cells) cells.set(cellKey(c.groupId, c.subjectId), c);
  const candidates = new Map<string, { p: PreviousAssignment; n: number }>();
  for (const p of prev) {
    if (p.bandId) continue;
    const to = classMap.get(p.groupId);
    if (!to) continue;
    const k = cellKey(to, p.subjectId);
    const seen = candidates.get(k);
    candidates.set(k, { p, n: (seen?.n ?? 0) + 1 });
  }
  const out: Suggestion[] = [];
  for (const [k, { p, n }] of candidates) {
    const cell = cells.get(k);
    if (!cell || !cell.editable || cell.assignments.length > 0 || n > 1 || p.teacherIds.length > 1) continue;
    const t = p.teacherIds[0] ?? null;
    const teacherId = t && opts.active.has(t) ? t : null;
    const who = t ? (opts.teacherCode.get(t) ?? t) : "offen";
    out.push({
      groupId: cell.groupId,
      subjectId: cell.subjectId,
      teacherId,
      hours: cell.soll ?? p.hours,
      from: `${opts.groupName.get(p.groupId) ?? p.groupId}: ${who}${t && !teacherId ? " (nicht mehr aktiv)" : ""}`,
    });
  }
  return out;
}

/**
 * Rein (F-10-7, Übergänge vor SP3-LA – R13): Klassen-Zuordnung alt → neu über die Namensregel. `promoted(name, level)` liefert den
 * Vorschlag des Schuljahreswechsels; zugeordnet wird nur, wenn genau eine neue Klasse so heißt und genau eine alte Klasse auf sie zeigt.
 */
export function reconstructClassMap(
  oldClasses: readonly { id: string; name: string; gradeLevel: number | null }[],
  newClasses: readonly { id: string; name: string }[],
  promoted: (name: string, gradeLevel: number) => string | null,
): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const c of newClasses) {
    const k = c.name.trim().toLocaleLowerCase("de");
    byName.set(k, [...(byName.get(k) ?? []), c.id]);
  }
  const hits = new Map<string, string[]>();
  for (const o of oldClasses) {
    if (o.gradeLevel === null) continue;
    const name = promoted(o.name, o.gradeLevel);
    const target = name ? byName.get(name.trim().toLocaleLowerCase("de")) : undefined;
    if (target?.length !== 1) continue;
    hits.set(target[0]!, [...(hits.get(target[0]!) ?? []), o.id]);
  }
  const out = new Map<string, string>();
  for (const [to, from] of hits) if (from.length === 1) out.set(from[0]!, to);
  return out;
}

/** Rein: aus einer gespeicherten Zuordnung nur die eindeutigen (1:1) Paare – zusammengelegte Klassen (10a + 10b → EF) folgen nicht. */
export function oneToOne(map: Readonly<Record<string, string>>): Map<string, string> {
  const count = new Map<string, number>();
  for (const to of Object.values(map)) count.set(to, (count.get(to) ?? 0) + 1);
  return new Map(Object.entries(map).filter(([, to]) => count.get(to) === 1));
}
