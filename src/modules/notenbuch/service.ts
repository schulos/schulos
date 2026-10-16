// Notenbuch (P5-11): Rechte und Sichtbarkeit – alles hier im Service, Seiten und Actions rufen nur diese Funktionen.
// Need-to-know (§ 120 Abs. 1 S. 2 SchulG NRW, Anlage 3 VO-DV I; PHASE5-NOTENBUCH.md §4, F5-05/F5-07/F5-13):
//   · `notenbuch.own`: Teilnoten nur für die Lehrkräfte des Buchs (`notenbuch_book_teachers`, alle gleichberechtigt). Anlegen nur
//     aus eigenen Lehraufträgen (Unterrichtsverteilung des laufenden Schuljahres) bzw. eigenem regulären Unterricht laut Stundenplan.
//     Vertretung hat keinen Zugriff – nur über eine Übertragung.
//   · `notenbuch.term_view` (z. B. Gruppe Schulleitung) und die Klassenleitung (automatisch, nur eigene Klasse): **nur**
//     Halbjahreswerte, jeder Abruf per `auditRead("lesen.notenbuch")`.
//   · `notenbuch.transfer`: Buch an eine andere Lehrkraft übertragen – sieht dabei nur Gruppe, Fach und Lehrkräfte, keine Noten.
//   · `notenbuch.export` (P5-13): Halbjahreswerte exportieren, nie Teilnoten.
//   · `notenbuch.unlock` (P5-13): abgeschlossenes Buch wieder öffnen (Schulleitung) – mit Begründung, protokolliert, ohne Noten.
//   · **Kein `view_all`, und das Admin-Recht greift nicht:** Rechte zählen nur, wenn sie ausdrücklich vergeben sind – weder die
//     Rolle `admin` noch ein Grant `*` öffnet das Notenbuch (`hasNotenbuchRight`).
//   · **2FA-Pflicht fürs Modul** (F5-07, vor SEC-01): ohne eingerichtete Zwei-Faktor-Anmeldung wirft jede Funktion
//     `NotenbuchTwoFactorError` (Seiten leiten zur Einrichtung um). Demo-Instanzen wie beim Kern ausgenommen (Q-5A-4).
//   · Fremde und unbekannte Bücher sind gleich: `null` bzw. `ForbiddenError`.
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lte, max, ne, or, sql } from "drizzle-orm";
import { audit, auditRead } from "@/core/audit";
import { notify } from "@/core/notifications";
import { csvBytes, CSV_ENCODINGS, type CsvEncoding } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { de } from "@/core/db/sort";
import {
  classbookAbsences,
  classbookEntries,
  exams,
  groupMembers,
  groups,
  notenbuchBooks,
  notenbuchBookTeachers,
  notenbuchColumns,
  notenbuchEntries,
  notenbuchTermGrades,
  schoolYears,
  subjects,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
  type NotenbuchBook,
  type NotenbuchColumn,
} from "@/core/db/schema";
import { accessBlocked, ForbiddenError, hasExplicitGrant, isDemoDb, type PermissionSet } from "@/core/permissions";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { readModuleSetting } from "@/core/modules/settings";
import { isFamilyRole } from "./rollen";
import { ROUNDING } from "./settings";
import {
  COLUMN_KINDS,
  COLUMN_WEIGHT_DEFAULT,
  COLUMN_WEIGHT_MAX,
  COMMENT_MAX,
  computeStudent,
  DEFAULT_WEIGHTS,
  keyError,
  MAX_POINTS_LIMIT,
  normalizeInput,
  parseEntry,
  SCALES,
  scaleValues,
  SPECIAL_VALUES,
  weightsError,
  type ColumnKind,
  type GradeKey,
  type RoundingMode,
  type Scale,
  type StudentResult,
  type Weights,
} from "./berechnung";

export const OWN = "notenbuch.own";
export const TERM_VIEW = "notenbuch.term_view";
export const TRANSFER = "notenbuch.transfer";
export const EXPORT = "notenbuch.export";
export const UNLOCK = "notenbuch.unlock";
/** GATE-5a (G5A-S01): Notenbuch-Teil der Auskunft nach Art. 15 (Teilnoten, Kommentare, Halbjahreswerte) erteilen */
export const AUSKUNFT = "notenbuch.auskunft";
export const NOTENBUCH_RIGHTS = [OWN, TERM_VIEW, TRANSFER, EXPORT, UNLOCK, AUSKUNFT] as const;

/** Gruppenarten mit Notenbuch (Unterricht; keine AG, Gremien, Fachschaften) */
export const BOOK_GROUP_KINDS = ["klasse", "kurs", "wahlpflicht", "foerderkurs"] as const;
export const COLUMN_TITLE_MAX = 80;

// ------------------------------------------------------------------ Rechte, 2FA

/** Admin-Konto im Sinne des Notenbuchs: Rolle `admin` oder Grant `*` (G5A-S03). */
export function isAdminAccount(perms: PermissionSet): boolean {
  return perms.role === "admin" || perms.granted.has("*");
}

/**
 * Hat die Person das Recht **ausdrücklich** (Rollen- oder Gruppen-Grant, auch `notenbuch.*`)? Anders als `hasPermission`
 * zählen die Rolle `admin` und der Grant `*` nicht – im Notenbuch gibt es keinen Admin-Override (F5-05). GATE-5a (G5A-S03):
 * Admin-Konten (Rolle `admin` oder `*`) zählen **nur** `notenbuch.transfer` (Q-5A-6) – auch nicht über eine Gruppe, die sie sich
 * selbst einrichten könnten.
 */
export function hasNotenbuchRight(perms: PermissionSet, permission: (typeof NOTENBUCH_RIGHTS)[number]): boolean {
  // GATE-5a (Schülerzugriff): Schüler:innen und Eltern nie – auch nicht über einen Rollen- oder Gruppen-Grant (rollen.ts)
  if (isFamilyRole(perms.role)) return false;
  if (isAdminAccount(perms) && permission !== TRANSFER) return false;
  return hasExplicitGrant(perms, permission);
}

/** Die Seiten des Notenbuchs verlangen eine eingerichtete Zwei-Faktor-Anmeldung (F5-07). */
export class NotenbuchTwoFactorError extends Error {
  constructor() {
    super("Für das Notenbuch ist die Zwei-Faktor-Anmeldung Pflicht.");
    this.name = "NotenbuchTwoFactorError";
  }
}

/** Ziel der Weiterleitung, wenn die Zwei-Faktor-Anmeldung fehlt. */
export const TWO_FACTOR_SETUP_HREF = "/zwei-faktor?grund=notenbuch";

/** Rein: Zwei-Faktor eingerichtet bzw. (Demo-Instanz) nicht verlangt? */
export function twoFactorSatisfied(enabled: boolean, demo: boolean): boolean {
  return enabled || demo;
}

/** Ist die Zwei-Faktor-Anmeldung für das Notenbuch erfüllt? Frisch aus der DB (nicht aus der Sitzung). */
export async function twoFactorReady(db: Db, perms: PermissionSet): Promise<boolean> {
  const [u] = await db.select({ enabled: users.twoFactorEnabled }).from(users).where(eq(users.id, perms.userId));
  return twoFactorSatisfied(Boolean(u?.enabled), await isDemoDb(db));
}

async function assertTwoFactor(db: Db, perms: PermissionSet): Promise<void> {
  if (!(await twoFactorReady(db, perms))) throw new NotenbuchTwoFactorError();
}

