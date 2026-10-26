// Stammdaten: Jahrgangsstufen, Fächer, Zeitraster, Stundentafel (Räume und Schuljahre in rooms.ts/school-years.ts).
import { asc, count, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import {
  ROOM_KINDS,
  bookings,
  classbookEntries,
  curriculumHours,
  exams,
  gradeLevels,
  groups,
  notenbuchBooks,
  periods,
  rooms,
  subjects,
  timetableAssignments,
  timetableLessons,
  timetableStaffChanges,
  type RoomKind,
} from "@/core/db/schema";
import { gradeTemplate, levelTemplate, terms, type SchoolProfile } from "@/core/school/catalog";
import { SUBJECT_TEMPLATE, TIME_GRIDS, stundentafelTemplate } from "@/core/school/templates";
import { readSchoolSettings } from "@/core/settings";
import { ValidationError } from "./users";

export type GradeLevel = typeof gradeLevels.$inferSelect;

export async function listGradeLevels(db: Db): Promise<GradeLevel[]> {
  return db.select().from(gradeLevels).orderBy(asc(gradeLevels.level));
}

/** Legt die Jahrgänge aus dem Schulprofil an, falls noch keine da sind (neue Instanz, Seed, Update). */
export async function ensureGradeLevels(db: Db, profile?: SchoolProfile): Promise<void> {
  const [any] = await db.select({ level: gradeLevels.level }).from(gradeLevels).limit(1);
  if (any) return;
  const p = profile ?? (await readSchoolSettings(db)).profile;
  await db.insert(gradeLevels).values(gradeTemplate(p).map((g) => ({ level: g.level, code: g.code, name: g.name, stage: g.stage }))).onConflictDoNothing();
}

/**
 * Übernimmt die Vorlage des aktuellen Schulprofils: legt fehlende Jahrgänge an, aktualisiert Kürzel/Namen/Stufe
 * und entfernt Jahrgänge, die nicht mehr vorkommen – außer sie werden noch von Gruppen benutzt.
 */
export async function applyGradeTemplate(db: Db, actorId: string): Promise<{ kept: number[] }> {
  const { profile } = await readSchoolSettings(db);
  const tpl = gradeTemplate(profile);
  const used = new Set(
    (await db.selectDistinct({ g: groups.gradeLevel }).from(groups).where(isNotNull(groups.gradeLevel))).map((r) => r.g!),
  );
  const existing = await listGradeLevels(db);
  const keep = existing.filter((e) => !tpl.some((t) => t.level === e.level) && used.has(e.level)).map((e) => e.level);
  const drop = existing.filter((e) => !tpl.some((t) => t.level === e.level) && !used.has(e.level)).map((e) => e.level);
  if (drop.length) await db.delete(gradeLevels).where(inArray(gradeLevels.level, drop));
  // Kürzel sind eindeutig: erst umbenennen, dann setzen (vermeidet Konflikte beim Tausch)
  for (const t of tpl) await db.update(gradeLevels).set({ code: `~${t.level}` }).where(eq(gradeLevels.level, t.level));
  for (const t of tpl) {
    await db
      .insert(gradeLevels)
      .values({ level: t.level, code: t.code, name: t.name, stage: t.stage })
      .onConflictDoUpdate({ target: gradeLevels.level, set: { code: t.code, name: t.name, stage: t.stage } });
  }
  await audit(db, actorId, "verwaltung.stammdaten.grades_template", null, { form: profile.form, state: profile.state, kept: keep });
  return { kept: keep };
}

export interface GradeLevelInput {
  level: number;
  code: string;
  name: string;
  stage: "sek1" | "oberstufe";
}

/** Speichert alle Jahrgänge auf einmal (Kürzel eindeutig, Namen Pflicht). */
export async function saveGradeLevels(db: Db, actorId: string, rows: GradeLevelInput[]): Promise<void> {
  const fe: Record<string, string> = {};
  const codes = new Set<string>();
  for (const r of rows) {
    const code = r.code.trim();
    if (!code || code.length > 8) fe[`code-${r.level}`] = "Kürzel (1–8 Zeichen)";
    else if (codes.has(code.toLowerCase())) fe[`code-${r.level}`] = "Kürzel doppelt";
    codes.add(code.toLowerCase());
    if (!r.name.trim()) fe[`name-${r.level}`] = "Name angeben";
    if (r.stage !== "sek1" && r.stage !== "oberstufe") fe[`stage-${r.level}`] = "Stufe wählen";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  for (const r of rows) await db.update(gradeLevels).set({ code: `~${r.level}` }).where(eq(gradeLevels.level, r.level));
  for (const r of rows) await db.update(gradeLevels).set({ code: r.code.trim(), name: r.name.trim(), stage: r.stage }).where(eq(gradeLevels.level, r.level));
  await audit(db, actorId, "verwaltung.stammdaten.grades", null, { count: rows.length });
}

/** Anzeige eines Jahrgangs (Kürzel), z. B. für Gruppenlisten */
export function gradeLabel(levels: readonly GradeLevel[], level: number | null): string | null {
  if (level === null) return null;
  return levels.find((l) => l.level === level)?.code ?? String(level);
}

/** Auswahl für Gruppenformulare: Jahrgänge und die Niveaus des Schulprofils */
export async function groupFormOptions(db: Db): Promise<{ grades: GradeLevel[]; levels: string[]; rooms: { id: string; name: string }[] }> {
  const [grades, settings, roomList] = await Promise.all([
    listGradeLevels(db),
    readSchoolSettings(db),
    db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.active, true)).orderBy(asc(rooms.id)),
  ]);
  const t = levelTemplate(settings.profile);
  return { grades, levels: [...t.sek1, ...t.oberstufe], rooms: roomList };
}

