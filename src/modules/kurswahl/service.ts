// Kurswahlen (P4-60): Wahlverfahren mit Angeboten, Zielgruppe (Jahrgang, optional Klassen) und Wahl mit 1.–3. Wunsch.
// Wer wählt: je Verfahren die Eltern (für minderjährige Kinder) oder die Schüler:in selbst – Volljährige mit dem Kennzeichen
// „eigenständig“ wählen immer selbst (`majority.ts`, § 123 SchulG NRW wie DS-19). Familien sehen nur die eigene Wahl.
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import {
  gradeLevels,
  groupMembers,
  groups,
  kurswahlAngebote,
  kurswahlVerfahren,
  kurswahlWahlen,
  schoolYears,
  subjects,
  users,
  KURSWAHL_CHOOSERS,
  KURSWAHL_KINDS,
  type GroupKind,
  type KurswahlAngebot,
  type KurswahlChooser,
  type KurswahlKind,
  type KurswahlVerfahren,
  type KurswahlWahl,
} from "@/core/db/schema";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { LEVEL_LABELS } from "@/core/school/catalog";
import { childrenOf, isParentFor, isSelfResponsible, parentLinks, selfResponsibleIds } from "@/core/school/majority";
import { isCalendarDate, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";

export const MANAGE = "kurswahl.manage";
/**
 * SP-05 (Projektleitung 2026-10-19): nur lesen – Verfahren, Angebote, Teilnehmerzahlen, Nachfrage/Zuteilung je Angebot und die
 * übernommenen Gruppen, z. B. für die Stundenplanung (Lehraufträge aus der Kurswahl). Keine Wunschlisten oder Zuteilungen einzelner
 * Schüler:innen – die braucht die Lehrauftrags-Übernahme nicht (Datensparsamkeit). `kurswahl.manage` schließt das Lesen ein.
 */
export const VIEW = "kurswahl.view";

/** Darf Kurswahlen lesen (Verwaltungssicht ohne Personenebene)? `manage` oder `view`. */
export const canViewKurswahl = (perms: PermissionSet) => hasPermission(perms, MANAGE) || hasPermission(perms, VIEW);

export const KIND_LABEL: Record<KurswahlKind, string> = {
  wp1: "Wahlpflicht I",
  wp2: "Wahlpflicht II",
  religion_pp: "Religion / Praktische Philosophie",
  fremdsprache: "Fremdsprache",
  ag: "AG-Wahl",
  ef_fachwahl: "Fachwahl Oberstufe",
  sonstiges: "Sonstige Wahl",
};

/** Gruppenart der Gruppen, die bei der Übernahme entstehen */
export const KIND_GROUP: Record<KurswahlKind, GroupKind> = {
  wp1: "wahlpflicht",
  wp2: "wahlpflicht",
  religion_pp: "kurs",
  fremdsprache: "kurs",
  ag: "ag",
  ef_fachwahl: "kurs",
  sonstiges: "kurs",
};

export const CHOOSER_LABEL: Record<KurswahlChooser, string> = {
  eltern: "Eltern wählen (Volljährige selbst)",
  schueler: "Schüler:innen wählen",
};

export const RANK_LABEL = ["1. Wunsch", "2. Wunsch", "3. Wunsch"] as const;
export const rankLabel = (rank: number) => RANK_LABEL[rank - 1] ?? `${rank}. Wunsch`;

// ------------------------------------------------------------------ Verfahren

export type VerfahrenState = "geplant" | "offen" | "geschlossen" | "uebernommen";

/** Rein: Stand eines Verfahrens an `today`. */
export function verfahrenState(v: Pick<KurswahlVerfahren, "opensOn" | "closesOn" | "transferredAt">, today: string): VerfahrenState {
  if (v.transferredAt) return "uebernommen";
  if (today < v.opensOn) return "geplant";
  if (today > v.closesOn) return "geschlossen";
  return "offen";
}

export const STATE_LABEL: Record<VerfahrenState, string> = {
  geplant: "Wahl noch nicht offen",
  offen: "Wahl offen",
  geschlossen: "Wahl geschlossen",
  uebernommen: "in Gruppen übernommen",
};

export interface VerfahrenInput {
  title: string;
  kind: KurswahlKind;
  note: string | null;
  gradeLevel: number;
  classIds: string[];
  courseGrade: number;
  schoolYearId: string | null;
  opensOn: string;
  closesOn: string;
  choices: number;
  chooser: KurswahlChooser;
  parentConfirm: boolean;
  /** P4-67: Mindest- und Höchstzahl der Kurse je Person (Vorgabe 1/1 = ein Kurs) */
  minCourses?: number;
  maxCourses?: number;
}

/** P4-67: höchstens so viele Kurse je Person */
export const MAX_COURSES = 6;

async function checkVerfahren(db: Db, input: VerfahrenInput): Promise<Record<string, string>> {
  const fe: Record<string, string> = {};
  if (!input.title.trim()) fe.title = "Titel angeben";
  if (!KURSWAHL_KINDS.includes(input.kind)) fe.kind = "Art wählen";
  if (!KURSWAHL_CHOOSERS.includes(input.chooser)) fe.chooser = "Wählen: Eltern oder Schüler:innen";
  if (!Number.isInteger(input.choices) || input.choices < 1 || input.choices > 3) fe.choices = "1 bis 3 Wünsche";
  const minC = input.minCourses ?? 1;
  const maxC = input.maxCourses ?? 1;
  if (!Number.isInteger(minC) || minC < 1 || minC > MAX_COURSES) fe.minCourses = `1 bis ${MAX_COURSES} Kurse`;
  else if (!Number.isInteger(maxC) || maxC < minC || maxC > MAX_COURSES) fe.maxCourses = `Mindestens ${minC}, höchstens ${MAX_COURSES} Kurse`;
  const levels = new Set((await db.select({ level: gradeLevels.level }).from(gradeLevels)).map((l) => l.level));
  if (!levels.has(input.gradeLevel)) fe.gradeLevel = "Jahrgang wählen";
  if (!levels.has(input.courseGrade)) fe.courseGrade = "Jahrgang der Kurse wählen";
  if (!isCalendarDate(input.opensOn)) fe.opensOn = "Beginn angeben";
  if (!isCalendarDate(input.closesOn)) fe.closesOn = "Ende angeben";
  else if (isCalendarDate(input.opensOn) && input.closesOn < input.opensOn) fe.closesOn = "Das Ende liegt vor dem Beginn";
  if (input.schoolYearId) {
    const [y] = await db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, input.schoolYearId));
    if (!y) fe.schoolYearId = "Schuljahr wählen";
  }
  if (input.classIds.length) {
    const found = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(inArray(groups.id, input.classIds), eq(groups.kind, "klasse"), eq(groups.gradeLevel, input.gradeLevel), isNull(groups.archivedAt)));
    if (found.length !== new Set(input.classIds).size) fe.classIds = "Nur Klassen des gewählten Jahrgangs";
  }
  return fe;
}