/** Aktive Klassen, die die Person als Lehrkraft leitet (Klassenleitung → Halbjahreswerte automatisch). */
export async function ledClasses(db: Db, perms: PermissionSet): Promise<string[]> {
  if (accessBlocked(perms) || perms.role !== "lehrkraft" || perms.leaderOf.size === 0) return [];
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(inArray(groups.id, [...perms.leaderOf]), eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
  return rows.map((r) => r.id);
}

export interface NotenbuchAccess {
  /** darf das Modul überhaupt nutzen (ein Recht oder Klassenleitung) */
  any: boolean;
  own: boolean;
  termView: boolean;
  transfer: boolean;
  export: boolean;
  unlock: boolean;
  /** eigene Klassen (Klassenleitung) */
  classes: string[];
  /** Zwei-Faktor-Anmeldung erfüllt */
  twoFactor: boolean;
}

/** Was die Person im Notenbuch darf – für Layout, Navigation und Seiten (ohne Noten zu lesen). */
export async function notenbuchAccess(db: Db, perms: PermissionSet): Promise<NotenbuchAccess> {
  const own = hasNotenbuchRight(perms, OWN);
  const termView = hasNotenbuchRight(perms, TERM_VIEW);
  const transfer = hasNotenbuchRight(perms, TRANSFER);
  const exp = hasNotenbuchRight(perms, EXPORT);
  const unlock = hasNotenbuchRight(perms, UNLOCK);
  const classes = await ledClasses(db, perms);
  const any = own || termView || transfer || exp || unlock || classes.length > 0;
  return { any, own, termView, transfer, export: exp, unlock, classes, twoFactor: any ? await twoFactorReady(db, perms) : false };
}

// ------------------------------------------------------------------ Lehraufträge → neues Buch

/** Laufendes Schuljahr am Tag `today` und das Halbjahr (2 ab `term2_starts_on`). */
export async function currentTerm(db: Db, today: string): Promise<{ schoolYearId: string; term: 1 | 2 } | null> {
  const [y] = await db
    .select({ id: schoolYears.id, term2: schoolYears.term2StartsOn })
    .from(schoolYears)
    .where(and(lte(schoolYears.startsOn, today), gte(schoolYears.endsOn, today)))
    .limit(1);
  if (!y) return null;
  return { schoolYearId: y.id, term: y.term2 && today >= y.term2 ? 2 : 1 };
}

/**
 * P5-15: Gehört das Schuljahr zur Vergangenheit – ist nach dem Schuljahreswechsel ein späteres Schuljahr das aktuelle? Dann sind
 * seine Bücher nur noch lesbar (nicht übernommen, gelöscht mit der Frist LK-SJ-1J). Ohne aktuelles Schuljahr: nein.
 */
export async function isPastYear(db: Db, schoolYearId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schoolYears.id, startsOn: schoolYears.startsOn, isCurrent: schoolYears.isCurrent })
    .from(schoolYears)
    .where(or(eq(schoolYears.id, schoolYearId), eq(schoolYears.isCurrent, true)));
  const cur = rows.find((r) => r.isCurrent);
  const own = rows.find((r) => r.id === schoolYearId);
  return Boolean(cur && own && cur.id !== own.id && own.startsOn < cur.startsOn);
}

export const PAST_YEAR_MESSAGE = "Das Notenbuch gehört zu einem vergangenen Schuljahr und ist nur noch lesbar";

export interface BookOption {
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  assignmentId: string | null;
  /** alle Lehrkräfte dieses Unterrichts (Teamteaching) – werden gleichberechtigt eingetragen */
  teacherIds: string[];
}

/**
 * Wofür die Person ein Notenbuch anlegen darf: eigene Lehraufträge des laufenden Schuljahres und eigener regulärer Unterricht
 * laut Stundenplan (gültig am Tag). Vertretungen zählen nicht (Q-5A-5).
 */
export async function bookOptions(db: Db, perms: PermissionSet, today: string): Promise<BookOption[]> {
  if (!hasNotenbuchRight(perms, OWN)) return [];
  const year = await currentTerm(db, today);
  if (!year) return [];
  const byKey = new Map<string, { groupId: string; subjectId: string; assignmentId: string | null; teacherIds: Set<string> }>();
  const add = (groupId: string, subjectId: string, teacherId: string, assignmentId: string | null) => {
    const key = `${groupId}|${subjectId}`;
    const o = byKey.get(key) ?? { groupId, subjectId, assignmentId: null, teacherIds: new Set<string>() };
    o.teacherIds.add(teacherId);
    o.assignmentId ??= assignmentId;
    byKey.set(key, o);
  };

  const mine = await db
    .select({ id: timetableAssignments.id })
    .from(timetableAssignmentTeachers)
    .innerJoin(timetableAssignments, eq(timetableAssignments.id, timetableAssignmentTeachers.assignmentId))
    .where(and(eq(timetableAssignmentTeachers.teacherId, perms.userId), eq(timetableAssignments.schoolYearId, year.schoolYearId)));
  if (mine.length) {
    const ids = mine.map((m) => m.id);
    const [gs, ts] = await Promise.all([
      db
        .select({ assignmentId: timetableAssignmentGroups.assignmentId, groupId: timetableAssignmentGroups.groupId, subjectId: timetableAssignments.subjectId })
        .from(timetableAssignmentGroups)
        .innerJoin(timetableAssignments, eq(timetableAssignments.id, timetableAssignmentGroups.assignmentId))
        .where(inArray(timetableAssignmentGroups.assignmentId, ids)),
      db
        .select({ assignmentId: timetableAssignmentTeachers.assignmentId, teacherId: timetableAssignmentTeachers.teacherId })
        .from(timetableAssignmentTeachers)
        .where(inArray(timetableAssignmentTeachers.assignmentId, ids)),
    ]);
    for (const g of gs) for (const t of ts.filter((x) => x.assignmentId === g.assignmentId)) add(g.groupId, g.subjectId, t.teacherId, g.assignmentId);
  }

  const validToday = and(lte(timetableLessons.validFrom, today), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, today)));
  const lessons = await db
    .selectDistinct({ groupId: timetableLessons.groupId, subjectId: timetableLessons.subjectId })
    .from(timetableLessons)
    .where(and(eq(timetableLessons.teacherId, perms.userId), validToday));
  if (lessons.length) {
    const colleagues = await db
      .selectDistinct({ groupId: timetableLessons.groupId, subjectId: timetableLessons.subjectId, teacherId: timetableLessons.teacherId })
      .from(timetableLessons)
      .where(and(inArray(timetableLessons.groupId, [...new Set(lessons.map((l) => l.groupId))]), validToday));
    for (const l of lessons)
      for (const c of colleagues) if (c.groupId === l.groupId && c.subjectId === l.subjectId && c.teacherId) add(l.groupId, l.subjectId, c.teacherId, null);
  }

  if (byKey.size === 0) return [];
  const groupIds = [...new Set([...byKey.values()].map((o) => o.groupId))];
  const [gRows, sRows] = await Promise.all([
    db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(inArray(groups.id, groupIds), inArray(groups.kind, [...BOOK_GROUP_KINDS]), isNull(groups.archivedAt))),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
  ]);
  const gName = new Map(gRows.map((g) => [g.id, g.name]));
  const sName = new Map(sRows.map((s) => [s.id, s.name]));
  return [...byKey.values()]
    .filter((o) => gName.has(o.groupId))
    .map((o) => ({
      groupId: o.groupId,
      groupName: gName.get(o.groupId)!,
      subjectId: o.subjectId,
      subjectName: sName.get(o.subjectId) ?? o.subjectId,
      assignmentId: o.assignmentId,
      teacherIds: [...o.teacherIds].sort(),
    }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName, "de") || a.subjectName.localeCompare(b.subjectName, "de"));
}

export interface NewBookInput {
  groupId: string;
  subjectId: string;
  term: number;
  scale: string;
}

/** Legt ein Notenbuch für einen eigenen Lehrauftrag an – mit allen Lehrkräften des Unterrichts (gleichberechtigt). */
export async function createBook(db: Db, perms: PermissionSet, input: NewBookInput, today: string): Promise<string> {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, OWN)) throw new ForbiddenError(OWN);
  const option = (await bookOptions(db, perms, today)).find((o) => o.groupId === input.groupId && o.subjectId === input.subjectId);
  if (!option) throw new ForbiddenError(OWN);
  const year = (await currentTerm(db, today))!;
  const fe: Record<string, string> = {};
  if (input.term !== 1 && input.term !== 2) fe.term = "Halbjahr 1 oder 2 wählen";
  if (!(SCALES as readonly string[]).includes(input.scale)) fe.scale = "Skala wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [dup] = await db
    .select({ id: notenbuchBooks.id })
    .from(notenbuchBooks)
    .where(
      and(
        eq(notenbuchBooks.schoolYearId, year.schoolYearId),
        eq(notenbuchBooks.term, input.term),
        eq(notenbuchBooks.groupId, input.groupId),
        eq(notenbuchBooks.subjectId, input.subjectId),
      ),
    );
  const duplicate = () =>
    new ValidationError({ groupId: "Für diese Lerngruppe, dieses Fach und Halbjahr gibt es schon ein Notenbuch – ggf. bei der Schulleitung übertragen lassen" });
  if (dup) throw duplicate();
  const teacherIds = [...new Set([...option.teacherIds, perms.userId])];
  const id = await db.transaction(async (tx) => {
    // G5A-C11: gleichzeitige Anlage (Teamteaching, Doppelklick) – der eindeutige Index entscheidet, die zweite bekommt den Hinweis
    const [book] = await tx
      .insert(notenbuchBooks)
      .values({
        schoolYearId: year.schoolYearId,
        term: input.term,
        groupId: input.groupId,
        subjectId: input.subjectId,
        assignmentId: option.assignmentId,
        scale: input.scale as Scale,
        weights: { ...DEFAULT_WEIGHTS },
        createdBy: perms.userId,
      })
      .onConflictDoNothing()
      .returning({ id: notenbuchBooks.id });
    if (!book) throw duplicate();
    await tx.insert(notenbuchBookTeachers).values(teacherIds.map((teacherId) => ({ bookId: book.id, teacherId })));
    return book.id;
  });
  await audit(db, perms.userId, "notenbuch.anlegen", id, { groupId: input.groupId, subjectId: input.subjectId, term: input.term });
  return id;
}

