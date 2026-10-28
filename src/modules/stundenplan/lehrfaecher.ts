// SP2-12: Lehrfächer (Fakultas) je Lehrkraft – Pflege, CSV-Import und Lehrervorschläge passend zum Fach.
// Vorschläge bei der Zuweisung: nur Lehrkräfte mit dem Fach, sortiert nach Restdeputat (Soll − Lehraufträge), dann Name; alle anderen nur
// über „alle anzeigen“ mit Warnhinweis. Speichern mit einer fachfremden Lehrkraft bleibt erlaubt, braucht aber eine Bestätigung.
// Ohne gepflegte Lehrfächer gibt es einen Hinweis, keine Sperre.
// R2-P7: Der Fachfilter greift nur, wenn das Stundenplanmodul an ist UND für die aktiven Lehrkräfte überhaupt Lehrfächer gepflegt sind
// (`subjectFilterOn`); sonst sind alle Lehrkräfte normal wählbar, ohne Warnhinweis und ohne Bestätigung.
// R2-P2: Vorgeschlagen werden nur aktive Lehrkräfte; gespeichert wird keine nicht aktive (gesperrt/ausgeschieden).
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { detectSeparator, splitCsvLine } from "@/core/csv";
import { moduleStates, subjects, timetableTeacherSubjects, users } from "@/core/db/schema";
import { isEnabled } from "@/core/modules/registry";
import { readSchoolSettings } from "@/core/settings";
import { ValidationError } from "@/modules/verwaltung/users";
import { defaultObligation, deputyAccounts } from "./deputate";
import stundenplanManifest from "./manifest";
import { offSubjectText, subjectMismatch, type PickTeacher } from "./lehrfaecher-auswahl";
import { distribution, planningYear } from "./verteilung";

export * from "./lehrfaecher-auswahl";

/** Lehrfächer je Lehrkraft (Kurzzeichen der Fächer, sortiert); Lehrkräfte ohne Lehrfach fehlen in der Map. */
export async function teacherSubjectMap(db: Db): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ teacherId: timetableTeacherSubjects.teacherId, subjectId: timetableTeacherSubjects.subjectId })
    .from(timetableTeacherSubjects)
    .innerJoin(subjects, eq(subjects.id, timetableTeacherSubjects.subjectId))
    .orderBy(asc(timetableTeacherSubjects.teacherId), asc(subjects.sortOrder), asc(subjects.id));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.teacherId, [...(out.get(r.teacherId) ?? []), r.subjectId]);
  return out;
}

/** Lehrfächer einer Lehrkraft ersetzen (leer = keine gepflegt). */
export async function setTeacherSubjects(db: Db, actorId: string, teacherId: string, subjectIds: string[]): Promise<void> {
  const wanted = [...new Set(subjectIds.filter(Boolean))];
  const [[t], known] = await Promise.all([
    db.select({ role: users.role }).from(users).where(eq(users.id, teacherId)),
    wanted.length ? db.select({ id: subjects.id }).from(subjects).where(inArray(subjects.id, wanted)) : Promise.resolve([]),
  ]);
  const fe: Record<string, string> = {};
  if (t?.role !== "lehrkraft") fe.teacherId = "Lehrkraft gibt es nicht";
  if (known.length !== wanted.length) fe.subjectIds = "Fach gibt es nicht (mehr)";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db.transaction(async (tx) => {
    await tx.delete(timetableTeacherSubjects).where(eq(timetableTeacherSubjects.teacherId, teacherId));
    if (wanted.length) await tx.insert(timetableTeacherSubjects).values(wanted.map((subjectId) => ({ teacherId, subjectId })));
  });
  await audit(db, actorId, "stundenplan.teacher_subjects", teacherId, { subjects: wanted });
}