const cleanVerfahren = (i: VerfahrenInput) => ({
  title: i.title.trim().slice(0, 120),
  kind: i.kind,
  note: i.note?.trim().slice(0, 2000) || null,
  gradeLevel: i.gradeLevel,
  classIds: [...new Set(i.classIds)],
  courseGrade: i.courseGrade,
  schoolYearId: i.schoolYearId || null,
  opensOn: i.opensOn,
  closesOn: i.closesOn,
  choices: i.choices,
  chooser: i.chooser,
  parentConfirm: i.chooser === "schueler" && i.parentConfirm,
  minCourses: i.minCourses ?? 1,
  maxCourses: i.maxCourses ?? 1,
});

export async function createVerfahren(db: Db, perms: PermissionSet, input: VerfahrenInput): Promise<string> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const fe = await checkVerfahren(db, input);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db.insert(kurswahlVerfahren).values(cleanVerfahren(input)).returning({ id: kurswahlVerfahren.id });
  await audit(db, perms.userId, "kurswahl.verfahren.create", row!.id, { title: input.title.trim(), kind: input.kind });
  return row!.id;
}

/** Ändern bis zur Übernahme. Zielgruppe und Anzahl der Wünsche nur, solange niemand gewählt hat. */
export async function updateVerfahren(db: Db, perms: PermissionSet, id: string, input: VerfahrenInput, today = toBerlinDate(new Date())): Promise<void> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const before = await getVerfahren(db, id);
  if (!before) throw new ValidationError({ title: "Dieses Wahlverfahren gibt es nicht mehr" });
  if (before.transferredAt) throw new ValidationError({ title: "Schon in Gruppen übernommen – nicht mehr änderbar" });
  const fe = await checkVerfahren(db, input);
  const next = cleanVerfahren(input);
  if (await hasChoices(db, id)) {
    if (next.gradeLevel !== before.gradeLevel || next.classIds.slice().sort().join() !== before.classIds.slice().sort().join()) fe.gradeLevel = "Es wurde schon gewählt – die Zielgruppe lässt sich nicht mehr ändern";
    if (next.choices !== before.choices) fe.choices = "Es wurde schon gewählt – die Anzahl der Wünsche lässt sich nicht mehr ändern";
    if (next.minCourses !== before.minCourses || next.maxCourses !== before.maxCourses) fe.maxCourses = "Es wurde schon gewählt – die Anzahl der Kurse lässt sich nicht mehr ändern";
  }
  // G4E-C04: Zuteilungen von Hand (ohne Wahl) liegen schon auf höheren Plätzen – darunter senken hieße: unsichtbar, nicht mehr
  // aufhebbar und bei der Übernahme trotzdem in Gruppen
  const above = await db
    .select({ place: kurswahlWahlen.place, manual: kurswahlWahlen.manual, submittedAt: kurswahlWahlen.submittedAt })
    .from(kurswahlWahlen)
    .where(and(eq(kurswahlWahlen.verfahrenId, id), gt(kurswahlWahlen.place, next.maxCourses)));
  const held = above.filter((w) => w.manual || w.submittedAt);
  if (!fe.maxCourses && held.length)
    fe.maxCourses = `Es gibt schon Zuteilungen von Hand für Kurs ${Math.max(...held.map((w) => w.place))} – erst dort aufheben, dann die Höchstzahl senken`;
  // G4E-C06: mehr Pflicht-Kurse als Angebote – während der Wahl könnte niemand mehr abgeben
  const offerCount = (await db.select({ id: kurswahlAngebote.id }).from(kurswahlAngebote).where(eq(kurswahlAngebote.verfahrenId, id))).length;
  if (!fe.minCourses && offerCount > 0 && next.minCourses > offerCount && verfahrenState({ ...next, transferredAt: null }, today) === "offen")
    fe.minCourses = offerShortage(next, offerCount)!;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const target =
    next.gradeLevel !== before.gradeLevel ||
    next.classIds.slice().sort().join() !== before.classIds.slice().sort().join() ||
    next.choices !== before.choices ||
    next.minCourses !== before.minCourses ||
    next.maxCourses !== before.maxCourses;
  await db.transaction(async (tx) => {
    await tx.update(kurswahlVerfahren).set(next).where(eq(kurswahlVerfahren.id, id));
    // G4E-C04: leere Zeilen (aufgehobene Zuteilungen) über der neuen Höchstzahl gehen mit – nur solche gibt es hier noch
    if (above.length)
      await tx.delete(kurswahlWahlen).where(and(eq(kurswahlWahlen.verfahrenId, id), gt(kurswahlWahlen.place, next.maxCourses), eq(kurswahlWahlen.manual, false), isNull(kurswahlWahlen.submittedAt)));
    // G4D-C01: andere Zielgruppe bzw. Anzahl der Wünsche → die berechnete Zuteilung passt nicht mehr
    if (target) await invalidateAllocation(tx, id);
  });
  await audit(db, perms.userId, "kurswahl.verfahren.update", id, { title: next.title });
}