// ------------------------------------------------------------------ Eigene Bücher (Teilnoten)

/**
 * Das Buch, wenn die Person es führt (Recht `notenbuch.own` + eingetragen) – sonst null, wie nicht vorhanden. Exportiert für den
 * Offline-Abgleich (P5-20), der vorab prüft, bevor er Zellen liest.
 */
export async function ownBook(db: Db, perms: PermissionSet, bookId: string): Promise<NotenbuchBook | null> {
  if (!hasNotenbuchRight(perms, OWN)) return null;
  const [row] = await db
    .select({ b: notenbuchBooks })
    .from(notenbuchBooks)
    .innerJoin(notenbuchBookTeachers, and(eq(notenbuchBookTeachers.bookId, notenbuchBooks.id), eq(notenbuchBookTeachers.teacherId, perms.userId)))
    .where(eq(notenbuchBooks.id, bookId));
  return row?.b ?? null;
}

export interface BookListRow {
  id: string;
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  schoolYearName: string;
  term: number;
  scale: Scale;
  locked: boolean;
  /** Schuljahr vorbei (P5-15): nur lesbar */
  pastYear: boolean;
}

/** Bücher, die die Person führt – neueste Schuljahre zuerst, dann Gruppe und Fach. */
export async function myBooks(db: Db, perms: PermissionSet): Promise<BookListRow[]> {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, OWN)) return [];
  const rows = await db
    .select({ b: notenbuchBooks, groupName: groups.name, subjectName: subjects.name, yearName: schoolYears.name, yearStart: schoolYears.startsOn })
    .from(notenbuchBookTeachers)
    .innerJoin(notenbuchBooks, eq(notenbuchBooks.id, notenbuchBookTeachers.bookId))
    .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
    .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
    .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
    .where(eq(notenbuchBookTeachers.teacherId, perms.userId))
    .orderBy(de(groups.name), de(subjects.name), asc(notenbuchBooks.term));
  const [current] = await db.select({ startsOn: schoolYears.startsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  return rows
    .sort((a, b) => (a.yearStart === b.yearStart ? 0 : a.yearStart < b.yearStart ? 1 : -1))
    .map((r) => ({
      id: r.b.id,
      groupId: r.b.groupId,
      groupName: r.groupName,
      subjectId: r.b.subjectId,
      subjectName: r.subjectName,
      schoolYearName: r.yearName,
      term: r.b.term,
      scale: r.b.scale,
      locked: r.b.lockedAt !== null,
      pastYear: Boolean(current && r.yearStart < current.startsOn),
    }));
}

/** Schüler:innen einer Lerngruppe (aktuelle Mitglieder mit Rolle Schüler:in), deutsch sortiert. */
export async function groupStudents(db: Db, groupId: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: users.id, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(users.role, "schueler")))
    .orderBy(de(users.lastName), de(users.firstName));
}

export interface EntryCell {
  value: string;
  comment: string | null;
  version: number;
}

export interface BookView {
  book: NotenbuchBook;
  /** Schuljahr vorbei (P5-15): nur lesbar */
  pastYear: boolean;
  groupName: string;
  subjectName: string;
  schoolYearName: string;
  teachers: { id: string; name: string }[];
  columns: NotenbuchColumn[];
  students: { id: string; name: string }[];
  /** Schlüssel `${columnId}:${studentId}` */
  entries: Map<string, EntryCell>;
  results: Map<string, StudentResult>;
  termGrades: Map<string, { computed: string | null; final: string | null; finalizedAt: Date | null }>;
  /** Q-5A-1: Rundungsregel der Schule (für die Live-Berechnung in der Tabelle) */
  rounding: RoundingMode;
}

const cellKey = (columnId: string, studentId: string) => `${columnId}:${studentId}`;

function columnSpecs(columns: readonly NotenbuchColumn[]) {
  return columns.map((c) => ({ id: c.id, kind: c.kind, weight: c.weight, maxPoints: c.maxPoints, key: c.pointsToGrade }));
}

/** Ein Buch mit allen Teilnoten – nur für die Lehrkräfte des Buchs; sonst null (auch für Admin, Schulleitung, Klassenleitung). */
export async function getBook(db: Db, perms: PermissionSet, bookId: string): Promise<BookView | null> {
  await assertTwoFactor(db, perms);
  const book = await ownBook(db, perms, bookId);
  if (!book) return null;
  const [meta] = await db
    .select({ groupName: groups.name, groupArchived: groups.archivedAt, subjectName: subjects.name, yearName: schoolYears.name })
    .from(groups)
    .innerJoin(subjects, eq(subjects.id, book.subjectId))
    .innerJoin(schoolYears, eq(schoolYears.id, book.schoolYearId))
    .where(eq(groups.id, book.groupId));
  const pastYear = await isPastYear(db, book.schoolYearId);
  const [teachers, columns, members, terms] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(notenbuchBookTeachers)
      .innerJoin(users, eq(users.id, notenbuchBookTeachers.teacherId))
      .where(eq(notenbuchBookTeachers.bookId, bookId))
      .orderBy(de(users.lastName)),
    db.select().from(notenbuchColumns).where(eq(notenbuchColumns.bookId, bookId)).orderBy(asc(notenbuchColumns.position), asc(notenbuchColumns.createdAt)),
    groupStudents(db, book.groupId),
    db.select().from(notenbuchTermGrades).where(eq(notenbuchTermGrades.bookId, bookId)),
  ]);
  const entryRows = columns.length
    ? await db
        .select()
        .from(notenbuchEntries)
        .where(
          inArray(
            notenbuchEntries.columnId,
            columns.map((c) => c.id),
          ),
        )
    : [];
  // P5-15: nach dem Schuljahreswechsel hat die archivierte Gruppe keine Mitglieder mehr – dann zählen die Personen mit Noten
  let students = members;
  if (pastYear || meta?.groupArchived) {
    const ids = new Set([...members.map((m) => m.id), ...terms.map((t) => t.studentId), ...entryRows.map((e) => e.studentId)]);
    students = ids.size
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, [...ids]))
          .orderBy(de(users.lastName), de(users.firstName))
      : [];
  }
  const entries = new Map(entryRows.map((e) => [cellKey(e.columnId, e.studentId), { value: e.value, comment: e.comment, version: e.version }]));
  const specs = columnSpecs(columns);
  const rounding = await readRounding(db);
  const results = new Map(
    students.map((s) => [
      s.id,
      computeStudent(book.scale, book.weights, specs, new Map(entryRows.filter((e) => e.studentId === s.id).map((e) => [e.columnId, e.value])), rounding),
    ]),
  );
  return {
    book,
    pastYear,
    groupName: meta?.groupName ?? "",
    subjectName: meta?.subjectName ?? "",
    schoolYearName: meta?.yearName ?? "",
    teachers,
    columns,
    students,
    entries,
    results,
    termGrades: new Map(terms.map((t) => [t.studentId, { computed: t.computed, final: t.final, finalizedAt: t.finalizedAt }])),
    rounding,
  };
}

export interface ColumnInput {
  kind: string;
  title: string;
  date?: string | null;
  weight?: number;
  maxPoints?: number | null;
  key?: GradeKey | null;
}

interface ColumnValues {
  kind: ColumnKind;
  title: string;
  date: string | null;
  weight: number;
  maxPoints: number | null;
  key: GradeKey | null;
}