/** R2-P7: Ist das Stundenplanmodul an? (Lehrfächer und Deputate gehören dazu; ohne Modul kein Fachfilter.) */
export async function timetableModuleOn(db: Db): Promise<boolean> {
  const rows = await db.select().from(moduleStates).where(eq(moduleStates.moduleId, stundenplanManifest.id));
  return isEnabled(stundenplanManifest, new Map(rows.map((r) => [r.moduleId, r.enabled])));
}

/** Kennungen der aktiven Lehrkräfte (R2-P2: nur sie werden vorgeschlagen und gespeichert). */
export async function activeTeacherIds(db: Db): Promise<Set<string>> {
  const rows = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")));
  return new Set(rows.map((r) => r.id));
}

/**
 * Prüfung für Formulare: fachfremde Lehrkräfte nur mit Bestätigung (`confirmed`) – sonst ein Feldfehler mit dem Warnhinweis. Lehrkräfte
 * ohne gepflegte Lehrfächer gehen ohne Bestätigung durch (Hinweis im Formular). Gibt die fachfremden Kürzel zurück (fürs Protokoll).
 * R2-P2: nicht aktive Lehrkräfte werden immer abgelehnt. R2-P7: ohne Stundenplanmodul keine Fachprüfung.
 */
export async function checkSubjectFit(db: Db, subjectId: string, teacherIds: string[], confirmed: boolean, field = "teacherIds"): Promise<string[]> {
  const ids = teacherIds.filter(Boolean);
  if (!ids.length) return [];
  const people = await db.select({ id: users.id, code: users.shortCode, name: users.name, status: users.status }).from(users).where(inArray(users.id, ids));
  const inactive = people.filter((u) => u.status !== "active");
  if (inactive.length)
    throw new ValidationError({
      [field]: `${inactive.map((u) => u.code ?? u.name).join(", ")} ${inactive.length === 1 ? "ist" : "sind"} nicht mehr aktiv – andere Lehrkraft wählen`,
    });
  if (!subjectId || !(await timetableModuleOn(db))) return [];
  const rows = await db.select().from(timetableTeacherSubjects).where(inArray(timetableTeacherSubjects.teacherId, ids));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.teacherId, [...(map.get(r.teacherId) ?? []), r.subjectId]);
  const { off } = subjectMismatch(map, subjectId, ids);
  if (!off.length) return [];
  const [s] = await db.select({ name: subjects.name }).from(subjects).where(eq(subjects.id, subjectId));
  const codes = off.map((id) => {
    const u = people.find((n) => n.id === id);
    return u?.code ?? u?.name ?? id;
  });
  if (!confirmed) throw new ValidationError({ [field]: `${offSubjectText(codes, s?.name ?? subjectId)} – zum Speichern „Trotzdem zuweisen“ ankreuzen` });
  return codes;
}

// ---------------------------------------------------------------- CSV-Import (Muster wie SP2-06)

export const MAX_TEACHER_SUBJECT_CSV_BYTES = 256 * 1024;
export const TEACHER_SUBJECT_CSV_HEADER = ["Lehrkraft", "Lehrfächer"] as const;

const key = (s: string) => s.trim().toLocaleLowerCase("de");
const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß]/g, "");

export interface TeacherSubjectRow {
  line: number;
  teacher: string;
  subjects: string[];
}

/** Zerlegt die Datei: „Lehrkraft;Lehrfächer“, Fächer mit Leerzeichen, „/“, „+“ oder Komma getrennt; Kopfzeile optional. */
export function parseTeacherSubjectCsv(text: string): { rows: TeacherSubjectRow[]; errors: string[] } {
  const sep = detectSeparator(text);
  const rows: TeacherSubjectRow[] = [];
  const errors: string[] = [];
  let first = true;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const cells = splitCsvLine(raw, sep).map((c) => c.trim());
    if (cells.every((c) => !c)) continue;
    if (first) {
      first = false;
      if (["lehrkraft", "kürzel", "kuerzel", "lehrer"].includes(norm(cells[0] ?? ""))) continue;
    }
    if (rows.length >= 2000) {
      errors.push("höchstens 2000 Zeilen je Datei");
      break;
    }
    // Fächer dürfen auch auf mehrere Spalten verteilt sein („PIN;M;PH“)
    const subjectCells = cells.slice(1).join(" ");
    rows.push({ line: i + 1, teacher: cells[0] ?? "", subjects: subjectCells.split(/[\s,/+|]+/).filter(Boolean) });
  }
  if (!rows.length && !errors.length) errors.push("Keine Lehrkräfte in der Datei");
  return { rows, errors };
}