export async function deleteVerfahren(db: Db, perms: PermissionSet, id: string): Promise<void> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const [v] = await db.delete(kurswahlVerfahren).where(eq(kurswahlVerfahren.id, id)).returning({ title: kurswahlVerfahren.title });
  if (v) await audit(db, perms.userId, "kurswahl.verfahren.delete", id, { title: v.title });
}

export async function getVerfahren(db: Db, id: string): Promise<KurswahlVerfahren | null> {
  const [v] = await db.select().from(kurswahlVerfahren).where(eq(kurswahlVerfahren.id, id));
  return v ?? null;
}

export async function listVerfahren(db: Db, perms: PermissionSet): Promise<KurswahlVerfahren[]> {
  if (!canViewKurswahl(perms)) throw new ForbiddenError(VIEW);
  return db.select().from(kurswahlVerfahren).orderBy(desc(kurswahlVerfahren.closesOn), asc(kurswahlVerfahren.title));
}

/**
 * G4E-C06 (rein): Hinweis, wenn es weniger Angebote gibt als Kurse zu wählen sind – jeder Kurs darf nur einmal 1. Wunsch sein,
 * eine Abgabe wäre dann unmöglich. null = passt.
 */
export function offerShortage(v: Pick<KurswahlVerfahren, "minCourses">, offerCount: number): string | null {
  if (v.minCourses <= offerCount) return null;
  return `Es gibt ${offerCount === 1 ? "nur ein Angebot" : `nur ${offerCount} Angebote`}, gewählt werden müssen aber ${v.minCourses} Kurse – so kann niemand abgeben.`;
}

async function hasChoices(db: Db, verfahrenId: string): Promise<boolean> {
  const [w] = await db
    .select({ id: kurswahlWahlen.studentId })
    .from(kurswahlWahlen)
    .where(and(eq(kurswahlWahlen.verfahrenId, verfahrenId), sql`${kurswahlWahlen.submittedAt} is not null`))
    .limit(1);
  return Boolean(w);
}

/**
 * G4D-C01: Wahlen, Angebote oder Zielgruppe haben sich nach der Berechnung geändert – die gespeicherte Zuteilung verwerfen
 * (`allocatedAt` leer, berechnete Kurse weg; von Hand Zugeteilte und der Seed bleiben). Die Übernahme verlangt dann eine
 * neue Berechnung. Nach der Übernahme ändert sich nichts mehr.
 */
export async function invalidateAllocation(db: Db, verfahrenId: string): Promise<boolean> {
  const [v] = await db
    .update(kurswahlVerfahren)
    .set({ allocatedAt: null })
    .where(and(eq(kurswahlVerfahren.id, verfahrenId), isNotNull(kurswahlVerfahren.allocatedAt), isNull(kurswahlVerfahren.transferredAt)))
    .returning({ id: kurswahlVerfahren.id });
  if (!v) return false;
  await db
    .update(kurswahlWahlen)
    .set({ assignedId: null, assignedRank: null, reason: null })
    .where(and(eq(kurswahlWahlen.verfahrenId, verfahrenId), eq(kurswahlWahlen.manual, false)));
  return true;
}