/** Prüft die Angaben einer Spalte gegen die Skala des Buchs (wirft `ValidationError`). */
function validateColumn(book: NotenbuchBook, input: ColumnInput): ColumnValues {
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  if (!title) fe.title = "Titel angeben";
  else if (title.length > COLUMN_TITLE_MAX) fe.title = `Titel bitte kürzer fassen (max. ${COLUMN_TITLE_MAX} Zeichen)`;
  if (!(COLUMN_KINDS as readonly string[]).includes(input.kind)) fe.kind = "Art wählen";
  const weight = input.weight ?? COLUMN_WEIGHT_DEFAULT;
  if (!Number.isInteger(weight) || weight < 0 || weight > COLUMN_WEIGHT_MAX) fe.weight = `Gewicht als ganze Zahl von 0 bis ${COLUMN_WEIGHT_MAX} (100 = einfach)`;
  if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fe.date = "Datum prüfen";
  const maxPoints = input.maxPoints ?? null;
  if (maxPoints !== null && !(Number.isFinite(maxPoints) && maxPoints > 0 && maxPoints <= MAX_POINTS_LIMIT)) fe.maxPoints = `Höchstpunktzahl zwischen 0 und ${MAX_POINTS_LIMIT}`;
  const key = input.key ?? null;
  if (key && maxPoints === null) fe.key = "Ein Notenschlüssel braucht eine Höchstpunktzahl";
  else if (key) {
    const e = keyError(key, book.scale);
    if (e) fe.key = e;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { kind: input.kind as ColumnKind, title, date: input.date || null, weight, maxPoints, key };
}

/** Eigenes, nicht gesperrtes Buch – sonst `ForbiddenError` bzw. `ValidationError` (gesperrt). */
async function writableBook(db: Db, perms: PermissionSet, bookId: string, field = "book"): Promise<NotenbuchBook> {
  const book = await ownBook(db, perms, bookId);
  if (!book) throw new ForbiddenError(OWN);
  if (book.lockedAt) throw new ValidationError({ [field]: "Das Notenbuch ist abgeschlossen und gesperrt" });
  if (await isPastYear(db, book.schoolYearId)) throw new ValidationError({ [field]: PAST_YEAR_MESSAGE });
  return book;
}

/** Spalte samt eigenem, nicht gesperrtem Buch. */
async function writableColumn(db: Db, perms: PermissionSet, columnId: string): Promise<{ col: NotenbuchColumn; book: NotenbuchBook }> {
  const [col] = await db.select().from(notenbuchColumns).where(eq(notenbuchColumns.id, columnId));
  if (!col) throw new ForbiddenError(OWN);
  return { col, book: await writableBook(db, perms, col.bookId) };
}

async function nextPosition(db: Db, bookId: string): Promise<number> {
  const [{ pos } = { pos: null }] = await db.select({ pos: max(notenbuchColumns.position) }).from(notenbuchColumns).where(eq(notenbuchColumns.bookId, bookId));
  return (pos ?? -1) + 1;
}

/** Neue Spalte (Leistungsnachweis) – geprüft; nur in eigenen, nicht gesperrten Büchern. */
export async function addColumn(db: Db, perms: PermissionSet, bookId: string, input: ColumnInput): Promise<string> {
  await assertTwoFactor(db, perms);
  const book = await writableBook(db, perms, bookId);
  const v = validateColumn(book, input);
  const position = await nextPosition(db, bookId);
  const [col] = await db.transaction(async (tx) => {
    await assertBookOpen(tx, bookId, "book");
    return tx
      .insert(notenbuchColumns)
      .values({ bookId, kind: v.kind, title: v.title, date: v.date, weight: v.weight, maxPoints: v.maxPoints, pointsToGrade: v.key, position })
      .returning({ id: notenbuchColumns.id });
  });
  await audit(db, perms.userId, "notenbuch.spalte", bookId, { column: col!.id });
  return col!.id;
}

/**
 * Spalte ändern (Titel, Art, Datum, Gewicht, Höchstpunktzahl, Notenschlüssel). Zwischen Punkten und Noten wechseln geht nur,
 * solange die Spalte keine Noten hat; eine kleinere Höchstpunktzahl nur, wenn keine Eingabe darüber liegt. Danach wird der
 * Vorschlag des ganzen Buchs neu berechnet.
 */
export async function updateColumn(db: Db, perms: PermissionSet, columnId: string, input: ColumnInput, now = new Date()): Promise<void> {
  await assertTwoFactor(db, perms);
  const { col, book } = await writableColumn(db, perms, columnId);
  const v = validateColumn(book, input);
  const rows = await db.select({ value: notenbuchEntries.value }).from(notenbuchEntries).where(eq(notenbuchEntries.columnId, columnId));
  const graded = rows.filter((r) => !(SPECIAL_VALUES as readonly string[]).includes(r.value));
  if (graded.length && (col.maxPoints === null) !== (v.maxPoints === null))
    throw new ValidationError({ maxPoints: "Zwischen Punkten und Noten lässt sich nur wechseln, solange die Spalte keine Noten hat" });
  if (graded.length && v.maxPoints !== null && graded.some((r) => Number(r.value) > v.maxPoints!))
    throw new ValidationError({ maxPoints: "Einzelne Eingaben liegen über der neuen Höchstpunktzahl" });
  await db.transaction(async (tx) => {
    await assertBookOpen(tx, book.id, "book");
    await tx
      .update(notenbuchColumns)
      .set({ kind: v.kind, title: v.title, date: v.date, weight: v.weight, maxPoints: v.maxPoints, pointsToGrade: v.key })
      .where(eq(notenbuchColumns.id, columnId));
  });
  await recomputeBook(db, book, now);
  await audit(db, perms.userId, "notenbuch.spalte.aendern", book.id, { column: columnId });
}

/** Spalte samt ihren Noten löschen; danach den Vorschlag des ganzen Buchs neu berechnen. */
export async function deleteColumn(db: Db, perms: PermissionSet, columnId: string, now = new Date()): Promise<void> {
  await assertTwoFactor(db, perms);
  const { book } = await writableColumn(db, perms, columnId);
  const entries = await db.select({ studentId: notenbuchEntries.studentId }).from(notenbuchEntries).where(eq(notenbuchEntries.columnId, columnId));
  await db.transaction(async (tx) => {
    await assertBookOpen(tx, book.id, "book");
    await tx.delete(notenbuchColumns).where(eq(notenbuchColumns.id, columnId));
  });
  await recomputeBook(db, book, now);
  await audit(db, perms.userId, "notenbuch.spalte.loeschen", book.id, { column: columnId, eintraege: entries.length });
}

/** Spalte eine Stelle nach links (−1) bzw. rechts (+1) schieben. */
export async function moveColumn(db: Db, perms: PermissionSet, columnId: string, direction: number): Promise<void> {
  await assertTwoFactor(db, perms);
  const { book } = await writableColumn(db, perms, columnId);
  if (direction !== -1 && direction !== 1) throw new ValidationError({ direction: "Richtung −1 oder +1" });
  const cols = await db
    .select({ id: notenbuchColumns.id })
    .from(notenbuchColumns)
    .where(eq(notenbuchColumns.bookId, book.id))
    .orderBy(asc(notenbuchColumns.position), asc(notenbuchColumns.createdAt));
  const ids = cols.map((c) => c.id);
  const i = ids.indexOf(columnId);
  const j = i + direction;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  await db.transaction(async (tx) => {
    await assertBookOpen(tx, book.id, "book");
    for (const [position, id] of ids.entries()) await tx.update(notenbuchColumns).set({ position }).where(eq(notenbuchColumns.id, id));
  });
}

/** Gewichte je Spaltenart (ganze %, Summe ≠ 100 erlaubt – Hinweis in der Tabelle); danach das ganze Buch neu berechnen. */
export async function setWeights(db: Db, perms: PermissionSet, bookId: string, weights: Weights, now = new Date()): Promise<void> {
  await assertTwoFactor(db, perms);
  const book = await writableBook(db, perms, bookId);
  const clean: Weights = Object.fromEntries(COLUMN_KINDS.map((k) => [k, weights[k] ?? 0]));
  const e = weightsError(clean);
  if (e) throw new ValidationError({ weights: e });
  await db.transaction(async (tx) => {
    await assertBookOpen(tx, bookId, "weights");
    await tx.update(notenbuchBooks).set({ weights: clean, updatedAt: now }).where(eq(notenbuchBooks.id, bookId));
  });
  await recomputeBook(db, { ...book, weights: clean }, now);
  await audit(db, perms.userId, "notenbuch.gewichte", bookId, clean);
}

/** Zeitraum des Halbjahres eines Buchs (2. Halbjahr ab `term2_starts_on`; ohne Angabe das ganze Schuljahr). */
export async function termRange(db: Db, book: Pick<NotenbuchBook, "schoolYearId" | "term">): Promise<{ from: string; to: string }> {
  const [y] = await db.select().from(schoolYears).where(eq(schoolYears.id, book.schoolYearId));
  if (!y) return { from: "0000-01-01", to: "9999-12-31" };
  if (!y.term2StartsOn) return { from: y.startsOn, to: y.endsOn };
  return book.term === 1 ? { from: y.startsOn, to: addDays(y.term2StartsOn, -1) } : { from: y.term2StartsOn, to: y.endsOn };
}

export interface ExamOption {
  id: string;
  title: string;
  date: string;
  kind: string;
}

/** Klausurplan-Termine der Gruppe im Fach und Halbjahr des Buchs, die noch keine Spalte haben (nur für eigene Bücher). */
export async function examOptions(db: Db, perms: PermissionSet, bookId: string): Promise<ExamOption[]> {
  await assertTwoFactor(db, perms);
  const book = await ownBook(db, perms, bookId);
  if (!book) return [];
  const { from, to } = await termRange(db, book);
  const [rows, used] = await Promise.all([
    db
      .select({ id: exams.id, title: exams.title, date: exams.date, kind: exams.kind })
      .from(exams)
      .where(and(eq(exams.groupId, book.groupId), eq(exams.subjectId, book.subjectId), gte(exams.date, from), lte(exams.date, to)))
      .orderBy(asc(exams.date)),
    db.select({ examId: notenbuchColumns.examId }).from(notenbuchColumns).where(eq(notenbuchColumns.bookId, bookId)),
  ]);
  const taken = new Set(used.map((u) => u.examId));
  return rows.filter((r) => !taken.has(r.id));
}

/** Spalte aus einem Klausurplan-Termin (schriftlich, Titel und Datum übernommen, verknüpft). */
export async function addColumnFromExam(db: Db, perms: PermissionSet, bookId: string, examId: string): Promise<string> {
  await assertTwoFactor(db, perms);
  await writableBook(db, perms, bookId);
  const exam = (await examOptions(db, perms, bookId)).find((e) => e.id === examId);
  if (!exam) throw new ValidationError({ examId: "Diesen Termin gibt es im Klausurplan der Lerngruppe nicht (mehr), oder er ist schon übernommen" });
  const position = await nextPosition(db, bookId);
  const [col] = await db.transaction(async (tx) => {
    await assertBookOpen(tx, bookId, "book");
    return tx
      .insert(notenbuchColumns)
      .values({ bookId, kind: "schriftlich", title: exam.title.slice(0, COLUMN_TITLE_MAX), date: exam.date, examId, position })
      .returning({ id: notenbuchColumns.id });
  });
  await audit(db, perms.userId, "notenbuch.spalte", bookId, { column: col!.id, examId });
  return col!.id;
}

/**
 * Fehlstunden je Schüler:in – **nur aus eigenen Stunden** der Lehrkraft (Klassenbuch: Lerngruppe und Fach des Buchs, von dieser
 * Lehrkraft eingetragen, im Halbjahr), nur „fehlt“, ohne Grund oder Entschuldigungsstand (F5-10).
 */
export async function ownAbsenceCounts(db: Db, perms: PermissionSet, book: NotenbuchBook): Promise<Map<string, number>> {
  const { from, to } = await termRange(db, book);
  const rows = await db
    .select({ studentId: classbookAbsences.studentId, n: count() })
    .from(classbookAbsences)
    .innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId))
    .where(
      and(
        eq(classbookAbsences.kind, "absent"),
        eq(classbookEntries.groupId, book.groupId),
        eq(classbookEntries.subjectId, book.subjectId),
        eq(classbookEntries.teacherId, perms.userId),
        gte(classbookEntries.date, from),
        lte(classbookEntries.date, to),
      ),
    )
    .groupBy(classbookAbsences.studentId);
  return new Map(rows.map((r) => [r.studentId, Number(r.n)]));
}