export type TeacherSubjectStatus = "aendern" | "gleich" | "fehler";

export interface TeacherSubjectRowView {
  line: number;
  teacher: string;
  subjects: string;
  status: TeacherSubjectStatus;
  notes: string[];
}

export interface TeacherSubjectPreview {
  rows: TeacherSubjectRowView[];
  fileErrors: string[];
  counts: Record<TeacherSubjectStatus, number>;
  ok: boolean;
}

export interface TeacherSubjectPlan {
  preview: TeacherSubjectPreview;
  ops: { teacherId: string; subjectIds: string[] }[];
}

/** Prüft die Datei gegen Lehrkräfte (Kürzel/Name) und Fächer (Kurzzeichen/Name). Je Zeile werden die Lehrfächer ersetzt. */
export async function planTeacherSubjectImport(db: Db, text: string): Promise<TeacherSubjectPlan> {
  const { rows, errors: fileErrors } = parseTeacherSubjectCsv(text);
  const [teacherRows, subjectRows, current] = await Promise.all([
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(and(eq(users.role, "lehrkraft"), eq(users.status, "active"))),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
    teacherSubjectMap(db),
  ]);
  const lookup = (entries: [string, string][]) => {
    const m = new Map<string, string>();
    for (const [k, v] of entries) if (k) m.set(k, m.has(k) && m.get(k) !== v ? "mehrdeutig" : v);
    return m;
  };
  const teacherBy = lookup([...teacherRows.map((t): [string, string] => [key(t.code ?? ""), t.id]), ...teacherRows.map((t): [string, string] => [key(t.name), t.id])]);
  const subjectBy = lookup([...subjectRows.map((s): [string, string] => [key(s.id), s.id]), ...subjectRows.map((s): [string, string] => [key(s.name), s.id])]);
  const seen = new Map<string, number>();
  const ops: TeacherSubjectPlan["ops"] = [];
  const views: TeacherSubjectRowView[] = rows.map((r) => {
    const notes: string[] = [];
    const view: TeacherSubjectRowView = { line: r.line, teacher: r.teacher, subjects: r.subjects.join(" "), status: "fehler", notes };
    const teacherId = r.teacher ? teacherBy.get(key(r.teacher)) : undefined;
    if (!r.teacher) notes.push("Lehrkraft fehlt");
    else if (teacherId === "mehrdeutig") notes.push(`Lehrkraft „${r.teacher}“ ist mehrdeutig`);
    else if (!teacherId) notes.push(`Lehrkraft „${r.teacher}“ gibt es nicht`);
    const subjectIds: string[] = [];
    for (const raw of r.subjects) {
      const id = subjectBy.get(key(raw));
      if (id === "mehrdeutig") notes.push(`Fach „${raw}“ ist mehrdeutig`);
      else if (!id) notes.push(`Fach „${raw}“ gibt es nicht`);
      else if (!subjectIds.includes(id)) subjectIds.push(id);
    }
    if (notes.length || !teacherId || teacherId === "mehrdeutig") return view;
    if (seen.has(teacherId)) {
      notes.push(`steht schon in Zeile ${seen.get(teacherId)}`);
      return view;
    }
    seen.set(teacherId, r.line);
    const before = current.get(teacherId) ?? [];
    const added = subjectIds.filter((s) => !before.includes(s));
    const removed = before.filter((s) => !subjectIds.includes(s));
    if (!added.length && !removed.length) {
      view.status = "gleich";
      return view;
    }
    if (added.length) notes.push(`neu: ${added.join(", ")}`);
    if (removed.length) notes.push(`entfällt: ${removed.join(", ")}`);
    if (!subjectIds.length) notes.push("keine Lehrfächer mehr");
    view.status = "aendern";
    ops.push({ teacherId, subjectIds });
    return view;
  });
  const counts: Record<TeacherSubjectStatus, number> = { aendern: 0, gleich: 0, fehler: 0 };
  for (const v of views) counts[v.status]++;
  return { preview: { rows: views, fileErrors, counts, ok: !fileErrors.length && counts.fehler === 0 && counts.aendern > 0 }, ops };
}