// ------------------------------------------------------------------ Angebote

export interface AngebotInput {
  title: string;
  subjectId: string | null;
  level: string | null;
  minSize: number;
  maxSize: number | null;
  note: string | null;
  teacherId: string | null;
  hours: number | null;
}

async function checkAngebot(db: Db, input: AngebotInput): Promise<Record<string, string>> {
  const fe: Record<string, string> = {};
  if (!input.title.trim()) fe.title = "Titel angeben";
  if (!Number.isInteger(input.minSize) || input.minSize < 0 || input.minSize > 200) fe.minSize = "Mindestgröße 0 bis 200";
  if (input.maxSize != null && (!Number.isInteger(input.maxSize) || input.maxSize < 1 || input.maxSize > 500)) fe.maxSize = "Höchstzahl 1 bis 500 oder leer";
  else if (input.maxSize != null && input.maxSize < input.minSize) fe.maxSize = "Höchstzahl unter der Mindestgröße";
  if (input.hours != null && (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 12)) fe.hours = "1 bis 12 Wochenstunden oder leer";
  if (input.level && !(input.level in LEVEL_LABELS)) fe.level = "Unbekanntes Niveau";
  if (input.subjectId) {
    const [s] = await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, input.subjectId));
    if (!s) fe.subjectId = "Unbekanntes Fach";
  }
  if (input.teacherId) {
    const [t] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.teacherId), eq(users.role, "lehrkraft"), eq(users.status, "active")));
    if (!t) fe.teacherId = "Lehrkraft wählen";
  }
  return fe;
}

const cleanAngebot = (i: AngebotInput) => ({
  title: i.title.trim().slice(0, 120),
  subjectId: i.subjectId || null,
  level: i.level || null,
  minSize: i.minSize,
  maxSize: i.maxSize ?? null,
  note: i.note?.trim().slice(0, 1000) || null,
  teacherId: i.teacherId || null,
  hours: i.hours ?? null,
});

async function editable(db: Db, perms: PermissionSet, verfahrenId: string): Promise<KurswahlVerfahren> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const v = await getVerfahren(db, verfahrenId);
  if (!v) throw new ValidationError({ title: "Dieses Wahlverfahren gibt es nicht mehr" });
  if (v.transferredAt) throw new ValidationError({ title: "Schon in Gruppen übernommen – nicht mehr änderbar" });
  return v;
}

export async function createAngebot(db: Db, perms: PermissionSet, verfahrenId: string, input: AngebotInput): Promise<string> {
  await editable(db, perms, verfahrenId);
  const fe = await checkAngebot(db, input);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [last] = await db
    .select({ n: kurswahlAngebote.sortOrder })
    .from(kurswahlAngebote)
    .where(eq(kurswahlAngebote.verfahrenId, verfahrenId))
    .orderBy(desc(kurswahlAngebote.sortOrder))
    .limit(1);
  const [row] = await db
    .insert(kurswahlAngebote)
    .values({ ...cleanAngebot(input), verfahrenId, sortOrder: (last?.n ?? 0) + 1 })
    .returning({ id: kurswahlAngebote.id });
  // G4D-C01: ein neues Angebot war bei der Berechnung nicht dabei
  await invalidateAllocation(db, verfahrenId);
  await audit(db, perms.userId, "kurswahl.angebot.create", verfahrenId, { title: input.title.trim() });
  return row!.id;
}

export async function updateAngebot(db: Db, perms: PermissionSet, angebotId: string, input: AngebotInput): Promise<void> {
  const a = await getAngebot(db, angebotId);
  if (!a) throw new ValidationError({ title: "Dieses Angebot gibt es nicht mehr" });
  await editable(db, perms, a.verfahrenId);
  const fe = await checkAngebot(db, input);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const next = cleanAngebot(input);
  await db.transaction(async (tx) => {
    await tx.update(kurswahlAngebote).set(next).where(eq(kurswahlAngebote.id, angebotId));
    // G4D-C01: andere Kapazität → die berechnete Zuteilung passt nicht mehr
    if (next.minSize !== a.minSize || next.maxSize !== a.maxSize) await invalidateAllocation(tx, a.verfahrenId);
  });
  await audit(db, perms.userId, "kurswahl.angebot.update", a.verfahrenId, { title: input.title.trim() });
}

