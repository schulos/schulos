"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { formValues } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createLesson, deleteCoupling, deleteLesson, saveCoupling, updateLesson, type CouplingInput, type LessonInput } from "./manage";
import { ABSENCE_LABELS, createAbsence, deleteAbsence, needsOn } from "./abwesenheit";
import { addDuty, clearDutyChange, createArea, deleteArea, removeDuty, setDutyChange } from "./aufsichten";
import { copyPeriod } from "./periode";
import { applyRun, cancelRun, createRun, deleteRun, executeQueued, setFixed, undoApply } from "./solverlauf";
import { parsePref, savePrefs, type PrefGrid } from "./zeitwuensche";
import { closePrefWindow, saveOwnPrefs, setPrefWindow } from "./zeitwunsch-fenster";
import { createRoomBlock, deleteRoomBlock } from "./raumsperren";
import { moveLesson, openAssignments, placeAssignment } from "./setzhilfe";
import { deleteSubstitution, publishDay, saveSubstitution, type SubstitutionInput } from "./vertretung";
import { addReduction, deleteReduction, saveTeacherRule, setObligation } from "./deputate";
import { applyGradeRuleDefaults, classGrades, saveGradeRules } from "./jahrgangsregeln";
import {
  assignmentsFromTimetable,
  createAssignment,
  createBand,
  deleteAssignment,
  deleteBand,
  planningYear,
  setBandMember,
  updateAssignment,
  updateBand,
  type AssignmentInput,
  type BandInput,
} from "./verteilung";
import { executeAssignmentImport, MAX_ASSIGNMENT_CSV_BYTES, planAssignmentImport, type ImportOutcome, type ImportPreview } from "./verteilung-import";
import { decodeCsvBytes, type CsvEncoding } from "@/core/csv";

const { requirePermission, requireUser } = moduleActions("stundenplan");

// SP-02: Jahresplanung (Pflege, Verteilung, Deputate, Zeitwünsche, Aufsichtsplan, Solver) braucht `stundenplan.manage`, das Tagesgeschäft
// (Vertretungen, Abwesenheiten, Veröffentlichen, Raumsperren, Ausweichraum, Aufsichtsvertretung) `stundenplan.substitute`.

function readInput(form: FormData): LessonInput {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  return {
    groupId: str("groupId"),
    weekday: Number(str("weekday")),
    periodNr: Number(str("periodNr")),
    subjectId: str("subjectId"),
    teacherId: str("teacherId") || null,
    roomId: str("roomId") || null,
    week: (str("week") || "all") as LessonInput["week"],
    validFrom: str("validFrom"),
    validUntil: str("validUntil") || null,
  };
}

/** Pflege-Seite der Gruppe; liegt `from` in der Zukunft (neue Periode), bleibt dieser Planungsstand eingestellt. */
const pageOf = (groupId: string, from?: string | null) =>
  `/planung/stundenplan?gruppe=${encodeURIComponent(groupId)}${from && from > toBerlinDate(new Date()) ? `&stand=${from}` : ""}`;