/** Die Zelle wurde inzwischen geändert (Versionsprüfung) – die Seite zeigt einen Hinweis und lädt neu. */
export class EntryConflictError extends ValidationError {
  constructor() {
    super({ value: "Die Zelle wurde inzwischen geändert – bitte neu laden" });
    this.name = "EntryConflictError";
  }
}

export interface EntryInput {
  columnId: string;
  studentId: string;
  value: string;
  comment?: string | null;
  /** erwartete Version der Zelle (Abgleich; ohne Angabe gilt der letzte Stand) */
  expectedVersion?: number;
}

/** G5A-C02: nächste Revision einer Zelle (Sequenz, monoton über alle Zellen). */
async function nextEntryRevision(tx: Db): Promise<number> {
  const [r] = rowsOf<{ v: string | number }>(await tx.execute(sql`select nextval('notenbuch_entry_revision') as v`));
  return Number(r!.v);
}

/**
 * G5A-C08: legt eine Zelle neu an, **ohne** eine inzwischen (parallel) angelegte zu überschreiben – false, wenn es sie schon
 * gibt. Exportiert für den Regressionstest.
 */
export async function insertNewEntry(tx: Db, row: typeof notenbuchEntries.$inferInsert): Promise<boolean> {
  const done = await tx.insert(notenbuchEntries).values(row).onConflictDoNothing().returning({ columnId: notenbuchEntries.columnId });
  return done.length === 1;
}

/**
 * G5A-C09: Buch in der laufenden Transaktion geteilt sperren und prüfen, dass es nicht abgeschlossen ist – `lockBook` sperrt
 * dieselbe Zeile exklusiv, Schreibzugriffe und Abschluss laufen also nacheinander.
 */
async function assertBookOpen(tx: Db, bookId: string, field: string): Promise<void> {
  const [b] = await tx.select({ lockedAt: notenbuchBooks.lockedAt }).from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId)).for("share");
  if (!b) throw new ForbiddenError(OWN);
  if (b.lockedAt) throw new ValidationError({ [field]: "Das Notenbuch ist abgeschlossen und gesperrt" });
}

/**
 * Setzt eine Teilnote (leer = löschen) samt Kurzkommentar – nur in eigenen, nicht gesperrten Büchern, nur für Schüler:innen
 * der Gruppe. Vergibt eine neue Revision (Sequenz) und frischt den berechneten Halbjahresvorschlag der Person auf.
 */
export async function setEntry(db: Db, perms: PermissionSet, input: EntryInput, now = new Date()): Promise<number> {
  await assertTwoFactor(db, perms);
  const [col] = await db.select().from(notenbuchColumns).where(eq(notenbuchColumns.id, input.columnId));
  const book = col ? await ownBook(db, perms, col.bookId) : null;
  if (!col || !book) throw new ForbiddenError(OWN);
  if (book.lockedAt) throw new ValidationError({ value: "Das Notenbuch ist abgeschlossen und gesperrt" });
  if (await isPastYear(db, book.schoolYearId)) throw new ValidationError({ value: PAST_YEAR_MESSAGE });
  const students = await groupStudents(db, book.groupId);
  if (!students.some((s) => s.id === input.studentId)) throw new ValidationError({ studentId: "Die Person gehört nicht zur Lerngruppe" });
  const parsed = parseEntry(input.value, book.scale, col);
  if (parsed.kind === "invalid") throw new ValidationError({ value: parsed.error });
  const comment = (input.comment ?? "").trim() || null;
  if (comment && comment.length > COMMENT_MAX) throw new ValidationError({ comment: `Kommentar höchstens ${COMMENT_MAX} Zeichen` });
  if (parsed.kind === "empty" && comment) throw new ValidationError({ value: "Ein Kommentar braucht einen Wert (Note, „fehlt“ oder „befreit“)" });

  const cell = and(eq(notenbuchEntries.columnId, col.id), eq(notenbuchEntries.studentId, input.studentId));
  const version = await db.transaction(async (tx) => {
    // G5A-C09: Sperre in derselben Transaktion prüfen (die Buchzeile geteilt sperren – `lockBook` wartet bzw. wir sehen sie)
    await assertBookOpen(tx, book.id, "value");
    const [current] = await tx.select({ version: notenbuchEntries.version }).from(notenbuchEntries).where(cell).for("update");
    if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0)) {
      throw new EntryConflictError();
    }
    if (parsed.kind === "empty") {
      if (current) await tx.delete(notenbuchEntries).where(cell);
      return 0;
    }
    // bei Punkte-Spalten werden die Punkte gespeichert (die Note ergibt sich aus dem Schlüssel und folgt dessen Änderungen)
    const value = parsed.kind === "grade" ? (parsed.points !== undefined ? String(parsed.points) : parsed.label) : parsed.kind;
    // G5A-C02: monotone Revision aus der Sequenz – auch nach Löschen und Neuanlage nie wieder eine alte
    const next = await nextEntryRevision(tx);
    const row = { columnId: col.id, studentId: input.studentId, value, comment, version: next, updatedBy: perms.userId, updatedAt: now };
    if (current) {
      await tx.update(notenbuchEntries).set({ value, comment, version: next, updatedBy: perms.userId, updatedAt: now }).where(cell);
      return next;
    }
    // G5A-C08: Erstanlage ohne Überschreiben – hat jemand die Zelle inzwischen angelegt, ist das ein Konflikt
    if (await insertNewEntry(tx, row)) return next;
    if (input.expectedVersion !== undefined) throw new EntryConflictError();
    await tx.update(notenbuchEntries).set({ value, comment, version: next, updatedBy: perms.userId, updatedAt: now }).where(cell);
    return next;
  });
  await refreshComputed(db, book, [input.studentId], now);
  return version;
}