/** Übernimmt einen fehlerfreien Plan – ganz oder gar nicht. */
export async function executeTeacherSubjectImport(db: Db, actorId: string, plan: TeacherSubjectPlan): Promise<number> {
  if (!plan.preview.ok) throw new Error("Import hat Fehler – nichts übernommen");
  await db.transaction(async (tx) => {
    for (const op of plan.ops) {
      await tx.delete(timetableTeacherSubjects).where(eq(timetableTeacherSubjects.teacherId, op.teacherId));
      if (op.subjectIds.length) await tx.insert(timetableTeacherSubjects).values(op.subjectIds.map((subjectId) => ({ teacherId: op.teacherId, subjectId })));
    }
  });
  await audit(db, actorId, "stundenplan.teacher_subjects.csv_import", null, { teachers: plan.ops.length });
  return plan.ops.length;
}

// ---------------------------------------------------------------- Auswahlliste für Formulare

/** Rein: Auswahlliste aus den Deputatskonten (Soll, Lehraufträge) und den Lehrfächern. */
export function pickList(
  accounts: readonly { id: string; code: string | null; name: string; target: number; assigned: number }[],
  map: ReadonlyMap<string, readonly string[]>,
  /** R2-P2: aktive Lehrkräfte – andere werden als `inactive` markiert (fehlt = alle aktiv) */
  active?: ReadonlySet<string>,
): PickTeacher[] {
  return accounts.map((a) => ({
    id: a.id,
    code: a.code,
    name: a.name,
    subjectIds: [...(map.get(a.id) ?? [])],
    rest: Math.round((a.target - a.assigned) * 10) / 10,
    ...(active && !active.has(a.id) ? { inactive: true } : {}),
  }));
}

/**
 * Auswahlliste des Planungsjahres (Restdeputat am Stichtag) – für Formulare außerhalb der Unterrichtsverteilung. Nicht aktive Lehrkräfte
 * sind markiert (R2-P2). Ohne Stundenplanmodul (R2-P7) nur aktive Lehrkräfte ohne Lehrfächer und ohne Deputat – kein Fachfilter.
 * SP3-09a: `forYear` = anderes Planungsjahr (Pflege im Entwurf des Folgejahrs), sonst das laufende.
 */
export async function loadPickList(db: Db, todayYmd: string, forYear?: { id: string; startsOn: string; endsOn: string } | null): Promise<PickTeacher[]> {
  const [year, active, moduleOn] = await Promise.all([forYear ? Promise.resolve(forYear) : planningYear(db), activeTeacherIds(db), timetableModuleOn(db)]);
  if (!year || !moduleOn) {
    const rows = await db
      .select({ id: users.id, code: users.shortCode, name: users.name })
      .from(users)
      .where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")))
      .orderBy(asc(users.shortCode));
    const map = moduleOn ? await teacherSubjectMap(db) : new Map<string, string[]>();
    return rows.map((t) => ({ ...t, subjectIds: map.get(t.id) ?? [], rest: null }));
  }
  const [d, school, map] = await Promise.all([distribution(db, year, todayYmd), readSchoolSettings(db), teacherSubjectMap(db)]);
  return pickList(await deputyAccounts(db, year.id, d.teachers, defaultObligation(school.profile.form), d.refYmd), map, active);
}