export async function saveLessonAction(id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const input = readInput(form);
  try {
    if (id) await updateLesson(await getDb(), user.id, id, input);
    else await createLesson(await getDb(), user.id, input);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(pageOf(input.groupId, input.validFrom));
}

/** Kopplung speichern: Zeilen kommen als `part`=<Schlüssel> mit Feldern `p<Schlüssel>-<feld>`. */
export async function saveCouplingAction(couplingId: string | null, groupId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const keys = form.getAll("part").map(String);
  const input: CouplingInput = {
    weekday: Number(str("weekday")),
    periodNr: Number(str("periodNr")),
    week: (str("week") || "all") as CouplingInput["week"],
    validFrom: str("validFrom"),
    validUntil: str("validUntil") || null,
    parts: keys.map((k) => ({
      id: str(`p${k}-id`) || undefined,
      groupId: str(`p${k}-groupId`),
      subjectId: str(`p${k}-subjectId`),
      teacherId: str(`p${k}-teacherId`) || null,
      roomId: str(`p${k}-roomId`) || null,
    })),
  };
  try {
    await saveCoupling(await getDb(), user.id, couplingId, input);
  } catch (err) {
    if (err instanceof ValidationError) {
      // Fehler je Teil (p<Index>-feld) auf die Zeilenschlüssel des Formulars umschreiben
      const fieldErrors = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k.replace(/^p(\d+)-/, (_, i: string) => `p${keys[Number(i)]}-`), v]));
      return { error: Object.values(fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors, values: { ...formValues(form), parts: keys.join(",") } };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(pageOf(groupId, input.validFrom));
}

export async function deleteCouplingAction(couplingId: string, groupId: string, stand: string | null): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await deleteCoupling(await getDb(), user.id, couplingId);
  revalidatePath("/", "layout");
  redirect(pageOf(groupId, stand));
}

export async function deleteLessonAction(id: string, groupId: string, stand: string | null): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await deleteLesson(await getDb(), user.id, id);
  revalidatePath("/", "layout");
  redirect(pageOf(groupId, stand));
}

// ---------------------------------------------------------------- Periode