/** Berechnet den Halbjahresvorschlag (`computed`) der genannten Personen neu; festgelegte Noten bleiben unberührt. */
async function refreshComputed(db: Db, book: NotenbuchBook, studentIds: readonly string[], now: Date): Promise<void> {
  const columns = await db.select().from(notenbuchColumns).where(eq(notenbuchColumns.bookId, book.id));
  const rows = columns.length
    ? await db
        .select({ columnId: notenbuchEntries.columnId, studentId: notenbuchEntries.studentId, value: notenbuchEntries.value })
        .from(notenbuchEntries)
        .where(
          and(
            inArray(
              notenbuchEntries.columnId,
              columns.map((c) => c.id),
            ),
            inArray(notenbuchEntries.studentId, [...studentIds]),
          ),
        )
    : [];
  const specs = columnSpecs(columns);
  const rounding = await readRounding(db);
  for (const studentId of studentIds) {
    const r = computeStudent(book.scale, book.weights, specs, new Map(rows.filter((x) => x.studentId === studentId).map((x) => [x.columnId, x.value])), rounding);
    await db
      .insert(notenbuchTermGrades)
      .values({ bookId: book.id, studentId, computed: r.grade, updatedAt: now })
      .onConflictDoUpdate({ target: [notenbuchTermGrades.bookId, notenbuchTermGrades.studentId], set: { computed: r.grade, updatedAt: now } });
  }
}

/** Q-5A-1: Rundungsregel der Schule (Moduleinstellung, Vorgabe zugunsten der Schüler:in). */
export async function readRounding(db: Db): Promise<RoundingMode> {
  return (await readModuleSetting(db, ROUNDING)) === "kaufmaennisch" ? "kaufmaennisch" : "schueler";
}

/**
 * Q-5A-1: Nach dem Ändern der Rundungsregel die Vorschläge aller **offenen** Bücher (nicht abgeschlossen, nicht aus einem
 * vergangenen Schuljahr) neu berechnen; festgelegte Noten bleiben unberührt.
 */
export async function recomputeOpenBooks(db: Db, now = new Date()): Promise<number> {
  const books = await db.select().from(notenbuchBooks).where(isNull(notenbuchBooks.lockedAt));
  let n = 0;
  for (const book of books) {
    if (await isPastYear(db, book.schoolYearId)) continue;
    await recomputeBook(db, book, now);
    n++;
  }
  return n;
}

/** Vorschlag des ganzen Buchs neu berechnen (nach Änderung von Gewichten, Schlüsseln oder Spalten). */
async function recomputeBook(db: Db, book: NotenbuchBook, now: Date): Promise<void> {
  const [students, existing] = await Promise.all([
    groupStudents(db, book.groupId),
    db.select({ studentId: notenbuchTermGrades.studentId }).from(notenbuchTermGrades).where(eq(notenbuchTermGrades.bookId, book.id)),
  ]);
  const ids = [...new Set([...students.map((s) => s.id), ...existing.map((e) => e.studentId)])];
  if (ids.length) await refreshComputed(db, book, ids, now);
}

// ------------------------------------------------------------------ Halbjahreswerte (Klassenleitung, Schulleitung)

export interface TermGradeRow {
  studentId: string;
  subjectId: string;
  subjectName: string;
  /** Lerngruppe des Buchs (Klasse oder Kurs) */
  groupName: string;
  schoolYearName: string;
  term: number;
  computed: string | null;
  final: string | null;
  finalized: boolean;
  /** Buch abgeschlossen und gesperrt */
  locked: boolean;
}

export interface TermOverview {
  groupId: string;
  groupName: string;
  students: { id: string; name: string }[];
  grades: TermGradeRow[];
}

/**
 * Halbjahreswerte aller Fächer für die Schüler:innen einer Klasse – **ohne** Teilnoten, Spalten oder Kommentare. Nur mit
 * `notenbuch.term_view` oder als Klassenleitung dieser Klasse; jeder Abruf steht im Audit-Log (`lesen.notenbuch`). Sonst null.
 */
export async function termOverview(db: Db, perms: PermissionSet, groupId: string, now = new Date(), sel?: TermSelection): Promise<TermOverview | null> {
  await assertTwoFactor(db, perms);
  const [group] = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind })
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.archivedAt)));
  if (!group || group.kind !== "klasse") return null;
  const allowed = hasNotenbuchRight(perms, TERM_VIEW) || (await ledClasses(db, perms)).includes(groupId);
  if (!allowed) return null;
  const students = await groupStudents(db, groupId);
  const grades = students.length
    ? await db
        .select({
          studentId: notenbuchTermGrades.studentId,
          subjectId: notenbuchBooks.subjectId,
          subjectName: subjects.name,
          groupName: groups.name,
          schoolYearName: schoolYears.name,
          term: notenbuchBooks.term,
          computed: notenbuchTermGrades.computed,
          final: notenbuchTermGrades.final,
          finalizedAt: notenbuchTermGrades.finalizedAt,
          lockedAt: notenbuchBooks.lockedAt,
        })
        .from(notenbuchTermGrades)
        .innerJoin(notenbuchBooks, eq(notenbuchBooks.id, notenbuchTermGrades.bookId))
        .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
        .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
        .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
        .where(
          and(
            inArray(
              notenbuchTermGrades.studentId,
              students.map((s) => s.id),
            ),
            sel ? eq(notenbuchBooks.schoolYearId, sel.schoolYearId) : undefined,
            sel ? eq(notenbuchBooks.term, sel.term) : undefined,
          ),
        )
        .orderBy(asc(notenbuchBooks.term), de(subjects.name))
    : [];
  // G5A-S08: Schuljahr und Halbjahr im Ziel – je gelesenem Halbjahr ein Eintrag (die 30-Minuten-Bündelung gilt je Ziel)
  const target = sel ? `klasse:${groupId}:${sel.schoolYearId}:hj${sel.term}` : `klasse:${groupId}`;
  await auditRead(db, perms.userId, "lesen.notenbuch", target, { halbjahreswerte: grades.length, ...(sel ? { schuljahr: sel.schoolYearId, halbjahr: sel.term } : {}) }, now);
  return {
    groupId,
    groupName: group.name,
    students,
    grades: grades.map(({ finalizedAt, lockedAt, ...g }) => ({ ...g, finalized: finalizedAt !== null, locked: lockedAt !== null })),
  };
}

export interface HandoverColumn {
  /** `${subjectId}|${groupName}` – ein Buch je Lerngruppe, Fach und Halbjahr */
  key: string;
  subjectId: string;
  subjectName: string;
  /** Lerngruppe, wenn sie nicht die Klasse selbst ist (Kurs, Förderkurs) – sonst null */
  groupName: string | null;
  locked: boolean;
}

/**
 * G5A-C07: Spalten der Übergabeliste je **Fach und Lerngruppe** (nicht nur je Fach) – Klasse und Förderkurs im selben Fach sind
 * zwei Spalten, keine Note verschwindet. Rein (für Seite und Test).
 */
export function handoverGrid(className: string, grades: readonly TermGradeRow[]): { columns: HandoverColumn[]; cells: Map<string, TermGradeRow> } {
  const columns = new Map<string, HandoverColumn>();
  const cells = new Map<string, TermGradeRow>();
  for (const g of grades) {
    const key = `${g.subjectId}|${g.groupName}`;
    const col = columns.get(key) ?? { key, subjectId: g.subjectId, subjectName: g.subjectName, groupName: g.groupName === className ? null : g.groupName, locked: true };
    col.locked &&= g.locked;
    columns.set(key, col);
    cells.set(`${g.studentId}:${key}`, g);
  }
  const sorted = [...columns.values()].sort(
    (a, b) => a.subjectName.localeCompare(b.subjectName, "de") || Number(a.groupName !== null) - Number(b.groupName !== null) || (a.groupName ?? "").localeCompare(b.groupName ?? "", "de"),
  );
  return { columns: sorted, cells };
}

// ------------------------------------------------------------------ Übertragen

export interface TransferRow {
  id: string;
  groupName: string;
  subjectName: string;
  schoolYearName: string;
  term: number;
  teachers: { id: string; name: string }[];
}

/** Führt das Buch aktiv: Rolle Lehrkraft, Konto aktiv, kein Abgang vermerkt (P5-15). */
const activeTeacherSql = () => and(eq(users.role, "lehrkraft"), eq(users.status, "active"), isNull(users.leftOn));

export interface OrphanRow {
  id: string;
  groupName: string;
  subjectName: string;
  schoolYearName: string;
  term: number;
}

/**
 * P5-15: verwaiste Notenbücher – keine aktive Lehrkraft mehr (Abgang, Konto gesperrt oder gelöscht). Die Bücher gehören der
 * Schule und bleiben; übertragen wird mit `notenbuch.transfer`. Nur Gruppe, Fach und Halbjahr, keine Noten; Bücher vergangener
 * Schuljahre zählen nicht (nur lesbar, gehen mit der Löschfrist). Ohne Rechteprüfung – Aufrufer zeigen nur Namen und Anzahl.
 */
