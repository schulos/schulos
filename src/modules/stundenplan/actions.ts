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
import { ABSENCE_LABELS, createAbsence, deleteAbsence, needsOn, shortenAbsence } from "./abwesenheit";
import { addDuty, clearDutyChange, createArea, deleteArea, removeDuty, setDutyChange } from "./aufsichten";
import { createDraft as createPlanDraft, createVariant as createPlanVariant, discardVersion as discardPlanVersion, getVersion as getPlanVersion, type DraftSource } from "./planversionen";
import { applyRunToDraft, cancelRun, createRun, DEFAULT_PASSES, deleteRun, executeQueued, setFixed, undoApply } from "./solverlauf";
import { publishVersion, undoPublish } from "./veroeffentlichen";
import { correctionSummary, type LiveOptions } from "./sofortkorrektur";
import { createFromTemplate, type PlanTemplate } from "./laufzeit";
import { createNewYearDraft } from "./neues-schuljahr";
import { archiveYear as archivePlanYear } from "./schuljahresabschluss";
import { QUELLE_LIVE, quelleQuery, writableSource } from "./quelle";
import type { PlanSource } from "./plan-quelle";
import { parsePref, savePrefs, type PrefGrid } from "./zeitwuensche";
import { closePrefWindow, saveOwnPrefs, setPrefWindow } from "./zeitwunsch-fenster";
import { createRoomBlock, deleteRoomBlock } from "./raumsperren";
import { moveLesson, openAssignments, placeAssignment } from "./setzhilfe";
import { acknowledgeSubstitution, deleteSubstitution, keepReviewedSubstitution, publishDay, removeReviewedSubstitutions, saveSubstitution, type SubstitutionInput } from "./vertretung";
import { deleteDayNote, saveDayNote } from "./tagesmitteilungen";
import { sendNow } from "./benachrichtigung";
import type { NotifyAudience, PlanCommentTarget, TimetablePlanVersion } from "./schema";
import { addReduction, defaultObligation, deleteReduction, saveTeacherRule, setDeputy } from "./deputate";
import { readSchoolSettings } from "@/core/settings";
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
import { addStandby, removeStandby } from "./bereitschaft";
import { permanentMessage, savePermanentSubstitution } from "./dauervertretung";
import { audit } from "@/core/audit";
import { checkSubjectFit, executeTeacherSubjectImport, offSubjectConfirmed, MAX_TEACHER_SUBJECT_CSV_BYTES, planTeacherSubjectImport, setTeacherSubjects, type TeacherSubjectPreview } from "./lehrfaecher";
import { addStaffChange, deleteStaffChange, saveForecastGrades } from "./fachbedarf";
import { ForbiddenError, hasPermission } from "@/core/permissions";
import { PLAN_MANAGE, PLAN_REVIEW } from "./rechte";
import {
  addComment as addPlanComment,
  addPreviewComment,
  approveVersion,
  canSeeVersion,
  resolveComment as resolvePlanComment,
  returnToPlanning,
  setTeacherPreview,
  submitForReview,
  type Viewer,
} from "./planpruefung";
import { parseEdits, saveMatrixEdits, type MatrixSaveResult } from "./matrix";
import { requireWritableRecordYear, requireWritableYear } from "./planungsjahr";

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

/**
 * Pflege-Seite der Gruppe; liegt `from` in der Zukunft (neue Periode), bleibt dieser Planungsstand eingestellt. SP3-02: im Entwurf bleibt
 * die Quelle eingestellt (der Planungsstand ist dort der Stichtag des Entwurfs).
 */
const pageOf = (groupId: string, from?: string | null, quelle?: string | null) =>
  quelle && quelle !== QUELLE_LIVE
    ? `/planung/stundenplan?gruppe=${encodeURIComponent(groupId)}${quelleQuery(quelle)}`
    : `/planung/stundenplan?gruppe=${encodeURIComponent(groupId)}${from && from > toBerlinDate(new Date()) ? `&stand=${from}` : ""}`;

/**
 * SP3-05: Optionen einer Änderung im gültigen Plan (Kennung der Aktion für den Hinweis, optionale Begründung) – im Entwurf ohne Wirkung.
 */
function liveOptions(source: PlanSource, form?: FormData): LiveOptions {
  if (source.kind !== "live") return {};
  return { batchId: crypto.randomUUID(), reason: form ? String(form.get("reason") ?? "").trim() || null : null };
}

/**
 * SP3-05: nach einer Sofort-Korrektur auf die Pflege-Seite mit Hinweis (`korrektur=<Aktion>`); wirkt sie ab einem künftigen Stichtag (Split),
 * zeigt die Seite den Plan ab dann.
 */
async function afterChange(groupId: string, fallbackFrom: string | null | undefined, quelle: string | null, opts: LiveOptions): Promise<string> {
  const summary = opts.batchId ? await correctionSummary(await getDb(), opts.batchId) : null;
  if (!summary) return pageOf(groupId, fallbackFrom, quelle);
  const today = toBerlinDate(new Date());
  const ended = summary.kinds.split > 0 || (summary.kinds.delete > 0 && summary.from > today);
  return `${pageOf(groupId, ended ? summary.from : fallbackFrom, quelle)}&korrektur=${encodeURIComponent(summary.batchId)}`;
}