/** Bezeichnung der Gruppenleitung je Art und Stufe: Klassen-/Stufenleitung, Kursleitung, AG-Leitung … */
export function leaderLabel(kind: string, stage: "sek1" | "oberstufe" | null): string {
  if (kind === "klasse") return terms(stage ?? "sek1").leader;
  if (kind === "kurs" || kind === "wahlpflicht" || kind === "foerderkurs") return "Kursleitung";
  if (kind === "ag") return "AG-Leitung";
  if (kind === "fachschaft") return "Fachschaftsleitung";
  if (kind === "gremium") return "Vorsitz";
  return "Leitung";
}

// ---------------------------------------------------------------- Fächer

export type Subject = typeof subjects.$inferSelect;

export async function listSubjects(db: Db): Promise<Subject[]> {
  return db.select().from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.name));
}

/**
 * Wie oft ein Fach in Stundenplan, Unterrichtsverteilung, Klassenbuch, Klausurplan und Notenbuch vorkommt (dann nicht löschbar;
 * G5A-C12: Notenbücher in der Löschfrist verweisen weiter auf das Fach).
 */
export async function subjectUsage(db: Db): Promise<Map<string, number>> {
  const parts = await Promise.all([
    db.select({ id: timetableLessons.subjectId, n: count() }).from(timetableLessons).groupBy(timetableLessons.subjectId),
    db.select({ id: timetableAssignments.subjectId, n: count() }).from(timetableAssignments).groupBy(timetableAssignments.subjectId),
    db.select({ id: classbookEntries.subjectId, n: count() }).from(classbookEntries).groupBy(classbookEntries.subjectId),
    db.select({ id: exams.subjectId, n: count() }).from(exams).groupBy(exams.subjectId),
    db.select({ id: notenbuchBooks.subjectId, n: count() }).from(notenbuchBooks).groupBy(notenbuchBooks.subjectId),
  ]);
  const out = new Map<string, number>();
  for (const r of parts.flat()) out.set(r.id, (out.get(r.id) ?? 0) + r.n);
  return out;
}

export interface SubjectInput {
  /** bisheriges Kürzel (leer bei neuem Fach) */
  id?: string;
  code: string;
  name: string;
  color: string;
  roomKind: string;
}

const CODE_RE = /^[\p{L}\p{N}]{1,6}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function checkSubject(r: SubjectInput, key: string, fe: Record<string, string>) {
  if (!CODE_RE.test(r.code.trim())) fe[`code-${key}`] = "Kürzel: 1–6 Buchstaben oder Ziffern";
  if (!r.name.trim()) fe[`name-${key}`] = "Name angeben";
  if (!COLOR_RE.test(r.color)) fe[`color-${key}`] = "Farbe als #RRGGBB";
  if (r.roomKind && !(ROOM_KINDS as readonly string[]).includes(r.roomKind)) fe[`roomKind-${key}`] = "Unbekannte Raumart";
}