export async function orphanedBooks(db: Db): Promise<OrphanRow[]> {
  const [current] = await db.select({ startsOn: schoolYears.startsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  const rows = await db
    .select({ id: notenbuchBooks.id, groupName: groups.name, subjectName: subjects.name, yearName: schoolYears.name, yearStart: schoolYears.startsOn, term: notenbuchBooks.term })
    .from(notenbuchBooks)
    .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
    .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
    .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
    .where(current ? gte(schoolYears.startsOn, current.startsOn) : undefined)
    .orderBy(de(groups.name), de(subjects.name), asc(notenbuchBooks.term));
  if (!rows.length) return [];
  const active = await db
    .selectDistinct({ bookId: notenbuchBookTeachers.bookId })
    .from(notenbuchBookTeachers)
    .innerJoin(users, eq(users.id, notenbuchBookTeachers.teacherId))
    .where(
      and(
        inArray(
          notenbuchBookTeachers.bookId,
          rows.map((r) => r.id),
        ),
        activeTeacherSql(),
      ),
    );
  const led = new Set(active.map((a) => a.bookId));
  return rows.filter((r) => !led.has(r.id)).map(({ id, groupName, subjectName, yearName, term }) => ({ id, groupName, subjectName, schoolYearName: yearName, term }));
}

/** Wer ein Buch übernehmen kann: aktive Lehrkräfte (für das Übertragen-Formular). Nur mit `notenbuch.transfer`. */
export async function transferTargets(db: Db, perms: PermissionSet): Promise<{ id: string; name: string }[]> {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, TRANSFER)) throw new ForbiddenError(TRANSFER);
  // G5A-S02: nie an sich selbst (sonst öffnete `transfer` + `own` jedes Buch samt Teilnoten)
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(activeTeacherSql(), ne(users.id, perms.userId)))
    .orderBy(de(users.lastName), de(users.firstName));
}

/** Bücher zum Übertragen – nur Gruppe, Fach, Halbjahr und Lehrkräfte, keine Noten. Nur mit `notenbuch.transfer`. */
export async function booksForTransfer(db: Db, perms: PermissionSet): Promise<TransferRow[]> {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, TRANSFER)) throw new ForbiddenError(TRANSFER);
  const rows = await db
    .select({ id: notenbuchBooks.id, groupName: groups.name, subjectName: subjects.name, yearName: schoolYears.name, term: notenbuchBooks.term })
    .from(notenbuchBooks)
    .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
    .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
    .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
    .orderBy(de(groups.name), de(subjects.name), asc(notenbuchBooks.term));
  const teachers = rows.length
    ? await db
        .select({ bookId: notenbuchBookTeachers.bookId, id: users.id, name: users.name })
        .from(notenbuchBookTeachers)
        .innerJoin(users, eq(users.id, notenbuchBookTeachers.teacherId))
        .where(
          inArray(
            notenbuchBookTeachers.bookId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(de(users.lastName))
    : [];
  return rows.map((r) => ({
    id: r.id,
    groupName: r.groupName,
    subjectName: r.subjectName,
    schoolYearName: r.yearName,
    term: r.term,
    teachers: teachers.filter((t) => t.bookId === r.id).map(({ id, name }) => ({ id, name })),
  }));
}

/**
 * Überträgt ein Buch an eine Lehrkraft (z. B. Vertretung über längere Zeit, Abgang): `toTeacherId` wird eingetragen, auf Wunsch
 * `removeTeacherId` ausgetragen. Nur mit `notenbuch.transfer`; protokolliert ohne Noten.
 */
export async function transferBook(db: Db, perms: PermissionSet, bookId: string, input: { toTeacherId: string; removeTeacherId?: string | null }): Promise<void> {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, TRANSFER)) throw new ForbiddenError(TRANSFER);
  const [book] = await db
    .select({ id: notenbuchBooks.id, groupName: groups.name, subjectName: subjects.name, term: notenbuchBooks.term })
    .from(notenbuchBooks)
    .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
    .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
    .where(eq(notenbuchBooks.id, bookId));
  if (!book) throw new ForbiddenError(TRANSFER);
  // G5A-S02: Übertragung an sich selbst ist ausgeschlossen (transfer sieht keine Noten – auch nicht auf diesem Umweg)
  if (input.toTeacherId === perms.userId) throw new ValidationError({ toTeacherId: "Ein Notenbuch lässt sich nicht an sich selbst übertragen" });
  const [target] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.toTeacherId), activeTeacherSql()));
  if (!target) throw new ValidationError({ toTeacherId: "Bitte eine aktive Lehrkraft wählen" });
  const remove = input.removeTeacherId && input.removeTeacherId !== input.toTeacherId ? input.removeTeacherId : null;
  const before = await db.select({ id: notenbuchBookTeachers.teacherId }).from(notenbuchBookTeachers).where(eq(notenbuchBookTeachers.bookId, bookId));
  await db.transaction(async (tx) => {
    await tx.insert(notenbuchBookTeachers).values({ bookId, teacherId: input.toTeacherId }).onConflictDoNothing();
    if (remove) await tx.delete(notenbuchBookTeachers).where(and(eq(notenbuchBookTeachers.bookId, bookId), eq(notenbuchBookTeachers.teacherId, remove)));
  });
  await audit(db, perms.userId, "notenbuch.uebertragen", bookId, { to: input.toTeacherId, from: remove });
  // die bisher eingetragenen Lehrkräfte erfahren davon (ohne Noten)
  const label = `${book.groupName} – ${book.subjectName} (${book.term}. Halbjahr)`;
  await notify(
    db,
    before.map((t) => t.id).filter((id) => id !== perms.userId && id !== input.toTeacherId),
    { moduleId: "notenbuch", title: `Notenbuch übertragen: ${label}`, body: "Eine weitere Lehrkraft führt dieses Notenbuch jetzt mit (Übertragung durch die Schulleitung, protokolliert)." },
  );
}

// ------------------------------------------------------------------ Halbjahresabschluss (P5-13)

/** Festgelegte Halbjahresnote: eine Stufe der Skala oder „befreit“ (z. B. Sport). */
export const FINAL_SPECIAL = "befreit";
export const UNLOCK_REASON_MAX = 200;

/** Prüft eine festzulegende Note – null = in Ordnung. */
export function finalGradeError(scale: Scale, value: string): string | null {
  if (value === FINAL_SPECIAL || scaleValues(scale).includes(value)) return null;
  const hint = scale === "noten6" ? "1 bis 6" : scale === "noten6_tendenz" ? "1+ bis 6" : "0 bis 15 Punkte";
  return `Halbjahresnote: ${hint} oder „befreit“`;
}

/**
 * Halbjahresnote einer Person festlegen (abweichend vom Vorschlag erlaubt) bzw. mit leerem Wert zurücknehmen. Nur Lehrkräfte des
 * Buchs, nur bei offenem Buch, nur für Schüler:innen der Gruppe.
 */
export async function setFinalGrade(db: Db, perms: PermissionSet, bookId: string, studentId: string, raw: string, now = new Date()): Promise<void> {
  await assertTwoFactor(db, perms);
  const book = await writableBook(db, perms, bookId, "final");
  if (!(await groupStudents(db, book.groupId)).some((s) => s.id === studentId)) throw new ValidationError({ studentId: "Die Person gehört nicht zur Lerngruppe" });
  const value = normalizeInput(raw);
  if (value !== "") {
    const e = finalGradeError(book.scale, value);
    if (e) throw new ValidationError({ final: e });
  }
  await refreshComputed(db, book, [studentId], now);
  await db.transaction(async (tx) => {
    await assertBookOpen(tx, bookId, "final");
    await tx
      .update(notenbuchTermGrades)
      .set(value === "" ? { final: null, finalizedAt: null, finalizedBy: null, updatedAt: now } : { final: value, finalizedAt: now, finalizedBy: perms.userId, updatedAt: now })
      .where(and(eq(notenbuchTermGrades.bookId, bookId), eq(notenbuchTermGrades.studentId, studentId)));
  });
}

/** Übernimmt für alle ohne festgelegte Note den aktuellen Vorschlag. Gibt die Anzahl zurück. */
export async function adoptSuggestions(db: Db, perms: PermissionSet, bookId: string, now = new Date()): Promise<number> {
  await assertTwoFactor(db, perms);
  const book = await writableBook(db, perms, bookId);
  await recomputeBook(db, book, now);
  const students = (await groupStudents(db, book.groupId)).map((s) => s.id);
  if (!students.length) return 0;
  const rows = await db.transaction(async (tx) => {
    await assertBookOpen(tx, bookId, "book");
    return tx
      .update(notenbuchTermGrades)
      .set({ final: sql`${notenbuchTermGrades.computed}`, finalizedAt: now, finalizedBy: perms.userId, updatedAt: now })
      .where(
        and(
          eq(notenbuchTermGrades.bookId, bookId),
          isNull(notenbuchTermGrades.final),
          isNotNull(notenbuchTermGrades.computed),
          inArray(notenbuchTermGrades.studentId, students),
        ),
      )
      .returning({ studentId: notenbuchTermGrades.studentId });
  });
  if (rows.length) await audit(db, perms.userId, "notenbuch.festlegen", bookId, { anzahl: rows.length });
  return rows.length;
}