export async function saveLessonAction(id: string | null, quelle: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const input = readInput(form);
  let opts: LiveOptions = {};
  try {
    // SP3-02: im Entwurf (nur Status „Entwurf“) statt im gültigen Plan
    const source = await writableSource(await getDb(), quelle);
    // SP2-12: fachfremde Lehrkraft nur mit Bestätigung
    const off = await checkSubjectFit(await getDb(), input.subjectId, input.teacherId ? [input.teacherId] : [], offSubjectConfirmed(form, "teacherId", input.teacherId), "teacherId");
    opts = liveOptions(source, form);
    if (id) await updateLesson(await getDb(), user.id, id, input, source, opts);
    else await createLesson(await getDb(), user.id, input, source, opts);
    if (off.length) await audit(await getDb(), user.id, "stundenplan.lesson.off_subject", input.groupId, { subject: input.subjectId, teachers: off });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(await afterChange(input.groupId, input.validFrom, quelle, opts));
}

/** Kopplung speichern: Zeilen kommen als `part`=<Schlüssel> mit Feldern `p<Schlüssel>-<feld>`. */
export async function saveCouplingAction(couplingId: string | null, groupId: string, quelle: string | null, _prev: FormState, form: FormData): Promise<FormState> {
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
  let opts: LiveOptions = {};
  try {
    const source = await writableSource(await getDb(), quelle);
    opts = liveOptions(source, form);
    // SP2-12: fachfremde Lehrkräfte je Teil nur mit Bestätigung – R2-P3: je Teil eigene Bestätigung
    for (const [i, p] of input.parts.entries())
      await checkSubjectFit(await getDb(), p.subjectId, p.teacherId ? [p.teacherId] : [], offSubjectConfirmed(form, `p${keys[i]}-teacherId`, p.teacherId), `p${i}-teacherId`);
    await saveCoupling(await getDb(), user.id, couplingId, input, source, opts);
  } catch (err) {
    if (err instanceof ValidationError) {
      // Fehler je Teil (p<Index>-feld) auf die Zeilenschlüssel des Formulars umschreiben
      const fieldErrors = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k.replace(/^p(\d+)-/, (_, i: string) => `p${keys[Number(i)]}-`), v]));
      return { error: Object.values(fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors, values: { ...formValues(form), parts: keys.join(",") } };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(await afterChange(groupId, input.validFrom, quelle, opts));
}

export async function deleteCouplingAction(couplingId: string, groupId: string, stand: string | null, quelle: string | null = null): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  let opts: LiveOptions = {};
  try {
    const source = await writableSource(db, quelle);
    opts = liveOptions(source);
    await deleteCoupling(db, user.id, couplingId, source, opts);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${pageOf(groupId, stand, quelle)}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(await afterChange(groupId, stand, quelle, opts));
}

export async function deleteLessonAction(id: string, groupId: string, stand: string | null, quelle: string | null = null): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  let opts: LiveOptions = {};
  try {
    const source = await writableSource(db, quelle);
    opts = liveOptions(source);
    await deleteLesson(db, user.id, id, toBerlinDate(new Date()), source, opts);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${pageOf(groupId, stand, quelle)}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(await afterChange(groupId, stand, quelle, opts));
}

// ---------------------------------------------------------------- Setzhilfe

const firstError = (err: ValidationError) => Object.values(err.fieldErrors)[0] ?? "Das ging nicht";

/**
 * Eine offene Stunde eines Lehrauftrags setzen; solange noch Stunden offen sind, bleibt der Setzmodus an. SP3-02: im Entwurf ab dessen
 * Stichtag (offene Stunden zählen gegen den Entwurf, die Stunde trägt den Lehrauftrag).
 */
export async function placeAssignmentAction(assignmentId: string, groupId: string, stand: string | null, quelle: string | null, weekday: number, periodNr: number): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const today = toBerlinDate(new Date());
  let from = stand && stand > today ? stand : undefined;
  let back = `${pageOf(groupId, from, quelle)}&setzen=${encodeURIComponent(assignmentId)}`;
  let source: PlanSource;
  let opts: LiveOptions = {};
  try {
    source = await writableSource(db, quelle);
    opts = liveOptions(source);
    if (source.kind === "draft") from = (await getPlanVersion(db, source.versionId))?.validFrom ?? from;
    back = `${pageOf(groupId, from, quelle)}&setzen=${encodeURIComponent(assignmentId)}`;
    await placeAssignment(db, user.id, assignmentId, groupId, weekday, periodNr, today, from, source, opts);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${back}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  const stillOpen = (await openAssignments(db, groupId, from ?? today, source)).some((a) => a.id === assignmentId);
  redirect(stillOpen ? back : await afterChange(groupId, from, quelle, opts));
}

/** Stunde/Kopplung in einen freien Slot verschieben oder mit der Stunde dort tauschen (SP3-02: auch im Entwurf). */
export async function moveLessonAction(lessonId: string, groupId: string, stand: string | null, quelle: string | null, weekday: number, periodNr: number): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  let opts: LiveOptions = {};
  try {
    const source = await writableSource(db, quelle);
    opts = liveOptions(source);
    await moveLesson(db, user.id, lessonId, groupId, weekday, periodNr, source, opts);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${pageOf(groupId, stand, quelle)}&verschieben=${encodeURIComponent(lessonId)}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(await afterChange(groupId, stand, quelle, opts));
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
    // SP2-07: Verlegung (Stunde, Tausch) und Zusammenlegung
    targetPeriod: str("targetPeriod") ? Number(str("targetPeriod")) : null,
    swap: str("swap") === "1",
    mergeLessonId: str("mergeLessonId") || null,
    // VT-01: Grund-Kategorie (leer = Vorgabe aus Abwesenheit/Raumsperre), interner Hinweis, „nur Betreuung“
    reason: (str("reason") || null) as SubstitutionInput["reason"],
    internalNote: str("internalNote") || null,
    supervisionOnly: str("supervisionOnly") === "1",
  };
  let message: string | undefined;
  try {
    // SP2-08: Dauervertretung – dieselbe Vertretung an allen Tagen der Abwesenheit
    if (input.kind === "substitute" && str("permanent")) {
      const r = await savePermanentSubstitution(await getDb(), user.id, { ...input, from: input.date, absenceId: str("permanent"), substituteId: input.substituteId ?? "" });
      message = permanentMessage(r);
    } else await saveSubstitution(await getDb(), user.id, input);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true, message };
}