/**
 * Speichert alle Fächer auf einmal; ein geändertes Kürzel wird in Stundenplan, Klassenbuch, Klausurplan und
 * Gruppen mitgezogen (ON UPDATE CASCADE). Optional kommt ein neues Fach hinten dazu. R2-P9: die Fächer der Zugänge in der
 * Fachbedarf-Prognose (`timetable_staff_changes.subject_ids`, Array ohne Fremdschlüssel) zieht die Transaktion von Hand mit.
 */
export async function saveSubjects(db: Db, actorId: string, rows: SubjectInput[], added?: SubjectInput): Promise<void> {
  const fe: Record<string, string> = {};
  const seen = new Set<string>();
  const all = [...rows.map((r) => ({ r, key: r.id ?? "" })), ...(added ? [{ r: added, key: "new" }] : [])];
  for (const { r, key } of all) {
    checkSubject(r, key, fe);
    const c = r.code.trim().toLowerCase();
    if (c && seen.has(c)) fe[`code-${key}`] = "Kürzel doppelt";
    seen.add(c);
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const renamed = rows.filter((r) => r.code.trim() !== r.id);
  await db.transaction(async (tx) => {
    // erst auf Platzhalter, dann aufs Ziel – so gehen auch Tausche (M ↔ MA)
    for (const r of renamed) {
      await tx.update(subjects).set({ id: `~${r.id}` }).where(eq(subjects.id, r.id!));
      await renameInStaffChanges(tx, r.id!, `~${r.id}`);
    }
    for (const r of renamed) {
      await tx.update(subjects).set({ id: r.code.trim() }).where(eq(subjects.id, `~${r.id}`));
      await renameInStaffChanges(tx, `~${r.id}`, r.code.trim());
    }
    for (const r of rows) {
      await tx
        .update(subjects)
        .set({ name: r.name.trim(), color: r.color.toUpperCase(), roomKind: (r.roomKind || null) as RoomKind | null })
        .where(eq(subjects.id, r.code.trim()));
    }
    if (added) {
      const [top] = await tx.select({ last: max(subjects.sortOrder) }).from(subjects);
      await tx.insert(subjects).values({
        id: added.code.trim(),
        name: added.name.trim(),
        color: added.color.toUpperCase(),
        roomKind: (added.roomKind || null) as RoomKind | null,
        sortOrder: (top?.last ?? -1) + 1,
      });
    }
  });
  await audit(db, actorId, "verwaltung.stammdaten.subjects", null, {
    count: rows.length,
    renamed: renamed.map((r) => `${r.id}→${r.code.trim()}`),
    added: added?.code.trim() ?? null,
  });
}

/** R2-P9: Fach-Kürzel in den Zugängen der Fachbedarf-Prognose ersetzen (`subject_ids` hat als Array keinen Fremdschlüssel). */
async function renameInStaffChanges(tx: Pick<Db, "update">, from: string, to: string): Promise<void> {
  await tx
    .update(timetableStaffChanges)
    .set({ subjectIds: sql`array_replace(${timetableStaffChanges.subjectIds}, ${from}, ${to})` })
    .where(sql`${from} = any(${timetableStaffChanges.subjectIds})`);
}

/** Verschiebt ein Fach in der Reihenfolge (Listen, Auswahlfelder, später Stundentafel). */
export async function moveSubject(db: Db, actorId: string, id: string, dir: -1 | 1): Promise<void> {
  const list = await listSubjects(db);
  const i = list.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  await db.transaction(async (tx) => {
    for (const [n, s] of list.entries()) if (s.sortOrder !== n) await tx.update(subjects).set({ sortOrder: n }).where(eq(subjects.id, s.id));
  });
  await audit(db, actorId, "verwaltung.stammdaten.subject_move", null, { id, dir });
}

export async function deleteSubject(db: Db, actorId: string, id: string): Promise<void> {
  const used = (await subjectUsage(db)).get(id) ?? 0;
  if (used) throw new ValidationError({ [`code-${id}`]: `${id} wird noch ${used}× in Stundenplan, Unterrichtsverteilung, Klassenbuch, Klausurplan oder Notenbuch verwendet` });
  await db.transaction(async (tx) => {
    // R2-P9: Zugänge der Prognose ohne das gelöschte Fach (Array ohne Fremdschlüssel)
    await tx
      .update(timetableStaffChanges)
      .set({ subjectIds: sql`array_remove(${timetableStaffChanges.subjectIds}, ${id})` })
      .where(sql`${id} = any(${timetableStaffChanges.subjectIds})`);
    await tx.delete(subjects).where(eq(subjects.id, id));
  });
  await audit(db, actorId, "verwaltung.stammdaten.subject_delete", null, { id });
}

// ---------------------------------------------------------------- Zeitraster

export type Period = typeof periods.$inferSelect;

export async function listPeriods(db: Db): Promise<Period[]> {
  return db.select().from(periods).orderBy(asc(periods.nr));
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Prüft das Zeitraster: Format HH:MM, Beginn vor Ende, keine Überschneidung mit der Stunde davor. */
export function checkPeriods(rows: readonly Period[]): Record<string, string> {
  const fe: Record<string, string> = {};
  let prevEnd = -1;
  for (const r of rows) {
    const okS = TIME_RE.test(r.startsAt);
    const okE = TIME_RE.test(r.endsAt);
    if (!okS) fe[`start-${r.nr}`] = "Uhrzeit als HH:MM";
    if (!okE) fe[`end-${r.nr}`] = "Uhrzeit als HH:MM";
    if (!okS || !okE) continue;
    const s = minutes(r.startsAt);
    const e = minutes(r.endsAt);
    if (e <= s) fe[`end-${r.nr}`] = "Ende muss nach dem Beginn liegen";
    else if (s < prevEnd) fe[`start-${r.nr}`] = `Beginnt vor dem Ende der ${r.nr - 1}. Stunde`;
    prevEnd = e;
  }
  return fe;
}

/** Pausen vor einer Stunde in Minuten (Schlüssel = Stunde nach der Pause) */
export function breaks(rows: readonly Period[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < rows.length; i++) {
    const gap = minutes(rows[i]!.startsAt) - minutes(rows[i - 1]!.endsAt);
    if (gap > 0) out.set(rows[i]!.nr, gap);
  }
  return out;
}

export async function savePeriods(db: Db, actorId: string, rows: Period[]): Promise<void> {
  const fe = checkPeriods(rows);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db.transaction(async (tx) => {
    for (const r of rows) await tx.update(periods).set({ startsAt: r.startsAt, endsAt: r.endsAt }).where(eq(periods.nr, r.nr));
  });
  await audit(db, actorId, "verwaltung.stammdaten.periods", null, { count: rows.length });
}

/** Hängt eine Stunde an: 5 Minuten nach der letzten, 45 Minuten lang. */
export async function addPeriod(db: Db, actorId: string): Promise<number> {
  const list = await listPeriods(db);
  const last = list.at(-1);
  const start = last ? Math.min(minutes(last.endsAt) + 5, 23 * 60 + 14) : 8 * 60;
  const nr = (last?.nr ?? 0) + 1;
  await db.insert(periods).values({ nr, startsAt: clock(start), endsAt: clock(start + 45) });
  await audit(db, actorId, "verwaltung.stammdaten.period_add", null, { nr });
  return nr;
}

/** Entfernt die letzte Stunde, wenn sie nirgends verplant ist. */
/** Wie oft Stunde `nr` in Stundenplan, Buchungen, Klassenbuch und Klausuren vorkommt */
async function periodUsage(db: Db, nr: number): Promise<number> {
  const counts = await Promise.all([
    db.select({ n: count() }).from(timetableLessons).where(eq(timetableLessons.periodNr, nr)),
    db.select({ n: count() }).from(bookings).where(eq(bookings.periodNr, nr)),
    db.select({ n: count() }).from(classbookEntries).where(eq(classbookEntries.periodNr, nr)),
    db.select({ n: count() }).from(exams).where(gte(exams.periodTo, nr)),
  ]);
  return counts.reduce((sum, [r]) => sum + (r?.n ?? 0), 0);
}

const usedMessage = (nr: number, used: number) => `Die ${nr}. Stunde ist noch ${used}× verplant (Stundenplan, Buchungen, Klassenbuch, Klausuren)`;

/** Entfernt die letzte Stunde, wenn sie nirgends verplant ist. */
export async function removeLastPeriod(db: Db, actorId: string): Promise<void> {
  const last = (await listPeriods(db)).at(-1);
  if (!last) return;
  const nr = last.nr;
  const used = await periodUsage(db, nr);
  if (used) throw new ValidationError({ [`start-${nr}`]: usedMessage(nr, used) });
  await db.delete(periods).where(eq(periods.nr, nr));
  await audit(db, actorId, "verwaltung.stammdaten.period_remove", null, { nr });
}

/**
 * Übernimmt ein Zeitraster aus den Vorlagen: setzt die Zeiten, hängt fehlende Stunden an und entfernt
 * überzählige – aber nur, wenn diese nirgends verplant sind (sonst bleibt alles unverändert).
 */
export async function applyTimeGrid(db: Db, actorId: string, id: string): Promise<void> {
  const grid = TIME_GRIDS.find((g) => g.id === id);
  if (!grid) throw new ValidationError({ grid: "Vorlage wählen" });
  const extra = (await listPeriods(db)).filter((p) => p.nr > grid.periods.length);
  for (const p of extra) {
    const used = await periodUsage(db, p.nr);
    if (used) throw new ValidationError({ grid: `${usedMessage(p.nr, used)} – die Vorlage hat nur ${grid.periods.length} Stunden` });
  }
  await db.transaction(async (tx) => {
    if (extra.length) await tx.delete(periods).where(inArray(periods.nr, extra.map((p) => p.nr)));
    for (const p of grid.periods) await tx.insert(periods).values(p).onConflictDoUpdate({ target: periods.nr, set: { startsAt: p.startsAt, endsAt: p.endsAt } });
  });
  await audit(db, actorId, "verwaltung.stammdaten.time_grid", null, { grid: id });
}

// ---------------------------------------------------------------- Stundentafel

export type CurriculumCell = typeof curriculumHours.$inferSelect;

export async function listCurriculum(db: Db): Promise<CurriculumCell[]> {
  return db.select().from(curriculumHours);
}

/** Speichert die ganze Matrix; 0 oder leer löscht die Zelle. */
export async function saveCurriculum(db: Db, actorId: string, cells: { gradeLevel: number; subjectId: string; hours: string }[]): Promise<void> {
  const fe: Record<string, string> = {};
  const rows: CurriculumCell[] = [];
  for (const c of cells) {
    const raw = c.hours.trim();
    if (raw === "" || raw === "0") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 12) fe[`h-${c.gradeLevel}-${c.subjectId}`] = "0–12 Stunden";
    else rows.push({ gradeLevel: c.gradeLevel, subjectId: c.subjectId, hours: n });
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const grades = [...new Set(cells.map((c) => c.gradeLevel))];
  await db.transaction(async (tx) => {
    if (grades.length) await tx.delete(curriculumHours).where(inArray(curriculumHours.gradeLevel, grades));
    if (rows.length) await tx.insert(curriculumHours).values(rows);
  });
  await audit(db, actorId, "verwaltung.stammdaten.curriculum", null, { cells: rows.length });
}

/**
 * Übernimmt die Stundentafel der Schulform für alle Sek-I-Jahrgänge der Schule. Fehlende Fächer werden aus dem
 * Fächerkatalog angelegt; die Stunden dieser Jahrgänge werden ersetzt.
 */
export async function applyCurriculumTemplate(db: Db, actorId: string | null): Promise<{ addedSubjects: string[] }> {
  const [{ profile }, grades, existing] = await Promise.all([readSchoolSettings(db), listGradeLevels(db), listSubjects(db)]);
  const sek1 = grades.filter((g) => g.stage === "sek1").map((g) => g.level);
  const tpl = stundentafelTemplate(profile.form, sek1);
  const needed = new Set(Object.values(tpl).flatMap((row) => Object.keys(row)));
  const have = new Set(existing.map((s) => s.id));
  const missing = SUBJECT_TEMPLATE.filter((s) => needed.has(s.id) && !have.has(s.id));
  const nextSort = Math.max(-1, ...existing.map((s) => s.sortOrder)) + 1;
  await db.transaction(async (tx) => {
    if (missing.length) await tx.insert(subjects).values(missing.map((s, i) => ({ id: s.id, name: s.name, color: s.color, roomKind: s.roomKind ?? null, sortOrder: nextSort + i })));
    const grs = Object.keys(tpl).map(Number);
    if (grs.length) await tx.delete(curriculumHours).where(inArray(curriculumHours.gradeLevel, grs));
    const rows = Object.entries(tpl).flatMap(([g, row]) => Object.entries(row).map(([subjectId, hours]) => ({ gradeLevel: Number(g), subjectId, hours })));
    if (rows.length) await tx.insert(curriculumHours).values(rows);
  });
  // ohne handelnde Person (Demo-Seed, Ersteinrichtung) kein Protokolleintrag
  if (actorId) await audit(db, actorId, "verwaltung.stammdaten.curriculum_template", null, { form: profile.form, added: missing.map((s) => s.id) });
  return { addedSubjects: missing.map((s) => s.id) };
}