/** Löschen nimmt das Angebot auch aus allen abgegebenen Wünschen (die Wahl ist dann ggf. unvollständig). */
export async function deleteAngebot(db: Db, perms: PermissionSet, angebotId: string, today = toBerlinDate(new Date())): Promise<void> {
  const a = await getAngebot(db, angebotId);
  if (!a) return;
  const v = await editable(db, perms, a.verfahrenId);
  // G4E-C06: während der Wahl nicht unter die Mindestzahl der Kurse – sonst könnte niemand mehr abgeben
  if (verfahrenState(v, today) === "offen") {
    const left = (await db.select({ id: kurswahlAngebote.id }).from(kurswahlAngebote).where(eq(kurswahlAngebote.verfahrenId, v.id))).length - 1;
    const short = offerShortage(v, left);
    if (short) throw new ValidationError({ title: `Die Wahl läuft – ${short}` });
  }
  await db.transaction(async (tx) => {
    await tx
      .update(kurswahlWahlen)
      .set({ choices: sql`array_remove(${kurswahlWahlen.choices}, ${angebotId})` })
      .where(and(eq(kurswahlWahlen.verfahrenId, a.verfahrenId), sql`${angebotId} = any(${kurswahlWahlen.choices})`));
    // G4D-C08: von Hand diesem Angebot Zugeteilte sind wieder offen (sonst blieben sie dauerhaft „von Hand“ ohne Kurs)
    await tx
      .update(kurswahlWahlen)
      .set({ assignedId: null, assignedRank: null, manual: false, reason: `Angebot „${a.title}“ gelöscht – bei der nächsten Zuteilung neu`.slice(0, 200) })
      .where(and(eq(kurswahlWahlen.verfahrenId, a.verfahrenId), eq(kurswahlWahlen.assignedId, angebotId), eq(kurswahlWahlen.manual, true)));
    await invalidateAllocation(tx, a.verfahrenId);
    await tx.delete(kurswahlAngebote).where(eq(kurswahlAngebote.id, angebotId));
  });
  await audit(db, perms.userId, "kurswahl.angebot.delete", a.verfahrenId, { title: a.title });
}

export async function getAngebot(db: Db, id: string): Promise<KurswahlAngebot | null> {
  const [a] = await db.select().from(kurswahlAngebote).where(eq(kurswahlAngebote.id, id));
  return a ?? null;
}

export interface AngebotView extends KurswahlAngebot {
  subjectName: string | null;
  color: string | null;
  teacherName: string | null;
}

export async function listAngebote(db: Db, verfahrenId: string): Promise<AngebotView[]> {
  const rows = await db
    .select({ a: kurswahlAngebote, subjectName: subjects.name, color: subjects.color, teacherName: users.name })
    .from(kurswahlAngebote)
    .leftJoin(subjects, eq(subjects.id, kurswahlAngebote.subjectId))
    .leftJoin(users, eq(users.id, kurswahlAngebote.teacherId))
    .where(eq(kurswahlAngebote.verfahrenId, verfahrenId))
    .orderBy(asc(kurswahlAngebote.sortOrder), de(kurswahlAngebote.title));
  return rows.map((r) => ({ ...r.a, subjectName: r.subjectName, color: r.color, teacherName: r.teacherName }));
}

/** Anzahl der Wünsche, die eine Wahl braucht: wie eingestellt, höchstens so viele wie Angebote. */
export const neededChoices = (v: Pick<KurswahlVerfahren, "choices">, offers: number) => Math.min(v.choices, offers);

// ------------------------------------------------------------------ Zielgruppe

export interface TargetStudent {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  classId: string;
  className: string;
}

/** Schüler:innen der Zielgruppe: aktive Konten in den (nicht archivierten) Klassen des Jahrgangs bzw. den gewählten Klassen. */
export async function targetStudents(db: Db, v: Pick<KurswahlVerfahren, "gradeLevel" | "classIds">): Promise<TargetStudent[]> {
  const conds = [eq(groups.kind, "klasse"), eq(groups.gradeLevel, v.gradeLevel), isNull(groups.archivedAt), eq(users.role, "schueler"), eq(users.status, "active")];
  if (v.classIds.length) conds.push(inArray(groups.id, v.classIds));
  const rows = await db
    .select({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName, classId: groups.id, className: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(...conds))
    .orderBy(de(groups.name), de(users.lastName), de(users.firstName));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).map((r) => ({ ...r, className: r.className.replace(/^Klasse /, "") }));
}

/** Klassen eines Jahrgangs (Auswahl der Zielgruppe). */
export async function classesOfGrade(db: Db, gradeLevel: number) {
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.kind, "klasse"), eq(groups.gradeLevel, gradeLevel), isNull(groups.archivedAt)))
    .orderBy(de(groups.name));
}

export async function isTarget(db: Db, v: KurswahlVerfahren, studentId: string): Promise<boolean> {
  return (await targetStudents(db, v)).some((s) => s.id === studentId);
}

// ------------------------------------------------------------------ Wer wählt

export type WahlRole = "waehlt" | "bestaetigt" | "liest";

/**
 * Rolle von `perms` bei der Wahl für dieses Kind: wählt (gibt ab), bestätigt (Eltern-Häkchen) oder liest nur
 * (z. B. das Kind, wenn die Eltern wählen; informierte Eltern eigenständiger Schüler:innen). null = gar nicht beteiligt.
 */