/** Halbjahreswechsel: laufende Stunden ab Stichtag kopieren (P2b-14). */
export async function copyPeriodAction(cutoff: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  let n: number;
  try {
    n = await copyPeriod(await getDb(), user.id, cutoff, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(`/planung/stundenplan?periode=${encodeURIComponent(cutoff)}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(`/planung/stundenplan?kopiert=${n}&ab=${cutoff}`);
}

// ---------------------------------------------------------------- Setzhilfe

const firstError = (err: ValidationError) => Object.values(err.fieldErrors)[0] ?? "Das ging nicht";

/** Eine offene Stunde eines Lehrauftrags setzen; solange noch Stunden offen sind, bleibt der Setzmodus an. */
export async function placeAssignmentAction(assignmentId: string, groupId: string, stand: string | null, weekday: number, periodNr: number): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const from = stand && stand > today ? stand : undefined;
  const back = `${pageOf(groupId, from)}&setzen=${encodeURIComponent(assignmentId)}`;
  try {
    await placeAssignment(db, user.id, assignmentId, groupId, weekday, periodNr, today, from);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${back}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  const stillOpen = (await openAssignments(db, groupId, from ?? today)).some((a) => a.id === assignmentId);
  redirect(stillOpen ? back : pageOf(groupId, from));
}

/** Stunde/Kopplung in einen freien Slot verschieben oder mit der Stunde dort tauschen. */
export async function moveLessonAction(lessonId: string, groupId: string, stand: string | null, weekday: number, periodNr: number): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await moveLesson(await getDb(), user.id, lessonId, groupId, weekday, periodNr);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${pageOf(groupId, stand)}&verschieben=${encodeURIComponent(lessonId)}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(pageOf(groupId, stand));
}

export async function saveSubstitutionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.substitute");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const input: SubstitutionInput = {
    lessonId: str("lessonId"),
    date: str("date"),
    kind: str("kind") as SubstitutionInput["kind"],
    substituteId: str("substituteId") || null,
    roomId: str("roomId") || null,
    note: str("note") || null,
    subjectId: str("subjectId") || null,
  };
  try {
    await saveSubstitution(await getDb(), user.id, input);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteSubstitutionAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  await deleteSubstitution(await getDb(), user.id, id);
  revalidatePath("/", "layout");
}

/** Q5-11: Entwurf eines Tages veröffentlichen (Gong je betroffener Person). */
export async function publishDayAction(date: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  let n: number | null;
  try {
    n = await publishDay(await getDb(), user.id, date);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`/planung/vertretungen?fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Das ging nicht")}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(`/planung/vertretungen?datum=${date}&veroeffentlicht=${n ?? "0"}`);
}

// ---------------------------------------------------------------- Unterrichtsverteilung

/** nur interne Rücksprünge auf die Verteilungsseite */
function backTo(raw: string): string {
  return raw.startsWith("/planung/unterricht") ? raw : "/planung/unterricht";
}

export async function saveAssignmentAction(id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const db = await getDb();
  const year = await planningYear(db);
  const input: AssignmentInput = {
    schoolYearId: year?.id ?? "",
    groupId: str("groupId"),
    subjectId: str("subjectId"),
    // im Band zählen die Stunden des Bands (das Formular schickt dann keine)
    hours: Number(str("hours") || "1"),
    teacherIds: [str("teacherId"), str("teacher2Id")].filter(Boolean),
    doubleLessons: Number(str("doubleLessons") || "0"),
    roomId: str("roomId") || null,
    note: str("note") || null,
    bandId: str("bandId") || null,
  };
  try {
    if (id) await updateAssignment(db, user.id, id, input);
    else await createAssignment(db, user.id, input);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  redirect(backTo(str("back")));
}

// ---------------------------------------------------------------- Bänder (SP2-01)

const bandsPage = (bandId?: string) => `/planung/unterricht?ansicht=baender${bandId ? `&band=${encodeURIComponent(bandId)}` : ""}`;

export async function saveBandAction(id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const db = await getDb();
  const year = await planningYear(db);
  const input: BandInput = { schoolYearId: year?.id ?? "", name: str("name"), hours: Number(str("hours")), doubleLessons: Number(str("doubleLessons") || "0") };
  let bandId = id;
  try {
    if (id) await updateBand(db, user.id, id, input);
    else bandId = await createBand(db, user.id, input);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  redirect(bandsPage(bandId ?? undefined));
}

export async function deleteBandAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await deleteBand(await getDb(), user.id, id);
  revalidatePath("/planung/unterricht");
  redirect(bandsPage());
}

export async function addBandMemberAction(bandId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const assignmentId = String(form.get("assignmentId") ?? "").trim();
  if (!assignmentId) return { error: "Lehrauftrag wählen", fieldErrors: { assignmentId: "Lehrauftrag wählen" } };
  try {
    await setBandMember(await getDb(), user.id, assignmentId, bandId);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  redirect(bandsPage(bandId));
}

export async function removeBandMemberAction(bandId: string, assignmentId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await setBandMember(await getDb(), user.id, assignmentId, null);
  revalidatePath("/planung/unterricht");
  redirect(bandsPage(bandId));
}

export async function deleteAssignmentAction(id: string, back: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await deleteAssignment(await getDb(), user.id, id);
  revalidatePath("/planung/unterricht");
  redirect(backTo(back));
}

export async function importAssignmentsAction(): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const year = await planningYear(db);
  const n = year ? await assignmentsFromTimetable(db, user.id, year, toBerlinDate(new Date())) : 0;
  revalidatePath("/planung/unterricht");
  redirect(`/planung/unterricht?uebernommen=${n}`);
}

// ---------------------------------------------------------------- CSV-Import der Unterrichtsverteilung (SP2-06)

export interface AssignmentImportState {
  preview?: ImportPreview;
  /** gelesener Dateiinhalt – geht mit „Übernehmen“ zurück und wird dort neu geprüft */
  text?: string;
  encoding?: CsvEncoding;
  error?: string;
  done?: ImportOutcome;
}

/** Schritt 1: Datei lesen (UTF-8 oder Windows-1252) und prüfen – nichts wird gespeichert. */
export async function previewAssignmentCsvAction(_prev: AssignmentImportState, form: FormData): Promise<AssignmentImportState> {
  await requirePermission("stundenplan.manage");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Bitte eine CSV-Datei wählen" };
  if (file.size > MAX_ASSIGNMENT_CSV_BYTES) return { error: "Datei zu groß (höchstens 512 KB)" };
  const db = await getDb();
  const year = await planningYear(db);
  if (!year) return { error: "Kein Schuljahr angelegt" };
  const { text, encoding } = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
  const plan = await planAssignmentImport(db, year, text);
  return { preview: plan.preview, text, encoding };
}

/** Schritt 2: plant serverseitig NEU (der Vorschau aus dem Browser wird nicht vertraut) und übernimmt nur ohne Fehler – ganz oder gar nicht. */
export async function runAssignmentCsvAction(_prev: AssignmentImportState, form: FormData): Promise<AssignmentImportState> {
  const { user } = await requirePermission("stundenplan.manage");
  const text = String(form.get("text") ?? "");
  const encoding = form.get("encoding") === "cp1252" ? "cp1252" : "utf8";
  if (!text || text.length > MAX_ASSIGNMENT_CSV_BYTES) return { error: "Datei fehlt oder ist zu groß – bitte neu wählen" };
  const db = await getDb();
  const year = await planningYear(db);
  if (!year) return { error: "Kein Schuljahr angelegt" };
  const plan = await planAssignmentImport(db, year, text);
  if (!plan.preview.ok) return { preview: plan.preview, text, encoding, error: "Die Datei hat Fehler bzw. nichts zu übernehmen – nichts übernommen" };
  const done = await executeAssignmentImport(db, user.id, year, plan);
  revalidatePath("/planung/unterricht");
  revalidatePath("/planung");
  return { done };
}

// ---------------------------------------------------------------- Deputate

const hoursOf = (raw: string) => Number(raw.replace(",", "."));
const teacherPage = (teacherId: string) => `/planung/unterricht?ansicht=lehrkraefte&lehrkraft=${encodeURIComponent(teacherId)}`;

export async function saveObligationAction(teacherId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const year = await planningYear(db);
  const raw = String(form.get("obligation") ?? "").trim();
  try {
    await setObligation(db, user.id, year?.id ?? "", teacherId, raw ? hoursOf(raw) : null);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  return { ok: true };
}

/** SP2-04: Tagesregel der Lehrkraft (höchstens Stunden am Tag / Anwesenheitstage); leer = keine Grenze. */
export async function saveTeacherDayRuleAction(teacherId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const year = await planningYear(db);
  const int = (k: string) => {
    const raw = String(form.get(k) ?? "").trim();
    return raw ? Number(raw) : null;
  };
  try {
    await saveTeacherRule(db, user.id, year?.id ?? "", teacherId, { maxPerDay: int("maxPerDay"), maxDays: int("maxDays") });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  return { ok: true };
}

export async function addReductionAction(teacherId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const year = await planningYear(db);
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    await addReduction(db, user.id, { schoolYearId: year?.id ?? "", teacherId, reason: str("reason"), hours: hoursOf(str("hours")), note: str("note") || null });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  return { ok: true };
}

export async function deleteReductionAction(id: string, teacherId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await deleteReduction(await getDb(), user.id, id);
  revalidatePath("/planung/unterricht");
  redirect(teacherPage(teacherId));
}

// ---------------------------------------------------------------- Raumsperrungen (P2b-17)

const BLOCKS_PAGE = "/stundenplan/raeume?ansicht=sperrungen";

export async function createRoomBlockAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.substitute");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const period = (k: string) => (str(k) ? Number(str(k)) : null);
  try {
    await createRoomBlock(await getDb(), user.id, {
      roomId: str("roomId"),
      startsOn: str("startsOn"),
      endsOn: str("endsOn") || str("startsOn"),
      fromPeriod: period("fromPeriod"),
      toPeriod: period("toPeriod"),
      reason: str("reason"),
      note: str("note") || null,
    });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteRoomBlockAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  await deleteRoomBlock(await getDb(), user.id, id);
  revalidatePath("/", "layout");
  redirect(BLOCKS_PAGE);
}

/** Ausweichraum für eine gesperrte Stunde übernehmen (Raumänderung an diesem Tag). */
export async function applyAlternativeRoomAction(lessonId: string, date: string, roomId: string, reason: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  try {
    await saveSubstitution(await getDb(), user.id, { lessonId, date, kind: "room", substituteId: null, roomId, note: `Raumsperrung: ${reason}` });
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${BLOCKS_PAGE}&fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Das ging nicht")}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(BLOCKS_PAGE);
}

// ---------------------------------------------------------------- Abwesenheiten (P2b-18)

const needsPage = (date: string) => `/planung/vertretungen?datum=${date}`;

export async function createAbsenceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.substitute");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const period = (k: string) => (str(k) ? Number(str(k)) : null);
  try {
    await createAbsence(await getDb(), user.id, {
      teacherId: str("teacherId") || null,
      groupId: str("groupId") || null,
      startsOn: str("startsOn"),
      endsOn: str("endsOn") || str("startsOn"),
      fromPeriod: period("fromPeriod"),
      toPeriod: period("toPeriod"),
      reason: str("reason"),
      note: str("note") || null,
    });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteAbsenceAction(id: string, date: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  await deleteAbsence(await getDb(), user.id, id);
  revalidatePath("/", "layout");
  redirect(needsPage(date));
}

/** Für alle Stunden abwesender Klassen an `date` Entfall eintragen (Freisetzungen bestätigen). */
export async function cancelReleasedAction(date: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  const db = await getDb();
  const { released } = await needsOn(db, date);
  const done = new Set<string>();
  for (const r of released) {
    if (r.cancelled || done.has(r.lessonId)) continue;
    await saveSubstitution(db, user.id, { lessonId: r.lessonId, date, kind: "cancel", substituteId: null, roomId: null, note: `${r.groupName} abwesend (${ABSENCE_LABELS[r.absence.reason]})` });
    done.add(r.lessonId);
  }
  revalidatePath("/", "layout");
  redirect(needsPage(date));
}

/** Vertretungsvorschlag übernehmen (P2b-19); SP-12: mit `subjectId` gibt die Lehrkraft ihr eigenes Fach („→ Mathe“). */
export async function applySuggestionAction(lessonId: string, date: string, teacherId: string, back: string, subjectId: string | null): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  try {
    await saveSubstitution(await getDb(), user.id, { lessonId, date, kind: "substitute", substituteId: teacherId, roomId: null, note: null, subjectId });
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${back}&fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Das ging nicht")}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(back);
}

// ---------------------------------------------------------------- Pausenaufsichten (P2b-20)

const dutyPage = (date?: string) => `/planung/aufsichten${date ? `?datum=${date}` : ""}`;
const firstMsg = (err: ValidationError) => Object.values(err.fieldErrors)[0] ?? "Das ging nicht";

export async function createAreaAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await createArea(await getDb(), user.id, String(form.get("name") ?? ""));
  } catch (err) {
    if (err instanceof ValidationError) return { error: firstMsg(err), fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/aufsichten");
  return { ok: true };
}

export async function deleteAreaAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await deleteArea(await getDb(), user.id, id);
  revalidatePath("/planung/aufsichten");
  redirect(dutyPage());
}

export async function addDutyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    await addDuty(await getDb(), user.id, { areaId: str("areaId"), weekday: Number(str("weekday")), afterPeriod: Number(str("afterPeriod")), teacherId: str("teacherId") });
  } catch (err) {
    if (err instanceof ValidationError) return { error: firstMsg(err), fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function removeDutyAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await removeDuty(await getDb(), user.id, id);
  revalidatePath("/", "layout");
  redirect(dutyPage());
}

/** Vertretung (Formularfeld substituteId) oder – ohne Lehrkraft – „entfällt“ für eine Aufsicht an `date`. */
export async function setDutyChangeAction(dutyId: string, date: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  const substituteId = String(form.get("substituteId") ?? "").trim() || null;
  try {
    await setDutyChange(await getDb(), user.id, dutyId, date, substituteId);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${dutyPage(date)}&fehler=${encodeURIComponent(firstMsg(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(dutyPage(date));
}

export async function clearDutyChangeAction(id: string, date: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  await clearDutyChange(await getDb(), user.id, id);
  revalidatePath("/", "layout");
  redirect(dutyPage(date));
}

// ---------------------------------------------------------------- Zeitwünsche (P2b-21)

/** Raster speichern: Felder `c-<Wochentag>-<Stunde>` mit „-3“…„3“ oder „x“ (gesperrt). */
/** Rein: Raster aus den Formularfeldern `c-<Wochentag>-<Stunde>`; ungültiger Wert → null. */
function readGrid(form: FormData): PrefGrid | null {
  const grid: PrefGrid = new Map();
  for (const [k, raw] of form.entries()) {
    if (!k.startsWith("c-")) continue;
    const v = parsePref(String(raw));
    if (v === undefined) return null;
    grid.set(k.slice(2), v);
  }
  return grid;
}

export async function savePrefsAction(kind: string, targetId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const grid = readGrid(form);
  if (!grid) return { error: "Ungültiger Wert", values: formValues(form) };
  try {
    await savePrefs(await getDb(), user.id, kind, targetId, grid);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/zeitwuensche");
  return { ok: true };
}

/** Q5-10: Lehrkraft speichert die eigenen Zeitwünsche (nur im offenen Eingabefenster, Person aus der Sitzung). */
export async function saveOwnPrefsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const grid = readGrid(form);
  if (!grid) return { error: "Ungültiger Wert", values: formValues(form) };
  try {
    await saveOwnPrefs(await getDb(), perms, grid, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", values: formValues(form) };
    throw err;
  }
  revalidatePath("/stundenplan/zeitwuensche");
  return { ok: true };
}

/** Q5-10: Eingabefenster für Lehrkräfte öffnen/ändern (Planung). */
export async function setPrefWindowAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await setPrefWindow(await getDb(), user.id, { opensOn: String(form.get("opensOn") ?? ""), closesOn: String(form.get("closesOn") ?? "") }, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/zeitwuensche");
  return { ok: true };
}

export async function closePrefWindowAction(): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await closePrefWindow(await getDb(), user.id);
  revalidatePath("/planung/zeitwuensche");
}

// ---------------------------------------------------------------- Automatische Planung (P2b-23)

const SOLVER_PAGE = "/planung/solver";
const runPage = (runId: string) => `${SOLVER_PAGE}/${encodeURIComponent(runId)}`;
/** Rücksprung nur innerhalb der Solver-Seiten (Liste mit Filter oder Detailseite) */
const solverReturn = (to: string | undefined, fallback: string) => (to && /^\/planung\/solver(\/[\w-]+)?(\?[\w=&%.-]*)?$/.test(to) ? to : fallback);
const withQuery = (path: string, key: string, value: string) => `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

/**
 * Lauf mit Parametern anlegen (SP-07: Bezeichnung, Gründlichkeit, Startwert, Gewichtung inkl. „eigene“) und im Hintergrund rechnen
 * lassen; rechnet schon einer, wartet der neue (SP-06). Weiter auf die Detailseite mit Fortschritt.
 */
export async function startSolverAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const num = (k: string) => (str(k) === "" ? undefined : Number(str(k)));
  const preset = str("preset") || "ausgewogen";
  const weightKeys = ["pref", "teacherGap", "classGap", "subjectTwice", "roomWish", "noRoom", "late", "lateFrom", "teacherDays", "subjectSpread"] as const;
  const weights = preset === "eigene" ? Object.fromEntries(weightKeys.map((k) => [k, num(`w_${k}`)]).filter(([, v]) => v !== undefined)) : undefined;
  const today = toBerlinDate(new Date());
  let id: string;
  try {
    id = await createRun(db, user.id, { label: str("label") || null, effort: str("effort") || "normal", seed: num("seed") ?? 1, preset, weights }, today);
  } catch (err) {
    if (err instanceof ValidationError) return { error: firstError(err), fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  // bewusst nicht abwarten: läuft im Serverprozess weiter (unter der Job-Sperre „solver“), Fortschritt steht in der Datenbank
  void executeQueued(db, today);
  revalidatePath(SOLVER_PAGE);
  redirect(runPage(id));
}

/** Lauf abbrechen: wartende enden sofort, rechnende in der nächsten Zeitscheibe (nach der Konstruktion mit dem bisherigen Stand). */
export async function cancelSolverAction(runId: string, returnTo?: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const back = solverReturn(returnTo, runPage(runId));
  try {
    await cancelRun(await getDb(), user.id, runId);
  } catch (err) {
    if (err instanceof ValidationError) redirect(withQuery(back, "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(SOLVER_PAGE, "layout");
  redirect(back);
}

/** Lauf löschen (nicht während er rechnet) – zurück zur Liste. */
export async function deleteSolverAction(runId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await deleteRun(await getDb(), user.id, runId);
  } catch (err) {
    if (err instanceof ValidationError) redirect(withQuery(runPage(runId), "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(SOLVER_PAGE, "layout");
  redirect(`${SOLVER_PAGE}?geloescht=1`);
}

/** Vorschlag ab Stichtag übernehmen (Stichtag = Schultag in der Zukunft); Rücknahme-Daten werden am Lauf gespeichert (SP-09). */
export async function applySolverAction(runId: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const from = String(form.get("from") ?? "");
  let res: Awaited<ReturnType<typeof applyRun>>;
  try {
    res = await applyRun(await getDb(), user.id, runId, from, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(withQuery(runPage(runId), "fehler", firstError(err)));
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(withQuery(withQuery(runPage(runId), "uebernommen", String(res.created)), "entfallen", String(res.removedSubstitutions)));
}

/** „Übernahme zurücknehmen“ (SP-09) – nur solange der Stichtag in der Zukunft liegt. */
export async function undoSolverAction(runId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  let res: Awaited<ReturnType<typeof undoApply>>;
  try {
    res = await undoApply(await getDb(), user.id, runId, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(withQuery(runPage(runId), "fehler", firstError(err)));
    throw err;
  }
  revalidatePath("/", "layout");
  const target = withQuery(withQuery(runPage(runId), "zurueckgenommen", String(res.lessons)), "wiederhergestellt", String(res.restorable + res.reinsert));
  redirect(res.restoredSubstitutions ? withQuery(target, "vertretungen", String(res.restoredSubstitutions)) : target);
}

/** Stunde fixieren/lösen (Pflege-Seite). */
export async function toggleFixedAction(lessonId: string, groupId: string, fixed: boolean, stand: string | null): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await setFixed(await getDb(), user.id, lessonId, fixed);
  revalidatePath("/planung/stundenplan");
  redirect(pageOf(groupId, stand));
}

// ---------------------------------------------------------------- Tagesgrenzen und Ganztag (SP2-03)

const limitsPage = (saved?: string) => `/planung/unterricht?ansicht=tagesgrenzen${saved ? `&gespeichert=${saved}` : ""}`;

/** Speichert die Tagesgrenzen aller Jahrgänge mit Klassen (leeres Feld = keine Grenze). */
export async function saveGradeRulesAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const optInt = (k: string) => {
    const v = String(form.get(k) ?? "").trim();
    return v === "" ? null : Number(v);
  };
  const rules = (await classGrades(db)).map((grade) => ({ grade, maxPerDay: optInt(`max_${grade}`), afternoonsPerWeek: optInt(`pm_${grade}`), lunchAfterPeriod: optInt(`lunch_${grade}`) }));
  try {
    await saveGradeRules(db, user.id, rules);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  redirect(limitsPage("1"));
}

/** Übernimmt die Vorgaben der Schulform (Katalog) für alle Jahrgänge mit Klassen. */
export async function applyGradeRuleDefaultsAction(): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await applyGradeRuleDefaults(await getDb(), user.id);
  revalidatePath("/planung/unterricht");
  redirect(limitsPage("vorgaben"));
}
