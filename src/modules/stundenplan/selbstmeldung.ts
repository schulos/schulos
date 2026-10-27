// P4-74: Lehrkräfte melden die eigene Abwesenheit selbst – „krank“ und „sonstiger Grund“ wirken sofort (offene Stunden für die
// Planung), Fortbildung und dienstliche Abwesenheit sind ein Antrag, den die Schulleitung genehmigt (I-26, Recht
// `stundenplan.absence_approve`). Q5-12 (I-18): je betroffener Stunde Vertretungsmaterial (Text und/oder Datei) für die Vertretung,
// die Planung und – nur mit Häkchen – die Schüler:innen der Gruppe. Der Grund steht nie in einem Gong (Gesundheitsbezug bei „krank“).
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { dayOffOn } from "@/core/school/calendar";
import {
  groupMembers,
  groups,
  subjects,
  timetableAbsenceMaterials,
  timetableAbsences,
  timetableLessons,
  timetableSubstitutions,
  users,
  type TimetableAbsence,
  type TimetableAbsenceMaterial,
} from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { addDays, isCalendarDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { absenceCovers, ABSENCE_LABELS, createAbsence, flagAfterAbsenceEnd } from "./abwesenheit";
import { lessonActiveOn, listSlots, type LessonSlot } from "./service";

/** SP-02: Vertretungsplanung (Tagesgeschäft) – bekommt Selbstmeldungen und sieht/pflegt das Material */
export const SUBSTITUTE = "stundenplan.substitute";
export const APPROVE = "stundenplan.absence_approve";
/** Gründe, die eine Lehrkraft selbst melden kann (feste Liste, bei Krankheit nur „krank“) */
export const SELF_REASONS = ["krank", "fortbildung", "dienstlich", "sonstiges"] as const;
export type SelfReason = (typeof SELF_REASONS)[number];
/** I-26: diese Gründe brauchen die Genehmigung der Schulleitung */
export const NEEDS_APPROVAL: ReadonlySet<string> = new Set(["fortbildung", "dienstlich"]);
/** längster Zeitraum einer Selbstmeldung (Tage) – längere Abwesenheiten trägt die Planung ein */
export const MAX_SELF_DAYS = 14;
export const MATERIAL_TEXT_MAX = 2000;
export const MATERIAL_FILE_MAX = 25 * 1024 * 1024;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ddmm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.`;
/** „15.10.“ bzw. „15.10.–17.10.“, dazu Stunden */
export function spanText(a: Pick<TimetableAbsence, "startsOn" | "endsOn" | "fromPeriod" | "toPeriod">): string {
  const days = a.startsOn === a.endsOn ? ddmm(a.startsOn) : `${ddmm(a.startsOn)}–${ddmm(a.endsOn)}`;
  if (a.fromPeriod === null || a.toPeriod === null) return days;
  return `${days}, ${a.fromPeriod === a.toPeriod ? `${a.fromPeriod}.` : `${a.fromPeriod}.–${a.toPeriod}.`} Std.`;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface SelfReportInput {
  startsOn: string;
  endsOn: string;
  fromPeriod: number | null;
  toPeriod: number | null;
  reason: string;
  note: string | null;
}

async function teacherLabel(db: Db, id: string): Promise<string> {
  const [u] = await db.select({ name: users.name, code: users.shortCode }).from(users).where(eq(users.id, id));
  return u ? (u.code ? `${u.name} (${u.code})` : u.name) : "Eine Lehrkraft";
}

async function notifyPlanners(
  db: Db,
  a: Pick<TimetableAbsence, "teacherId" | "startsOn" | "endsOn" | "fromPeriod" | "toPeriod">,
  title: string,
): Promise<void> {
  const ids = (await usersWithPermission(db, SUBSTITUTE)).filter((id) => id !== a.teacherId);
  await notify(db, ids, {
    moduleId: "stundenplan",
    title: `${title}: ${await teacherLabel(db, a.teacherId!)}`,
    body: `${spanText(a)} – Vertretung planen`,
    href: `/planung/vertretungen?datum=${a.startsOn}`,
  });
}

/**
 * Eigene Abwesenheit melden (nur Lehrkräfte). Ab heute, höchstens 14 Tage; keine Überschneidung mit einer eigenen offenen bzw.
 * wirksamen Meldung; bei „krank“ keine Ergänzung (Gesundheitsdaten). Gibt Kennung und Stand zurück.
 */
export async function reportOwnAbsence(
  db: Db,
  perms: PermissionSet,
  input: SelfReportInput,
  today: string,
): Promise<{ id: string; status: "aktiv" | "beantragt" }> {
  if (perms.role !== "lehrkraft") throw new ForbiddenError("stundenplan.self_absence");
  const fe: Record<string, string> = {};
  if (!(SELF_REASONS as readonly string[]).includes(input.reason)) fe.reason = "Grund wählen";
  // G4E-C07: Datum vor der ersten Abfrage prüfen – leer bzw. „2026-02-30“ ergäbe sonst einen Datenbankfehler (500)
  if (!isCalendarDate(input.startsOn)) fe.startsOn = "Datum angeben";
  if (!isCalendarDate(input.endsOn)) fe.endsOn = "Datum angeben";
  else if (isCalendarDate(input.startsOn) && input.endsOn < input.startsOn) fe.endsOn = "Ende liegt vor dem Beginn";
  if (YMD.test(input.startsOn) && input.startsOn < today) fe.startsOn = "Rückwirkend trägt die Vertretungsplanung ein";
  if (YMD.test(input.startsOn) && YMD.test(input.endsOn) && dayDiff(input.startsOn, input.endsOn) >= MAX_SELF_DAYS)
    fe.endsOn = `Höchstens ${MAX_SELF_DAYS} Tage – längere Abwesenheiten trägt die Vertretungsplanung ein`;
  if (input.reason === "krank" && input.note?.trim()) fe.note = "Bei „krank“ bitte keine Ergänzung (keine Angaben zur Gesundheit)";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const overlap = await db
    .select({ id: timetableAbsences.id, fromPeriod: timetableAbsences.fromPeriod, toPeriod: timetableAbsences.toPeriod })
    .from(timetableAbsences)
    .where(
      and(
        eq(timetableAbsences.teacherId, perms.userId),
        ne(timetableAbsences.status, "abgelehnt"),
        lte(timetableAbsences.startsOn, input.endsOn),
        gte(timetableAbsences.endsOn, input.startsOn),
      ),
    );
  const clash = overlap.some(
    (o) => o.fromPeriod === null || input.fromPeriod === null || !(o.toPeriod! < input.fromPeriod || o.fromPeriod > (input.toPeriod ?? input.fromPeriod)),
  );
  if (clash) throw new ValidationError({ startsOn: "Für diesen Zeitraum ist schon eine Abwesenheit eingetragen" });
  const status = NEEDS_APPROVAL.has(input.reason) ? "beantragt" : "aktiv";
  const id = await createAbsence(db, perms.userId, { ...input, teacherId: perms.userId, groupId: null, status, selfReported: true });
  await audit(db, perms.userId, "stundenplan.absence.self", perms.userId, { from: input.startsOn, to: input.endsOn, status });
  const a = { teacherId: perms.userId, ...input };
  if (status === "aktiv") await notifyPlanners(db, a, "Abwesenheit gemeldet");
  else {
    const ids = (await usersWithPermission(db, APPROVE)).filter((x) => x !== perms.userId);
    await notify(db, ids, {
      moduleId: "stundenplan",
      title: `Antrag ${ABSENCE_LABELS[input.reason as SelfReason]}: ${await teacherLabel(db, perms.userId)}`,
      body: `${spanText(a)} – bitte genehmigen oder ablehnen`,
      href: "/stundenplan/abwesenheit#antraege",
    });
  }
  return { id, status };
}

/** Eigene Selbstmeldung zurückziehen: Anträge jederzeit, wirksame nur, solange sie noch nicht begonnen hat. */
export async function withdrawOwnAbsence(db: Db, perms: PermissionSet, id: string, today: string): Promise<void> {
  const [a] = await db.select().from(timetableAbsences).where(eq(timetableAbsences.id, id));
  if (!a || a.teacherId !== perms.userId || !a.selfReported) throw new ValidationError({ absence: "Diese Meldung gibt es nicht (mehr)" });
  if (a.status === "aktiv" && a.startsOn <= today)
    throw new ValidationError({ absence: "Die Abwesenheit hat schon begonnen – bitte die Vertretungsplanung ansprechen" });
  await db.delete(timetableAbsences).where(eq(timetableAbsences.id, id));
  // SP2-16b: schon eingetragene Vertretungen bleiben stehen und werden zur Prüfung markiert
  const flagged = await flagAfterAbsenceEnd(db, a, a.startsOn);
  await audit(db, perms.userId, "stundenplan.absence.withdraw", perms.userId, { from: a.startsOn, to: a.endsOn, flagged: flagged || undefined });
  if (a.status === "aktiv") await notifyPlanners(db, a, "Abwesenheit zurückgezogen");
}

/** I-26: Antrag genehmigen (wird wirksam, Gong an die Planung) oder ablehnen; Gong an die Lehrkraft. Eigene Anträge nicht. */
export async function decideAbsence(db: Db, perms: PermissionSet, id: string, approve: boolean, now = new Date()): Promise<void> {
  if (!hasPermission(perms, APPROVE)) throw new ForbiddenError(APPROVE);
  const [a] = await db.select().from(timetableAbsences).where(eq(timetableAbsences.id, id));
  if (!a || a.status !== "beantragt") throw new ValidationError({ absence: "Dieser Antrag ist schon entschieden oder zurückgezogen" });
  if (a.teacherId === perms.userId) throw new ValidationError({ absence: "Eigene Anträge entscheidet jemand anderes" });
  const status = approve ? "aktiv" : "abgelehnt";
  const done = await db
    .update(timetableAbsences)
    .set({ status, decidedBy: perms.userId, decidedAt: now })
    .where(and(eq(timetableAbsences.id, id), eq(timetableAbsences.status, "beantragt")))
    .returning({ id: timetableAbsences.id });
  if (!done.length) throw new ValidationError({ absence: "Dieser Antrag ist schon entschieden oder zurückgezogen" });
  await audit(db, perms.userId, approve ? "stundenplan.absence.approve" : "stundenplan.absence.reject", a.teacherId, { from: a.startsOn, to: a.endsOn });
  await notify(db, [a.teacherId!], {
    moduleId: "stundenplan",
    title: approve ? `${ABSENCE_LABELS[a.reason]} genehmigt` : `${ABSENCE_LABELS[a.reason]} nicht genehmigt`,
    body: approve ? `${spanText(a)} – die Vertretung wird geplant. Material kannst du hinterlegen.` : `${spanText(a)} – bitte bei der Schulleitung nachfragen.`,
    href: "/stundenplan/abwesenheit",
  });
  if (approve) await notifyPlanners(db, a, "Abwesenheit genehmigt");
}

export interface OwnAbsence extends TimetableAbsence {
  /** betroffene eigene Stunden (für Material) */
  lessons: LessonSlot[];
  materials: TimetableAbsenceMaterial[];
}

/** Rein: welche Stunden einer Lehrkraft fallen in die Abwesenheit? (ohne übernommene Vertretungen und entfallene Stunden) */
export function coveredLessons(
  slots: readonly LessonSlot[],
  a: Pick<TimetableAbsence, "teacherId" | "startsOn" | "endsOn" | "fromPeriod" | "toPeriod">,
): LessonSlot[] {
  return slots.filter(
    (s) => s.teacherId === a.teacherId && s.perspective !== "covering" && s.change?.kind !== "cancel" && absenceCovers(a, s.date, s.periodNr),
  );
}

/** Betroffene Stunden einer Abwesenheit (aus dem Stundenplan der Lehrkraft, Vertretungen mitgelesen). */
export async function affectedLessons(
  db: Db,
  a: Pick<TimetableAbsence, "teacherId" | "startsOn" | "endsOn" | "fromPeriod" | "toPeriod">,
): Promise<LessonSlot[]> {
  if (!a.teacherId) return [];
  return coveredLessons(await listSlots(db, { kind: "teacher", id: a.teacherId }, a.startsOn, addDays(a.endsOn, 1), { drafts: true }), a);
}

/** Eigene Meldungen ab einer Woche zurück, mit betroffenen Stunden und Material. */
export async function myAbsences(db: Db, perms: PermissionSet, today: string): Promise<OwnAbsence[]> {
  const rows = await db
    .select()
    .from(timetableAbsences)
    .where(and(eq(timetableAbsences.teacherId, perms.userId), gte(timetableAbsences.endsOn, addDays(today, -7))))
    .orderBy(asc(timetableAbsences.startsOn));
  if (!rows.length) return [];
  const mats = await db
    .select()
    .from(timetableAbsenceMaterials)
    .where(
      inArray(
        timetableAbsenceMaterials.absenceId,
        rows.map((r) => r.id),
      ),
    );
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      lessons: r.status === "abgelehnt" ? [] : await affectedLessons(db, r),
      materials: mats.filter((m) => m.absenceId === r.id),
    })),
  );
}

export interface PendingRequest {
  id: string;
  teacherName: string;
  reason: string;
  span: string;
  note: string | null;
  createdAt: Date;
}

/** Offene Anträge (Schulleitung). */
export async function pendingRequests(db: Db, perms: PermissionSet): Promise<PendingRequest[]> {
  if (!hasPermission(perms, APPROVE)) return [];
  const rows = await db
    .select({ a: timetableAbsences, name: users.name, code: users.shortCode })
    .from(timetableAbsences)
    .innerJoin(users, eq(users.id, timetableAbsences.teacherId))
    .where(eq(timetableAbsences.status, "beantragt"))
    .orderBy(asc(timetableAbsences.startsOn), desc(timetableAbsences.createdAt));
  return rows.map(({ a, name, code }) => ({
    id: a.id,
    teacherName: code ? `${name} (${code})` : name,
    reason: ABSENCE_LABELS[a.reason],
    span: spanText(a),
    note: a.note,
    createdAt: a.createdAt,
  }));
}

// ---------------------------------------------------------------- Material (Q5-12)

export interface MaterialInput {
  /** VT-01 (F-10-12): leer = Material ohne Abwesenheit an (Stunde, Tag) */
  absenceId: string | null;
  lessonId: string;
  date: string;
  text: string;
  forStudents: boolean;
  file?: { name: string; type: string; data: Uint8Array } | null;
  removeFile?: boolean;
}

const cleanFileName = (raw: string) =>
  raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120) || "Datei";

/**
 * Material zu einer betroffenen Stunde speichern (Lehrkraft selbst oder Planung). Leer (kein Text, keine Datei) = löschen.
 * Ist schon eine Vertretung eingetragen, bekommt sie einen Gong „Material liegt vor“.
 */
export async function saveMaterial(db: Db, storage: FileStorage, perms: PermissionSet, input: MaterialInput, now = new Date()): Promise<string | null> {
  const { ownerId, lesson } = input.absenceId ? await absenceMaterialTarget(db, perms, input.absenceId, input) : await lessonMaterialTarget(db, perms, input);
  const text = input.text.trim();
  if (text.length > MATERIAL_TEXT_MAX) throw new ValidationError({ text: `Höchstens ${MATERIAL_TEXT_MAX} Zeichen` });
  if (input.file && input.file.data.byteLength > MATERIAL_FILE_MAX) throw new ValidationError({ file: "Die Datei ist größer als 25 MB" });
  const [old] = await db
    .select()
    .from(timetableAbsenceMaterials)
    .where(
      and(
        input.absenceId ? eq(timetableAbsenceMaterials.absenceId, input.absenceId) : isNull(timetableAbsenceMaterials.absenceId),
        eq(timetableAbsenceMaterials.lessonId, input.lessonId),
        eq(timetableAbsenceMaterials.date, input.date),
      ),
    );
  let file: Pick<TimetableAbsenceMaterial, "fileKey" | "fileName" | "fileMime" | "fileSize"> = old
    ? { fileKey: old.fileKey, fileName: old.fileName, fileMime: old.fileMime, fileSize: old.fileSize }
    : { fileKey: null, fileName: null, fileMime: null, fileSize: null };
  if (input.removeFile) file = { fileKey: null, fileName: null, fileMime: null, fileSize: null };
  if (input.file && input.file.data.byteLength > 0) {
    const key = newStorageKey();
    await storage.put(key, input.file.data);
    file = {
      fileKey: key,
      fileName: cleanFileName(input.file.name),
      fileMime: input.file.type || "application/octet-stream",
      fileSize: input.file.data.byteLength,
    };
  }
  // die alte Datei räumt der nächtliche Aufräumlauf weg (kein Verweis mehr)
  if (!text && !file.fileKey) {
    if (old) await db.delete(timetableAbsenceMaterials).where(eq(timetableAbsenceMaterials.id, old.id));
    await audit(db, perms.userId, "stundenplan.material.delete", ownerId, { date: input.date });
    return null;
  }
  const values = { text: text || null, ...file, forStudents: input.forStudents, updatedAt: now };
  let id: string;
  if (old) {
    await db.update(timetableAbsenceMaterials).set(values).where(eq(timetableAbsenceMaterials.id, old.id));
    id = old.id;
  } else {
    const [row] = await db
      .insert(timetableAbsenceMaterials)
      .values({ absenceId: input.absenceId, lessonId: input.lessonId, date: input.date, createdBy: perms.userId, ...values })
      .returning({ id: timetableAbsenceMaterials.id });
    id = row!.id;
  }
  await audit(db, perms.userId, "stundenplan.material.save", ownerId, { date: input.date, file: Boolean(file.fileKey), withoutAbsence: !input.absenceId || undefined });
  if (!old) {
    const [sub] = await db
      .select({ substituteId: timetableSubstitutions.substituteId })
      .from(timetableSubstitutions)
      .where(
        and(eq(timetableSubstitutions.lessonId, input.lessonId), eq(timetableSubstitutions.date, input.date), eq(timetableSubstitutions.kind, "substitute")),
      );
    if (sub?.substituteId && sub.substituteId !== perms.userId)
      await notify(db, [sub.substituteId], {
        moduleId: "stundenplan",
        title: `Vertretungsmaterial: ${lesson.periodNr}. Std ${lesson.groupName}`,
        body: `${ddmm(input.date)} ${lesson.subjectName} – Material liegt vor`,
        href: `/stundenplan/material/${id}`,
      });
  }
  return id;
}

interface MaterialTarget {
  /** Lehrkraft, deren Stunde es betrifft (Abwesenheit bzw. Lehrkraft der Stunde) */
  ownerId: string | null;
  lesson: { periodNr: number; groupName: string; subjectName: string };
}

/** Q5-12: Material zu einer Abwesenheit – Lehrkraft selbst oder Planung, nur betroffene Stunden. */
async function absenceMaterialTarget(db: Db, perms: PermissionSet, absenceId: string, input: Pick<MaterialInput, "lessonId" | "date">): Promise<MaterialTarget> {
  const [a] = await db.select().from(timetableAbsences).where(eq(timetableAbsences.id, absenceId));
  if (!a || !a.teacherId) throw new ValidationError({ material: "Diese Abwesenheit gibt es nicht (mehr)" });
  if (a.teacherId !== perms.userId && !hasPermission(perms, SUBSTITUTE)) throw new ForbiddenError(SUBSTITUTE);
  if (a.status === "abgelehnt") throw new ValidationError({ material: "Der Antrag ist abgelehnt" });
  const lesson = (await affectedLessons(db, a)).find((l) => l.lessonId === input.lessonId && l.date === input.date);
  if (!lesson) throw new ValidationError({ material: "Diese Stunde gehört nicht zur Abwesenheit" });
  return { ownerId: a.teacherId, lesson };
}

/**
 * VT-01 (F-10-12): Material ohne Abwesenheit an (Stunde, Tag) – anlegen dürfen die Lehrkraft der Stunde, die Vertretungslehrkraft
 * dieser Stunde an dem Tag und die Planung (`stundenplan.substitute`). Die Stunde muss an dem Tag stattfinden.
 */
async function lessonMaterialTarget(db: Db, perms: PermissionSet, input: Pick<MaterialInput, "lessonId" | "date">): Promise<MaterialTarget> {
  if (!isCalendarDate(input.date)) throw new ValidationError({ date: "Datum angeben" });
  const [row] = await db
    .select({ l: timetableLessons, groupName: groups.name, subjectName: subjects.name })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .where(eq(timetableLessons.id, input.lessonId));
  if (!row || !lessonActiveOn(row.l, input.date) || (await dayOffOn(db, input.date))) throw new ValidationError({ material: "An diesem Tag findet die Stunde nicht statt" });
  if (row.l.teacherId !== perms.userId && !hasPermission(perms, SUBSTITUTE)) {
    const [sub] = await db
      .select({ id: timetableSubstitutions.id })
      .from(timetableSubstitutions)
      .where(
        and(
          eq(timetableSubstitutions.lessonId, input.lessonId),
          eq(timetableSubstitutions.date, input.date),
          eq(timetableSubstitutions.kind, "substitute"),
          eq(timetableSubstitutions.substituteId, perms.userId),
        ),
      );
    if (!sub) throw new ForbiddenError(SUBSTITUTE);
  }
  return { ownerId: row.l.teacherId, lesson: { periodNr: row.l.periodNr, groupName: row.groupName, subjectName: row.subjectName } };
}

/** Darf `perms` dieses Material sehen? Lehrkraft selbst, Planung, Vertretung dieser Stunde, Schüler:innen der Gruppe (nur mit Häkchen). */
async function mayView(db: Db, perms: PermissionSet, m: TimetableAbsenceMaterial, teacherId: string | null): Promise<boolean> {
  if (teacherId === perms.userId || hasPermission(perms, SUBSTITUTE)) return true;
  const [sub] = await db
    .select({ id: timetableSubstitutions.id })
    .from(timetableSubstitutions)
    .where(
      and(eq(timetableSubstitutions.lessonId, m.lessonId), eq(timetableSubstitutions.date, m.date), eq(timetableSubstitutions.substituteId, perms.userId)),
    );
  if (sub) return true;
  if (!m.forStudents || perms.role !== "schueler") return false;
  const [l] = await db.select({ groupId: timetableLessons.groupId }).from(timetableLessons).where(eq(timetableLessons.id, m.lessonId));
  if (!l) return false;
  const [member] = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, l.groupId), eq(groupMembers.userId, perms.userId)));
  return Boolean(member);
}

export interface MaterialView extends TimetableAbsenceMaterial {
  teacherName: string;
}

/** Ein Material für die Anzeige bzw. den Download – null, wenn es fehlt oder `perms` es nicht sehen darf. */
export async function materialFor(db: Db, perms: PermissionSet, id: string): Promise<MaterialView | null> {
  const [row] = await materialRows(db).where(eq(timetableAbsenceMaterials.id, id));
  if (!row || row.status === "abgelehnt") return null;
  const teacherId = row.teacherId ?? row.lessonTeacherId;
  if (!(await mayView(db, perms, row.m, teacherId))) return null;
  return { ...row.m, teacherName: teacherId ? await teacherLabel(db, teacherId) : "" };
}

/** Material mit Lehrkraft (der Abwesenheit, VT-01: ohne Abwesenheit die der Stunde) und Stand der Abwesenheit. */
const materialRows = (db: Db) =>
  db
    .select({ m: timetableAbsenceMaterials, teacherId: timetableAbsences.teacherId, status: timetableAbsences.status, lessonTeacherId: timetableLessons.teacherId })
    .from(timetableAbsenceMaterials)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableAbsenceMaterials.lessonId))
    .leftJoin(timetableAbsences, eq(timetableAbsences.id, timetableAbsenceMaterials.absenceId));

/** Material zu diesen Stunden (Schlüssel `lessonId:date`), nur was `perms` sehen darf – für Tagesleiste, Klassenbuch, Planung. */
export async function materialsFor(
  db: Db,
  perms: PermissionSet,
  keys: readonly { lessonId: string; date: string }[],
): Promise<Map<string, TimetableAbsenceMaterial>> {
  const out = new Map<string, TimetableAbsenceMaterial>();
  if (!keys.length) return out;
  const dates = [...new Set(keys.map((k) => k.date))];
  const rows = await materialRows(db).where(
      and(
        inArray(
          timetableAbsenceMaterials.lessonId,
          keys.map((k) => k.lessonId),
        ),
        inArray(timetableAbsenceMaterials.date, dates),
      ),
    );
  const wanted = new Set(keys.map((k) => `${k.lessonId}:${k.date}`));
  for (const r of rows) {
    const key = `${r.m.lessonId}:${r.m.date}`;
    if (!wanted.has(key) || r.status === "abgelehnt") continue;
    // VT-01: gibt es zur Stunde Material mit und ohne Abwesenheit, gilt das der Abwesenheit
    if (out.get(key)?.absenceId) continue;
    if (await mayView(db, perms, r.m, r.teacherId ?? r.lessonTeacherId)) out.set(key, r.m);
  }
  return out;
}