/**
 * Halbjahresabschluss: Vorschläge neu berechnen, dann sperren – nur wenn **jede** Person der Gruppe eine festgelegte Note hat.
 * Danach keine Änderungen mehr; entsperren nur mit `notenbuch.unlock` (Schulleitung, protokolliert).
 */
export async function lockBook(db: Db, perms: PermissionSet, bookId: string, now = new Date()): Promise<void> {
  await assertTwoFactor(db, perms);
  const book = await writableBook(db, perms, bookId);
  await recomputeBook(db, book, now);
  const students = await groupStudents(db, book.groupId);
  // G5A-C09: Prüfung „alle festgelegt“ und Sperren in einer Transaktion mit exklusiv gesperrter Buchzeile – parallele
  // Schreibzugriffe (setEntry, setFinalGrade, Spalten, Gewichte) sperren sie geteilt und laufen davor oder danach
  await db.transaction(async (tx) => {
    const [b] = await tx.select({ lockedAt: notenbuchBooks.lockedAt }).from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId)).for("update");
    if (!b) throw new ForbiddenError(OWN);
    if (b.lockedAt) throw new ValidationError({ book: "Das Notenbuch ist abgeschlossen und gesperrt" });
    const finals = await tx
      .select({ studentId: notenbuchTermGrades.studentId })
      .from(notenbuchTermGrades)
      .where(and(eq(notenbuchTermGrades.bookId, bookId), isNotNull(notenbuchTermGrades.final)));
    const done = new Set(finals.map((f) => f.studentId));
    const missing = students.filter((s) => !done.has(s.id)).length;
    if (missing) throw new ValidationError({ book: `Für ${missing} ${missing === 1 ? "Person fehlt" : "Personen fehlt"} noch die festgelegte Halbjahresnote` });
    await tx.update(notenbuchBooks).set({ lockedAt: now, updatedAt: now }).where(eq(notenbuchBooks.id, bookId));
  });
  await audit(db, perms.userId, "notenbuch.abschliessen", bookId, { schueler: students.length });
}

export interface LockedBookRow extends TransferRow {
  lockedAt: Date;
}

/** Abgeschlossene Bücher zum Entsperren – ohne Noten. Nur mit `notenbuch.unlock`. */
export async function lockedBooks(db: Db, perms: PermissionSet): Promise<LockedBookRow[]> {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, UNLOCK)) throw new ForbiddenError(UNLOCK);
  const rows = await db
    .select({ id: notenbuchBooks.id, groupName: groups.name, subjectName: subjects.name, yearName: schoolYears.name, term: notenbuchBooks.term, lockedAt: notenbuchBooks.lockedAt })
    .from(notenbuchBooks)
    .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
    .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
    .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
    .where(isNotNull(notenbuchBooks.lockedAt))
    .orderBy(de(groups.name), de(subjects.name), asc(notenbuchBooks.term));
  const teachers = rows.length
    ? await db
        .select({ bookId: notenbuchBookTeachers.bookId, id: users.id, name: users.name })
        .from(notenbuchBookTeachers)
        .innerJoin(users, eq(users.id, notenbuchBookTeachers.teacherId))
        .where(
          inArray(
            notenbuchBookTeachers.bookId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(de(users.lastName))
    : [];
  return rows.map((r) => ({
    id: r.id,
    groupName: r.groupName,
    subjectName: r.subjectName,
    schoolYearName: r.yearName,
    term: r.term,
    lockedAt: r.lockedAt!,
    teachers: teachers.filter((t) => t.bookId === r.id).map(({ id, name }) => ({ id, name })),
  }));
}

/** Abgeschlossenes Buch wieder öffnen – nur mit `notenbuch.unlock`, mit Begründung, protokolliert (ohne Noten zu sehen). */
export async function unlockBook(db: Db, perms: PermissionSet, bookId: string, reasonRaw: string, now = new Date()): Promise<void> {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, UNLOCK)) throw new ForbiddenError(UNLOCK);
  const [book] = await db.select({ id: notenbuchBooks.id, lockedAt: notenbuchBooks.lockedAt }).from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId));
  if (!book) throw new ForbiddenError(UNLOCK);
  if (!book.lockedAt) throw new ValidationError({ book: "Das Notenbuch ist nicht gesperrt" });
  const reason = reasonRaw.trim();
  if (reason.length < 3) throw new ValidationError({ reason: "Bitte kurz begründen (wird protokolliert)" });
  if (reason.length > UNLOCK_REASON_MAX) throw new ValidationError({ reason: `Begründung höchstens ${UNLOCK_REASON_MAX} Zeichen` });
  await db.update(notenbuchBooks).set({ lockedAt: null, updatedAt: now }).where(eq(notenbuchBooks.id, bookId));
  await audit(db, perms.userId, "notenbuch.entsperren", bookId, { grund: reason });
}

/**
 * Klassen für die Übergabeliste (`view`: mit `term_view` alle aktiven Klassen, als Klassenleitung die eigenen) bzw. den Export
 * (`export`: mit `notenbuch.export` alle aktiven Klassen). Nur Namen – das Lesen der Werte protokolliert `termOverview`.
 */
export async function handoverClasses(db: Db, perms: PermissionSet, purpose: "view" | "export" = "view"): Promise<{ id: string; name: string }[]> {
  await assertTwoFactor(db, perms);
  if (purpose === "export" && !hasNotenbuchRight(perms, EXPORT)) return [];
  const all = purpose === "export" || hasNotenbuchRight(perms, TERM_VIEW);
  const led = all ? [] : await ledClasses(db, perms);
  if (!all && !led.length) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.kind, "klasse"), isNull(groups.archivedAt), all ? undefined : inArray(groups.id, led)))
    .orderBy(de(groups.name));
}

export interface TermSelection {
  schoolYearId: string;
  term: number;
}

/**
 * CSV-Export der Halbjahreswerte einer Klasse für die Schulverwaltungssoftware (P5-13): je Schüler:in und Fach die
 * **festgelegte** Note (sonst leer, Status „offen“) – nie Teilnoten, Spalten, Kommentare oder Vorschläge. Nur mit
 * `notenbuch.export`; jeder Export im Audit-Log (`notenbuch.export`). Kein Zeugnisdruck.
 */
export async function exportTermCsv(db: Db, perms: PermissionSet, groupId: string, sel: TermSelection, encodingRaw: string) {
  await assertTwoFactor(db, perms);
  if (!hasNotenbuchRight(perms, EXPORT)) throw new ForbiddenError(EXPORT);
  const [group] = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
  if (!group) throw new ForbiddenError(EXPORT);
  if (sel.term !== 1 && sel.term !== 2) throw new ValidationError({ term: "Halbjahr 1 oder 2 wählen" });
  const [year] = await db.select({ id: schoolYears.id, name: schoolYears.name }).from(schoolYears).where(eq(schoolYears.id, sel.schoolYearId));
  if (!year) throw new ValidationError({ schoolYearId: "Schuljahr wählen" });
  const encoding: CsvEncoding = (CSV_ENCODINGS as readonly string[]).includes(encodingRaw) ? (encodingRaw as CsvEncoding) : "utf8";
  const students = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(users.role, "schueler")))
    .orderBy(de(users.lastName), de(users.firstName));
  const grades = students.length
    ? await db
        .select({
          studentId: notenbuchTermGrades.studentId,
          subjectId: notenbuchBooks.subjectId,
          subjectName: subjects.name,
          groupName: groups.name,
          final: notenbuchTermGrades.final,
        })
        .from(notenbuchTermGrades)
        .innerJoin(notenbuchBooks, eq(notenbuchBooks.id, notenbuchTermGrades.bookId))
        .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
        .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
        .where(
          and(
            eq(notenbuchBooks.schoolYearId, sel.schoolYearId),
            eq(notenbuchBooks.term, sel.term),
            inArray(
              notenbuchTermGrades.studentId,
              students.map((s) => s.id),
            ),
          ),
        )
        .orderBy(de(subjects.name))
    : [];
  const header = ["Klasse", "Nachname", "Vorname", "Fach", "Fachkürzel", "Lerngruppe", "Schuljahr", "Halbjahr", "Note", "Status"];
  const rows: string[][] = [];
  for (const s of students)
    for (const g of grades.filter((x) => x.studentId === s.id))
      rows.push([group.name, s.lastName, s.firstName, g.subjectName, g.subjectId, g.groupName, year.name, String(sel.term), g.final ?? "", g.final ? "festgelegt" : "offen"]);
  const body = csvBytes([header, ...rows], encoding);
  await audit(db, perms.userId, "notenbuch.export", `klasse:${groupId}`, { schuljahr: sel.schoolYearId, halbjahr: sel.term, zeilen: rows.length, kodierung: encoding });
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { filename: `halbjahreswerte-${slug(group.name)}-${slug(year.name)}-hj${sel.term}.csv`, body, encoding, count: rows.length };
}