export async function deleteSubstitutionAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  try {
    await deleteSubstitution(await getDb(), user.id, id);
  } catch (err) {
    // SP2-07: Aufheben geht nicht, solange eine andere Stunde der Gruppe in diese Stunde verlegt ist
    if (err instanceof ValidationError) redirect(`/planung/vertretungen?fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Das ging nicht")}`);
    throw err;
  }
  revalidatePath("/", "layout");
}

/** VT-01 (F-10-10): Kenntnisnahme der eigenen Vertretung – Knopf „Gesehen“ in „Meine Vertretungen“ (VT-02). */
export async function acknowledgeSubstitutionAction(id: string): Promise<void> {
  const { user } = await requireUser();
  try {
    await acknowledgeSubstitution(await getDb(), user.id, id);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
  }
  revalidatePath("/", "layout");
}

/** VT-01: Tagesmitteilung anlegen (`id` leer) oder ändern. */
export async function saveDayNoteAction(id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.substitute");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    await saveDayNote(await getDb(), user.id, id, { date: str("date"), body: str("body"), audience: str("audience") || "alle" });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteDayNoteAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  await deleteDayNote(await getDb(), user.id, id);
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- Bereitschaft (SP2-07)

export async function addStandbyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.substitute");
  try {
    await addStandby(await getDb(), user.id, {
      schoolYearId: String(form.get("schoolYearId") ?? ""),
      teacherId: String(form.get("teacherId") ?? ""),
      weekday: Number(form.get("weekday")),
      periodNr: Number(form.get("periodNr")),
    });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/vertretungen/bereitschaft");
  return { ok: true };
}

export async function removeStandbyAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  await removeStandby(await getDb(), user.id, id);
  revalidatePath("/planung/vertretungen/bereitschaft");
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

/** VT-04: eingeplante Vertretungsnachricht eines Tages und einer Zielgruppe sofort senden (auch in der Ruhezeit). */
export async function sendNotificationsNowAction(date: string, audience: string, back: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  const target = back.startsWith("/planung/vertretungen") ? back : "/planung/vertretungen";
  let n: number;
  try {
    n = await sendNow(await getDb(), user.id, date, audience as NotifyAudience);
  } catch (err) {
    if (err instanceof ValidationError) redirect(`/planung/vertretungen?fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Das ging nicht")}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(`${target}${target.includes("?") ? "&" : "?"}gesendet=${n}`);
}

// ---------------------------------------------------------------- Unterrichtsverteilung

/** nur interne Rücksprünge auf die Verteilungsseite */
function backTo(raw: string): string {
  return raw.startsWith("/planung/unterricht") ? raw : "/planung/unterricht";
}

/**
 * SP3-09a: `yearId` = Planungsjahr der Seite (gebunden) – nicht das Cookie, damit ein zweiter Tab mit anderem Jahr nichts verwechselt;
 * abgeschlossene Schuljahre lehnt `requireWritableYear` ab.
 */
export async function saveAssignmentAction(yearId: string, id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const db = await getDb();
  const input: AssignmentInput = {
    schoolYearId: yearId,
    groupId: str("groupId"),
    subjectId: str("subjectId"),
    // im Band zählen die Stunden des Bands (das Formular schickt dann keine)
    hours: Number(str("hours") || "1"),
    teacherIds: [str("teacherId"), str("teacher2Id")].filter(Boolean),
    doubleLessons: Number(str("doubleLessons") || "0"),
    roomId: str("roomId") || null,
    note: str("note") || null,
    bandId: str("bandId") || null,
    validFrom: str("validFrom") || null,
    validUntil: str("validUntil") || null,
  };
  try {
    await requireWritableYear(db, yearId);
    // SP2-12: fachfremde Lehrkraft nur mit Bestätigung („Trotzdem zuweisen“), ohne gepflegte Lehrfächer nur ein Hinweis
    // R2-P3: je Lehrkraft-Feld eine eigene Bestätigung
    const off = [
      ...(await checkSubjectFit(db, input.subjectId, [str("teacherId")], offSubjectConfirmed(form, "teacherId", str("teacherId")))),
      ...(await checkSubjectFit(db, input.subjectId, [str("teacher2Id")], offSubjectConfirmed(form, "teacher2Id", str("teacher2Id")), "teacher2Id")),
    ];
    if (id) await updateAssignment(db, user.id, id, input);
    else await createAssignment(db, user.id, input);
    if (off.length) await audit(db, user.id, "stundenplan.assignment.off_subject", input.groupId, { subject: input.subjectId, teachers: off });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  redirect(backTo(str("back")));
}

// ---------------------------------------------------------------- Bänder (SP2-01)

const bandsPage = (bandId?: string) => `/planung/unterricht?ansicht=baender${bandId ? `&band=${encodeURIComponent(bandId)}` : ""}`;

export async function saveBandAction(yearId: string, id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const db = await getDb();
  const input: BandInput = { schoolYearId: yearId, name: str("name"), hours: Number(str("hours")), doubleLessons: Number(str("doubleLessons") || "0") };
  let bandId = id;
  try {
    await requireWritableYear(db, yearId);
    if (id) await requireWritableRecordYear(db, "band", id);
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
  try {
    await requireWritableRecordYear(await getDb(), "band", id);
    // Review R3 N4: nur ohne Mitglieder (auch aus anderen Zeiträumen) – sonst zurück zum Band, das sie anzeigt
    await deleteBand(await getDb(), user.id, id, { onlyEmpty: true });
  } catch (err) {
    if (err instanceof ValidationError) redirect(bandsPage(id));
    throw err;
  }
  revalidatePath("/planung/unterricht");
  redirect(bandsPage());
}

export async function addBandMemberAction(bandId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const assignmentId = String(form.get("assignmentId") ?? "").trim();
  if (!assignmentId) return { error: "Lehrauftrag wählen", fieldErrors: { assignmentId: "Lehrauftrag wählen" } };
  try {
    await requireWritableRecordYear(await getDb(), "band", bandId);
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
  await requireWritableRecordYear(await getDb(), "assignment", assignmentId);
  await setBandMember(await getDb(), user.id, assignmentId, null);
  revalidatePath("/planung/unterricht");
  redirect(bandsPage(bandId));
}

export async function deleteAssignmentAction(id: string, back: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await requireWritableRecordYear(await getDb(), "assignment", id);
  await deleteAssignment(await getDb(), user.id, id);
  revalidatePath("/planung/unterricht");
  redirect(backTo(back));
}

/**
 * SP3-LA: Änderungen aus der Matrix speichern (zellweise oder gesammelt). Rückgabe je Zelle; die Seite lädt danach neu (Bilanz vom Server).
 * `source` nur fürs Protokoll (Übernahme aus Vorjahr/Halbjahr).
 */
export async function saveMatrixAction(yearId: string, rawEdits: unknown, refYmd: string, source: string): Promise<{ results: MatrixSaveResult[]; error?: string }> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  try {
    // SP3-09a: Planungsjahr der Seite (auch das Folgejahr); abgeschlossene Schuljahre nur lesbar
    const year = await requireWritableYear(db, String(yearId));
    const edits = parseEdits(rawEdits);
    const results = await saveMatrixEdits(db, user.id, year, String(refYmd), edits, source === "vorjahr" || source === "halbjahr" ? source : "matrix");
    revalidatePath("/planung/unterricht");
    return { results };
  } catch (err) {
    if (err instanceof ValidationError) return { results: [], error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen" };
    throw err;
  }
}

/** „Aus Stundenplan übernehmen“ liest den gültigen Plan – nur im laufenden Schuljahr (die Seite bietet es sonst nicht an). */
export async function importAssignmentsAction(yearId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const year = await planningYear(db);
  if (!year || year.id !== yearId) redirect("/planung/unterricht");
  const n = await assignmentsFromTimetable(db, user.id, year, toBerlinDate(new Date()));
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
/** SP3-09a: `yearId` = Planungsjahr der Import-Seite (gebunden); abgeschlossene Schuljahre nur lesbar. */
async function importYear(yearId: string): Promise<{ year: Awaited<ReturnType<typeof requireWritableYear>> } | { error: string }> {
  try {
    return { year: await requireWritableYear(await getDb(), yearId) };
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Schuljahr prüfen" };
    throw err;
  }
}

export async function previewAssignmentCsvAction(yearId: string, _prev: AssignmentImportState, form: FormData): Promise<AssignmentImportState> {
  await requirePermission("stundenplan.manage");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Bitte eine CSV-Datei wählen" };
  if (file.size > MAX_ASSIGNMENT_CSV_BYTES) return { error: "Datei zu groß (höchstens 512 KB)" };
  const db = await getDb();
  const y = await importYear(yearId);
  if ("error" in y) return { error: y.error };
  const year = y.year;
  const { text, encoding } = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
  const plan = await planAssignmentImport(db, year, text);
  return { preview: plan.preview, text, encoding };
}

/** Schritt 2: plant serverseitig NEU (der Vorschau aus dem Browser wird nicht vertraut) und übernimmt nur ohne Fehler – ganz oder gar nicht. */
export async function runAssignmentCsvAction(yearId: string, _prev: AssignmentImportState, form: FormData): Promise<AssignmentImportState> {
  const { user } = await requirePermission("stundenplan.manage");
  const text = String(form.get("text") ?? "");
  const encoding = form.get("encoding") === "cp1252" ? "cp1252" : "utf8";
  if (!text || text.length > MAX_ASSIGNMENT_CSV_BYTES) return { error: "Datei fehlt oder ist zu groß – bitte neu wählen" };
  const db = await getDb();
  const y = await importYear(yearId);
  if ("error" in y) return { error: y.error };
  const year = y.year;
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

export async function saveObligationAction(yearId: string, teacherId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const opt = (k: string) => {
    const raw = String(form.get(k) ?? "")
      .replace("%", "")
      .trim();
    return raw ? hoursOf(raw) : null;
  };
  // SP3-DEP: Teilzeit-Anteil (Rechenhilfe) und Pflicht 2. Halbjahr (Feld fehlt ohne Beginn des 2. Halbjahrs → leer)
  const fallback = defaultObligation((await readSchoolSettings(db)).profile.form);
  try {
    await requireWritableYear(db, yearId);
    await setDeputy(
      db,
      user.id,
      yearId,
      teacherId,
      {
        obligation: opt("obligation"),
        employmentPercent: opt("employmentPercent"),
        obligationTerm2: opt("obligationTerm2"),
      },
      fallback,
    );
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  return { ok: true };
}

/** SP2-04: Tagesregel der Lehrkraft (höchstens Stunden am Tag / Anwesenheitstage); leer = keine Grenze. */
export async function saveTeacherDayRuleAction(yearId: string, teacherId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const int = (k: string) => {
    const raw = String(form.get(k) ?? "").trim();
    return raw ? Number(raw) : null;
  };
  try {
    await requireWritableYear(db, yearId);
    await saveTeacherRule(db, user.id, yearId, teacherId, { maxPerDay: int("maxPerDay"), maxDays: int("maxDays") });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  return { ok: true };
}

export async function addReductionAction(yearId: string, teacherId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    await requireWritableYear(db, yearId);
    await addReduction(db, user.id, {
      schoolYearId: yearId,
      teacherId,
      reason: str("reason"),
      hours: hoursOf(str("hours")),
      note: str("note") || null,
      validFrom: str("validFrom") || null,
      validUntil: str("validUntil") || null,
    });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/unterricht");
  return { ok: true };
}

export async function deleteReductionAction(id: string, teacherId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await requireWritableRecordYear(await getDb(), "reduction", id);
  await deleteReduction(await getDb(), user.id, id);
  revalidatePath("/planung/unterricht");
  redirect(teacherPage(teacherId));
}

// ---------------------------------------------------------------- Lehrfächer und Fachbedarf (SP2-12)

/** Lehrfächer (Fakultas) einer Lehrkraft ersetzen – Häkchen je Fach. */
export async function saveTeacherSubjectsAction(teacherId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await setTeacherSubjects(await getDb(), user.id, teacherId, form.getAll("subjectIds").map(String));
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  revalidatePath("/planung", "layout");
  return { ok: true };
}

export interface TeacherSubjectImportState {
  preview?: TeacherSubjectPreview;
  text?: string;
  encoding?: CsvEncoding;
  error?: string;
  done?: number;
}

/** CSV „Lehrkraft;Lehrfächer“ – Schritt 1: lesen und prüfen, nichts wird gespeichert. */
export async function previewTeacherSubjectCsvAction(_prev: TeacherSubjectImportState, form: FormData): Promise<TeacherSubjectImportState> {
  await requirePermission("stundenplan.manage");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Bitte eine CSV-Datei wählen" };
  if (file.size > MAX_TEACHER_SUBJECT_CSV_BYTES) return { error: "Datei zu groß (höchstens 256 KB)" };
  const { text, encoding } = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
  const plan = await planTeacherSubjectImport(await getDb(), text);
  return { preview: plan.preview, text, encoding };
}

/** Schritt 2: serverseitig neu prüfen und nur ohne Fehler übernehmen – ganz oder gar nicht. */
export async function runTeacherSubjectCsvAction(_prev: TeacherSubjectImportState, form: FormData): Promise<TeacherSubjectImportState> {
  const { user } = await requirePermission("stundenplan.manage");
  const text = String(form.get("text") ?? "");
  const encoding = form.get("encoding") === "cp1252" ? "cp1252" : "utf8";
  if (!text || text.length > MAX_TEACHER_SUBJECT_CSV_BYTES) return { error: "Datei fehlt oder ist zu groß – bitte neu wählen" };
  const db = await getDb();
  const plan = await planTeacherSubjectImport(db, text);
  if (!plan.preview.ok) return { preview: plan.preview, text, encoding, error: "Die Datei hat Fehler bzw. nichts zu übernehmen – nichts übernommen" };
  const done = await executeTeacherSubjectImport(db, user.id, plan);
  revalidatePath("/planung", "layout");
  return { done };
}

/** Abgang (Lehrkraft) bzw. Zugang (Fächer) für die Prognose – Datum + Stunden, ohne Begründung. */
export async function addStaffChangeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    await addStaffChange(await getDb(), user.id, {
      kind: str("kind"),
      teacherId: str("teacherId") || null,
      subjectIds: form.getAll("subjectIds").map(String),
      effectiveOn: str("effectiveOn"),
      hours: hoursOf(str("hours")),
    });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/bedarf");
  return { ok: true };
}

export async function deleteStaffChangeAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  await deleteStaffChange(await getDb(), user.id, id);
  revalidatePath("/planung/bedarf");
  redirect("/planung/bedarf");
}

/** Klassenzahl je Jahrgang im nächsten Schuljahr – Felder `g<Jahrgang>`, leer = Vorschlag „rücken auf“. */
export async function saveForecastGradesAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const year = await planningYear(db);
  const entries = [...form.keys()]
    .filter((k) => /^g\d+$/.test(k))
    .map((k) => {
      const raw = String(form.get(k) ?? "").trim();
      return { grade: Number(k.slice(1)), classes: raw ? Number(raw) : null };
    });
  try {
    await saveForecastGrades(db, user.id, year?.id ?? "", entries);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/planung/bedarf");
  return { ok: true };
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

/** SP2-16b: Abwesenheit verkürzen (früher zurück); Änderungen danach bleiben stehen und werden zur Prüfung markiert. */
export async function shortenAbsenceAction(id: string, date: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  let flagged: number;
  try {
    flagged = await shortenAbsence(await getDb(), user.id, id, String(form.get("endsOn") ?? "").trim());
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${needsPage(date)}&fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Das ging nicht")}`);
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(`${needsPage(date)}&verkuerzt=${flagged}`);
}

/** SP2-16b: markierte Änderung behalten. */
export async function keepReviewedAction(id: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  await keepReviewedSubstitution(await getDb(), user.id, id);
  revalidatePath("/", "layout");
}

/** SP2-16b: alle markierten Änderungen ab heute entfernen. */
export async function removeReviewedAction(date: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.substitute");
  const { failed } = await removeReviewedSubstitutions(await getDb(), user.id, toBerlinDate(new Date()));
  revalidatePath("/", "layout");
  if (failed.length)
    redirect(`${needsPage(date)}&fehler=${encodeURIComponent(`Nicht entfernt: ${failed.map((f) => `${f.date.slice(8)}.${f.date.slice(5, 7)}. (${f.reason})`).join(", ")}`)}`);
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
    if (err instanceof ValidationError) {
      // VT-03b: `back` kann einen Sprung (#…) tragen – die Meldung gehört davor
      const [path, hash] = back.split("#");
      redirect(`${path}${path!.includes("?") ? "&" : "?"}fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Das ging nicht")}${hash ? `#${hash}` : ""}`);
    }
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

/** SP3-09b: `yearId` = Planungsjahr der Seite (gebunden, auch das Folgejahr); abgeschlossene Schuljahre lehnt `savePrefs` ab. */
export async function savePrefsAction(yearId: string, kind: string, targetId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const grid = readGrid(form);
  if (!grid) return { error: "Ungültiger Wert", values: formValues(form) };
  try {
    await savePrefs(await getDb(), user.id, kind, targetId, grid, "planung", String(yearId));
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

/** Q5-10: Eingabefenster für Lehrkräfte öffnen/ändern (Planung). SP3-09b: für das Planungsjahr der Seite (gebunden). */
export async function setPrefWindowAction(yearId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await setPrefWindow(
      await getDb(),
      user.id,
      { opensOn: String(form.get("opensOn") ?? ""), closesOn: String(form.get("closesOn") ?? ""), schoolYearId: String(yearId) },
      toBerlinDate(new Date()),
    );
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
 * lassen; rechnet schon einer, wartet der neue (SP-06). Weiter auf die Detailseite mit Fortschritt. SP3-09b: `yearId` = Planungsjahr der
 * Seite (gebunden, nicht aus dem Cookie); `createRun` prüft es (beschreibbar, Entwurf dieses Jahrs, außerhalb des laufenden nur im Entwurf).
 */
export async function startSolverAction(yearId: string, _prev: FormState, form: FormData): Promise<FormState> {
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
    id = await createRun(
      db,
      user.id,
      { label: str("label") || null, effort: str("effort") || "normal", seed: num("seed") ?? 1, preset, weights, refYmd: str("refYmd") || null, versionId: str("versionId") && str("versionId") !== QUELLE_LIVE ? str("versionId") : null, mode: str("mode") || null, scope: str("scope") || null, passes: str("lauf") === "mehrfach" ? (num("passes") ?? DEFAULT_PASSES) : null, schoolYearId: String(yearId) },
      today,
    );
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

/**
 * SP3-02 (F-10-1): Vorschlag in einen Entwurf übernehmen – in einen offenen Entwurf (`ziel` = Versions-id) oder in einen neuen Entwurf aus
 * dem gültigen Plan ab Stichtag (`ziel` = `neu`, `from`). Weiter zur Pflege-Seite im Entwurf; der gültige Plan bleibt unverändert.
 */
export async function applySolverToDraftAction(runId: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const ziel = String(form.get("ziel") ?? "").trim();
  const target = ziel && ziel !== "neu" ? { versionId: ziel } : { newDraft: { validFrom: String(form.get("from") ?? "").trim(), name: String(form.get("name") ?? "").trim() || null } };
  let res: Awaited<ReturnType<typeof applyRunToDraft>>;
  try {
    res = await applyRunToDraft(await getDb(), user.id, runId, target, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(withQuery(runPage(runId), "fehler", firstError(err)));
    throw err;
  }
  revalidatePath("/planung", "layout");
  redirect(withQuery(withQuery(withQuery(runPage(runId), "entwurf", res.versionId), "gesetzt", String(res.created)), "ersetzt", String(res.replaced)));
}

/** „Übernahme zurücknehmen“ (SP-09) – nur noch für Läufe, die vor SP3-04 direkt übernommen wurden, und nur bis zu ihrem Stichtag. */
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

/** Stunde fixieren/lösen (Pflege-Seite; SP3-02: auch im Entwurf). */
export async function toggleFixedAction(lessonId: string, groupId: string, fixed: boolean, stand: string | null, quelle: string | null = null): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  try {
    await setFixed(db, user.id, lessonId, fixed, await writableSource(db, quelle));
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${pageOf(groupId, stand, quelle)}&fehler=${encodeURIComponent(firstError(err))}`);
    throw err;
  }
  revalidatePath("/planung/stundenplan");
  redirect(pageOf(groupId, stand, quelle));
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

// ---------------------------------------------------------------- Planversionen (SP3-01)

const VERSIONS_PAGE = "/planung/versionen";
const versionsPage = (yearId: string | null, key?: string, value?: string) => {
  const q = new URLSearchParams();
  if (yearId) q.set("jahr", yearId);
  if (key && value !== undefined) q.set(key, value);
  const s = q.toString();
  return s ? `${VERSIONS_PAGE}?${s}` : VERSIONS_PAGE;
};

/** Neuen Entwurf anlegen: aus dem gültigen Plan ab Stichtag, leer oder aus einer Vorversion (nur `stundenplan.manage`). */
export async function createDraftAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("stundenplan.manage");
  const str = (k: string) => String(form.get(k) ?? "").trim();
  let v: { id: string; schoolYearId: string };
  try {
    v = await createPlanDraft(
      await getDb(),
      user.id,
      {
        schoolYearId: str("schoolYearId"),
        source: str("source") as DraftSource,
        validFrom: str("validFrom"),
        numbering: str("numbering") === "minor" ? "minor" : "major",
        name: str("name") || null,
        previousVersionId: str("previousVersionId") || null,
        withFixed: form.get("withFixed") === "on",
      },
      toBerlinDate(new Date()),
    );
  } catch (err) {
    if (err instanceof ValidationError) return { error: firstError(err), fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  redirect(versionsPage(v.schoolYearId, "angelegt", v.id));
}

/**
 * SP3-05: Entwurf aus einer Vorlage – „Änderung im laufenden Plan“ (Folgeversion ab dem nächsten Schultag) bzw. „Neues Halbjahr“ (ab Beginn
 * des 2. Halbjahrs, Lehraufträge am Stichtag). Beide kopieren den gültigen Plan; der weitere Weg ist der normale (Prüfung → Freigabe → Veröffentlichen).
 */
export async function createFromTemplateAction(schoolYearId: string, template: PlanTemplate): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  let v: { id: string; schoolYearId: string };
  try {
    v = await createFromTemplate(await getDb(), user.id, schoolYearId, template, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(versionsPage(schoolYearId, "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  redirect(`${versionsPage(v.schoolYearId, "angelegt", v.id)}&vorlage=${template}`);
}

/**
 * SP3-07: Vorlage „Neues Schuljahr“ – Entwurf im neuen Schuljahr aus dem Plan des Vorjahrs, hochgestuft (Klassen über `class_map`), oder
 * leer. Voraussetzung ist die Versetzung im Schuljahreswechsel; die Lehraufträge schlägt danach die Matrix vor („Aus dem Vorjahr übernehmen“).
 */
export async function createNewYearDraftAction(schoolYearId: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const base = form.get("base") === "leer" ? "leer" : "vorjahr";
  let v: { id: string; schoolYearId: string };
  try {
    v = await createNewYearDraft(await getDb(), user.id, schoolYearId, base, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(versionsPage(schoolYearId, "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  redirect(`${versionsPage(v.schoolYearId, "angelegt", v.id)}&vorlage=schuljahr`);
}

/** SP3-07: abgelaufenes Schuljahr archivieren (gültige Version → archiviert, offene Entwürfe verworfen; alles bleibt lesbar). */
export async function archiveYearAction(schoolYearId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await archivePlanYear(await getDb(), { userId: user.id, manage: true, review: false }, schoolYearId, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(versionsPage(schoolYearId, "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  redirect(versionsPage(schoolYearId, "archiviert", "1"));
}

/** Variante eines Entwurfs anlegen (gleiche Stunden, eigener Name). */
export async function createVariantAction(versionId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  let v: { id: string; schoolYearId: string };
  try {
    v = await createPlanVariant(db, user.id, versionId);
  } catch (err) {
    if (err instanceof ValidationError) redirect(versionsPage((await getPlanVersion(db, versionId))?.schoolYearId ?? null, "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  redirect(versionsPage(v.schoolYearId, "angelegt", v.id));
}

/** Entwurf verwerfen (bleibt als „verworfen“ in der Liste; gültige/archivierte Versionen nicht). */
export async function discardVersionAction(versionId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  let v: { id: string; schoolYearId: string };
  try {
    v = await discardPlanVersion(db, user.id, versionId);
  } catch (err) {
    if (err instanceof ValidationError) redirect(versionsPage((await getPlanVersion(db, versionId))?.schoolYearId ?? null, "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  redirect(versionsPage(v.schoolYearId, "verworfen", v.id));
}

// ---------------------------------------------------------------- Prüfung & Freigabe (SP3-03)

const reviewPage = (versionId: string, key?: string, value?: string) => {
  const q = new URLSearchParams({ version: versionId });
  if (key && value !== undefined) q.set(key, value);
  return `${VERSIONS_PAGE}/pruefung?${q.toString()}`;
};

/** Planung (`manage`) und/oder Prüfung (`review`) der angemeldeten Person – mindestens eins, sonst Abbruch. */
async function reviewViewer(): Promise<Viewer> {
  const { user, perms } = await requireUser();
  const viewer = { userId: user.id, manage: hasPermission(perms, PLAN_MANAGE), review: hasPermission(perms, PLAN_REVIEW) };
  if (!viewer.manage && !viewer.review) throw new ForbiddenError(`${PLAN_MANAGE} | ${PLAN_REVIEW}`);
  return viewer;
}

/**
 * Statuswechsel einer Version (Knopf) – Fehler als Hinweis auf der Prüfseite. Sieht die Person die Version danach nicht mehr (die Prüfung,
 * nachdem sie zurück an die Planung ging), geht es zur Versionsliste.
 */
async function versionStep(
  versionId: string,
  ok: string,
  step: (db: Awaited<ReturnType<typeof getDb>>, viewer: Viewer) => Promise<unknown>,
): Promise<void> {
  const viewer = await reviewViewer();
  const db = await getDb();
  let after: unknown;
  try {
    after = await step(db, viewer);
  } catch (err) {
    if (err instanceof ValidationError) redirect(reviewPage(versionId, "fehler", firstError(err)));
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  const v = after && typeof after === "object" && "status" in after ? (after as TimetablePlanVersion) : null;
  if (v && !canSeeVersion(viewer, v)) redirect(versionsPage(v.schoolYearId, "zurueck", "1"));
  redirect(reviewPage(versionId, "ok", ok));
}

/** Planung: Entwurf zur Prüfung geben (danach nur lesbar). */
export async function submitVersionAction(versionId: string): Promise<void> {
  await versionStep(versionId, "eingereicht", (db, viewer) => submitForReview(db, viewer, versionId));
}

/** Prüfung (Schulleitung): Version freigeben – ohne Vier-Augen-Zwang (F-10-3). */
export async function approveVersionAction(versionId: string): Promise<void> {
  await versionStep(versionId, "freigegeben", (db, viewer) => approveVersion(db, viewer, versionId));
}

/** Zurück an die Planung (Prüfung gibt zurück bzw. nimmt die Freigabe zurück; Planung holt die Version zurück), optional mit Kommentar. */
export async function returnVersionAction(versionId: string, form: FormData): Promise<void> {
  const note = String(form.get("note") ?? "");
  await versionStep(versionId, "zurueck", (db, viewer) => returnToPlanning(db, viewer, versionId, note));
}

/** Planung: Lehrkräfte-Vorschau „Mein Plan ab …“ ein-/ausschalten. */
export async function setPreviewAction(versionId: string, on: boolean): Promise<void> {
  await versionStep(versionId, on ? "vorschau-an" : "vorschau-aus", (db, viewer) => setTeacherPreview(db, viewer, versionId, on));
}

/** Kommentar der Planung/Prüfung an eine Version (Bezug: Version, Lehrkraft, Klasse/Kurs, Stunde). */
export async function addPlanCommentAction(versionId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const viewer = await reviewViewer();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const kind = str("targetKind") as PlanCommentTarget;
  try {
    await addPlanComment(await getDb(), viewer, versionId, {
      targetKind: kind,
      teacherId: str("teacherId") || null,
      groupId: str("groupId") || null,
      weekday: kind === "slot" && str("weekday") !== "" ? Number(str("weekday")) : null,
      periodNr: kind === "slot" && str("periodNr") !== "" ? Number(str("periodNr")) : null,
      body: String(form.get("body") ?? ""),
    });
  } catch (err) {
    if (err instanceof ValidationError) return { error: firstError(err), fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath(VERSIONS_PAGE);
  redirect(`${reviewPage(versionId, "ok", "kommentiert")}#kommentare`);
}

/** Planung: Kommentar erledigen bzw. wieder öffnen. */
export async function resolvePlanCommentAction(commentId: string, versionId: string, resolved: boolean): Promise<void> {
  await versionStep(versionId, resolved ? "erledigt" : "wieder-offen", (db, viewer) => resolvePlanComment(db, viewer, commentId, resolved));
}

/** Lehrkraft: Rückmeldung aus der Vorschau „Mein Plan ab …“ an die Planung (nur bei freigeschalteter Vorschau, nur zum eigenen Plan). */
export async function addPreviewCommentAction(versionId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireUser();
  if (user.role !== "lehrkraft") throw new ForbiddenError("lehrkraft");
  const slot = String(form.get("slot") ?? "").trim();
  const m = /^(\d)-(\d{1,2})$/.exec(slot);
  try {
    await addPreviewComment(await getDb(), user.id, versionId, { weekday: m ? Number(m[1]) : null, periodNr: m ? Number(m[2]) : null, body: String(form.get("body") ?? "") });
  } catch (err) {
    if (err instanceof ValidationError) return { error: firstError(err), fieldErrors: err.fieldErrors, values: formValues(form) };
    throw err;
  }
  revalidatePath("/stundenplan/vorschau");
  redirect(`/stundenplan/vorschau?version=${encodeURIComponent(versionId)}&gesendet=1`);
}

// ---------------------------------------------------------------- Veröffentlichen (SP3-04)

const publishPage = (versionId: string, key?: string, value?: string) => {
  const q = new URLSearchParams({ version: versionId });
  if (key && value !== undefined) q.set(key, value);
  return `/planung/versionen/veroeffentlichen?${q}`;
};

/** Freigegebene Version ab Stichtag veröffentlichen (nur `stundenplan.manage`); Fehler als Hinweis auf der Seite der Veröffentlichung. */
export async function publishVersionAction(versionId: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const from = String(form.get("from") ?? "").trim();
  let res: Awaited<ReturnType<typeof publishVersion>>;
  try {
    res = await publishVersion(await getDb(), user.id, versionId, from, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(withQuery(publishPage(versionId, "ab", from), "fehler", firstError(err)));
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(withQuery(publishPage(versionId, "ok", "veroeffentlicht"), "lehrkraefte", String(res.notifiedTeachers)));
}

/** „Veröffentlichung zurücknehmen“ – nur die gültige Version und nur bis zu ihrem Stichtag. */
export async function undoPublishAction(versionId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  let res: Awaited<ReturnType<typeof undoPublish>>;
  try {
    res = await undoPublish(await getDb(), user.id, versionId, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(withQuery(publishPage(versionId), "fehler", firstError(err)));
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(withQuery(withQuery(publishPage(versionId, "ok", "zurueckgenommen"), "vertretungen", String(res.substitutionsBack + res.restoredSubstitutions)), "material", String(res.materialsBack + res.restoredMaterials)));
}