export async function roleFor(db: Db, perms: PermissionSet, v: KurswahlVerfahren, studentId: string): Promise<WahlRole | null> {
  const self = await isSelfResponsible(db, studentId);
  if (perms.role === "schueler") {
    if (perms.userId !== studentId) return null;
    if (self || v.chooser === "schueler") return "waehlt";
    return "liest";
  }
  if (perms.role === "eltern") {
    if (await isParentFor(db, perms.userId, studentId, "act")) {
      if (v.chooser === "eltern") return "waehlt";
      return v.parentConfirm ? "bestaetigt" : "liest";
    }
    if (await isParentFor(db, perms.userId, studentId, "inform")) return "liest";
  }
  return null;
}

/** Kinder bzw. die eigene Person, die bei Kurswahlen in Frage kommen (Eltern: auch informierte, nur lesend). */
export async function familyStudents(db: Db, perms: PermissionSet): Promise<{ id: string; name: string; firstName: string }[]> {
  if (perms.role === "eltern") {
    const kids = await childrenOf(db, perms.userId, "inform");
    return kids.sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  if (perms.role === "schueler") {
    const [me] = await db.select({ id: users.id, name: users.name, firstName: users.firstName }).from(users).where(eq(users.id, perms.userId));
    return me ? [me] : [];
  }
  return [];
}

export interface FamilyItem {
  verfahren: KurswahlVerfahren;
  state: VerfahrenState;
  student: { id: string; name: string; firstName: string };
  role: WahlRole;
  /** Zeile des 1. Platzes (Abgabe, Bestätigung) */
  wahl: KurswahlWahl | null;
  /** P4-67: alle Plätze, 1. zuerst */
  places: KurswahlWahl[];
}

/** Verfahren, die die Familie betreffen (ab Beginn des Wahlzeitraums), je Kind mit Rolle und eigener Wahl. */
export async function familyOverview(db: Db, perms: PermissionSet, today: string): Promise<FamilyItem[]> {
  const students = await familyStudents(db, perms);
  if (students.length === 0) return [];
  const all = await db.select().from(kurswahlVerfahren).orderBy(desc(kurswahlVerfahren.closesOn));
  const out: FamilyItem[] = [];
  for (const v of all) {
    const state = verfahrenState(v, today);
    if (state === "geplant") continue;
    const target = new Set((await targetStudents(db, v)).map((s) => s.id));
    for (const s of students) {
      if (!target.has(s.id)) continue;
      const role = await roleFor(db, perms, v, s.id);
      if (!role) continue;
      const places = await getWahlPlaces(db, v.id, s.id);
      out.push({ verfahren: v, state, student: s, role, wahl: places.find((w) => w.place === 1) ?? null, places });
    }
  }
  return out;
}

/** Zeile des 1. Platzes (Abgabe, Bestätigung, Wünsche bzw. Zuteilung bei einem Kurs je Person). */
export async function getWahl(db: Db, verfahrenId: string, studentId: string): Promise<KurswahlWahl | null> {
  const [w] = await db
    .select()
    .from(kurswahlWahlen)
    .where(and(eq(kurswahlWahlen.verfahrenId, verfahrenId), eq(kurswahlWahlen.studentId, studentId), eq(kurswahlWahlen.place, 1)));
  return w ?? null;
}

/** P4-67: alle Plätze einer Person (1. zuerst). */
export async function getWahlPlaces(db: Db, verfahrenId: string, studentId: string): Promise<KurswahlWahl[]> {
  return db
    .select()
    .from(kurswahlWahlen)
    .where(and(eq(kurswahlWahlen.verfahrenId, verfahrenId), eq(kurswahlWahlen.studentId, studentId)))
    .orderBy(asc(kurswahlWahlen.place));
}

/** Eltern, die eine Wahl bestätigen sollen (nur `parentConfirm`, nur Minderjährige). */
async function confirmingParents(db: Db, v: KurswahlVerfahren, studentId: string): Promise<string[]> {
  if (v.chooser !== "schueler" || !v.parentConfirm) return [];
  if (await isSelfResponsible(db, studentId)) return [];
  return (await parentLinks(db, [studentId], "act")).map((l) => l.parentId);
}

/**
 * Wahl abgeben bzw. ändern (im Wahlzeitraum; die Verwaltung auch danach bis zur Übernahme). `choices` = Angebots-IDs in
 * der Reihenfolge der Wünsche, verschieden, genau so viele wie verlangt. Eine Änderung hebt eine Eltern-Bestätigung auf.
 */
export async function submitChoice(db: Db, perms: PermissionSet, verfahrenId: string, studentId: string, choices: readonly string[], today: string, now = new Date()): Promise<void> {
  return submitChoices(db, perms, verfahrenId, studentId, [choices], today, now);
}

/** Rein: Plätze einer Abgabe prüfen (P4-67) – leere Plätze am Ende zählen nicht; Fehlertext oder die bereinigten Plätze. */
export function checkPlaces(
  v: Pick<KurswahlVerfahren, "minCourses" | "maxCourses">,
  need: number,
  ids: ReadonlySet<string>,
  places: readonly (readonly string[])[],
): { error: string } | { places: string[][] } {
  const list = places.map((p) => p.filter((c) => c !== ""));
  while (list.length && list[list.length - 1]!.length === 0) list.pop();
  const multi = v.maxCourses > 1;
  // G4E-C06: zu wenige Angebote für die Mindestzahl – verständlich statt „jeden Kurs nur einmal als 1. Wunsch“
  if (ids.size > 0 && ids.size < v.minCourses) return { error: `Es gibt weniger Angebote als Kurse zu wählen sind – bitte an die Schule wenden` };
  const single = need === 1 ? "Bitte einen Wunsch wählen" : `Bitte ${need} verschiedene Wünsche wählen`;
  const wish = need === 1 ? "einen Wunsch" : `${need} verschiedene Wünsche`;
  if (list.length === 0 || list.length < v.minCourses) return { error: multi ? `Bitte mindestens ${v.minCourses} ${v.minCourses === 1 ? "Kurs" : "Kurse"} wählen` : single };
  if (list.length > v.maxCourses) return { error: `Höchstens ${v.maxCourses} ${v.maxCourses === 1 ? "Kurs" : "Kurse"}` };
  for (const [i, p] of list.entries()) {
    if (p.length !== need) return { error: multi ? `Kurs ${i + 1}: bitte ${wish} wählen` : single };
    if (new Set(p).size !== p.length) return { error: multi ? `Kurs ${i + 1}: jedes Angebot nur einmal wählen` : "Jedes Angebot nur einmal wählen" };
    if (p.some((c) => !ids.has(c))) return { error: "Unbekanntes Angebot" };
  }
  // denselben Kurs gibt es nie zweimal – die 1. Wünsche der Plätze müssen sich unterscheiden
  const firsts = list.map((p) => p[0]!);
  if (new Set(firsts).size !== firsts.length) return { error: "Jeden Kurs nur einmal als 1. Wunsch – niemand bekommt einen Kurs doppelt" };
  return { places: list };
}

/**
 * P4-67: Wahl mit mehreren Plätzen (Mindest-/Höchstzahl der Kurse, je Platz eigene Wünsche). Ein Platz = eine Zeile; Plätze,
 * die wegfallen, verschwinden (von Hand Zugeteilte bleiben, nur ohne Wünsche).
 */
export async function submitChoices(
  db: Db,
  perms: PermissionSet,
  verfahrenId: string,
  studentId: string,
  places: readonly (readonly string[])[],
  today: string,
  now = new Date(),
): Promise<void> {
  const v = await getVerfahren(db, verfahrenId);
  if (!v) throw new ValidationError({ choices: "Dieses Wahlverfahren gibt es nicht mehr" });
  const manage = hasPermission(perms, MANAGE);
  const role = await roleFor(db, perms, v, studentId);
  if (role !== "waehlt" && !manage) throw new ForbiddenError("kurswahl.choose");
  const state = verfahrenState(v, today);
  if (state === "uebernommen") throw new ValidationError({ choices: "Die Kurse sind schon eingeteilt" });
  if (state !== "offen" && !manage) throw new ValidationError({ choices: state === "geplant" ? "Die Wahl ist noch nicht offen" : "Die Wahl ist geschlossen" });
  if (!(await isTarget(db, v, studentId))) throw new ValidationError({ choices: "Diese Wahl gilt nicht für diese Schüler:in" });
  const offers = await db.select({ id: kurswahlAngebote.id }).from(kurswahlAngebote).where(eq(kurswahlAngebote.verfahrenId, verfahrenId));
  const checked = checkPlaces(v, neededChoices(v, offers.length), new Set(offers.map((o) => o.id)), places);
  if ("error" in checked) throw new ValidationError({ choices: checked.error });
  const list = checked.places;
  const before = await getWahlPlaces(db, verfahrenId, studentId);
  const was = before.filter((w) => w.submittedAt && w.choices.length).map((w) => w.choices.join());
  const changed = !before.some((w) => w.submittedAt) || was.join("|") !== list.map((p) => p.join()).join("|");
  const confirm = changed ? { confirmedBy: null, confirmedAt: null } : {};
  await db.transaction(async (tx) => {
    // sperrt das Verfahren gegen eine gleichzeitige Übernahme (die belegt dieselbe Zeile)
    const [locked] = await tx.select({ transferredAt: kurswahlVerfahren.transferredAt }).from(kurswahlVerfahren).where(eq(kurswahlVerfahren.id, verfahrenId)).for("update");
    if (!locked || locked.transferredAt) throw new ValidationError({ choices: "Die Kurse sind schon eingeteilt" });
    for (const [i, choices] of list.entries()) {
      await tx
        .insert(kurswahlWahlen)
        .values({ verfahrenId, studentId, place: i + 1, choices, submittedBy: perms.userId, submittedAt: now })
        .onConflictDoUpdate({
          target: [kurswahlWahlen.verfahrenId, kurswahlWahlen.studentId, kurswahlWahlen.place],
          set: { choices, submittedBy: perms.userId, submittedAt: now, ...confirm },
        });
    }
    // weggefallene Plätze: ohne Zuteilung von Hand löschen, sonst nur die Wünsche leeren
    for (const w of before.filter((x) => x.place > list.length)) {
      const where = and(eq(kurswahlWahlen.verfahrenId, verfahrenId), eq(kurswahlWahlen.studentId, studentId), eq(kurswahlWahlen.place, w.place));
      if (w.manual) await tx.update(kurswahlWahlen).set({ choices: [], submittedBy: perms.userId, submittedAt: now, ...confirm }).where(where);
      else await tx.delete(kurswahlWahlen).where(where);
    }
    // G4D-C01: neue bzw. geänderte Wünsche machen eine schon berechnete Zuteilung ungültig
    if (changed) await invalidateAllocation(tx, verfahrenId);
  });
  await audit(db, perms.userId, "kurswahl.choose", verfahrenId, { by: role === "waehlt" ? perms.role : "verwaltung", changed, ...(list.length > 1 ? { kurse: list.length } : {}) });
  if (changed && role === "waehlt") {
    const parents = await confirmingParents(db, v, studentId);
    const [s] = await db.select({ name: users.name }).from(users).where(eq(users.id, studentId));
    await notify(db, parents, { moduleId: "kurswahl", title: `Kurswahl bestätigen: ${s?.name ?? "Ihr Kind"}`, body: `${v.title} – bitte die Wünsche ansehen und bestätigen.`, href: "/kurswahl" });
  }
}

/** Eltern bestätigen die Wahl ihres minderjährigen Kindes (Häkchen). */
export async function confirmChoice(db: Db, perms: PermissionSet, verfahrenId: string, studentId: string, today: string, now = new Date()): Promise<void> {
  const v = await getVerfahren(db, verfahrenId);
  if (!v) throw new ValidationError({ confirm: "Dieses Wahlverfahren gibt es nicht mehr" });
  if ((await roleFor(db, perms, v, studentId)) !== "bestaetigt") throw new ForbiddenError("kurswahl.confirm");
  if (verfahrenState(v, today) !== "offen") throw new ValidationError({ confirm: "Die Wahl ist nicht offen" });
  const w = await getWahl(db, verfahrenId, studentId);
  if (!w?.submittedAt) throw new ValidationError({ confirm: "Ihr Kind hat noch nicht gewählt" });
  await db
    .update(kurswahlWahlen)
    .set({ confirmedBy: perms.userId, confirmedAt: now })
    .where(and(eq(kurswahlWahlen.verfahrenId, verfahrenId), eq(kurswahlWahlen.studentId, studentId)));
  await audit(db, perms.userId, "kurswahl.confirm", verfahrenId, {});
}

// ------------------------------------------------------------------ Übersicht für die Verwaltung

export interface WahlRow {
  student: TargetStudent;
  /** Zeile des 1. Platzes */
  wahl: KurswahlWahl | null;
  /** P4-67: alle Plätze, 1. zuerst */
  places: KurswahlWahl[];
  /** Eigenständig (volljährig) – wählt selbst */
  selfResponsible: boolean;
}

/** Alle Personen der Zielgruppe mit ihrer Wahl (nur `kurswahl.manage`). Wahlen außerhalb der Zielgruppe hängen hinten an. */
export async function wahlRows(db: Db, perms: PermissionSet, v: KurswahlVerfahren): Promise<WahlRow[]> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const [target, wahlen] = await Promise.all([targetStudents(db, v), db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.verfahrenId, v.id))]);
  const byStudent = new Map(wahlen.filter((w) => w.place === 1).map((w) => [w.studentId, w]));
  const placesOf = (id: string) => wahlen.filter((w) => w.studentId === id).sort((a, b) => a.place - b.place);
  const self = await selfResponsibleIds(
    db,
    target.map((t) => t.id),
  );
  const rows: WahlRow[] = target.map((s) => ({ student: s, wahl: byStudent.get(s.id) ?? null, places: placesOf(s.id), selfResponsible: self.has(s.id) }));
  const known = new Set(target.map((t) => t.id));
  const extra = [...new Map(wahlen.filter((w) => !known.has(w.studentId)).map((w) => [w.studentId, w])).values()];
  if (extra.length) {
    const people = await db
      .select({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(
        inArray(
          users.id,
          extra.map((w) => w.studentId),
        ),
      );
    for (const p of people) rows.push({ student: { ...p, classId: "", className: "–" }, wahl: byStudent.get(p.id) ?? null, places: placesOf(p.id), selfResponsible: false });
  }
  return rows;
}

/** Wer an Stelle der Familie gefragt ist, für diese Kinder zu wählen (Gong „Erinnerung“). */
export async function choosersOf(db: Db, v: KurswahlVerfahren, studentIds: readonly string[]): Promise<string[]> {
  if (studentIds.length === 0) return [];
  const self = await selfResponsibleIds(db, studentIds);
  const minors = studentIds.filter((s) => !self.has(s));
  const others = v.chooser === "schueler" ? minors : (await parentLinks(db, minors, "act")).map((l) => l.parentId);
  return [...new Set([...self, ...others])];
}
