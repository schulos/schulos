"use server";

// Notenbuch (P5-11/P5-12): Server Actions – Modulsperre über `moduleActions`, Rechte und Sichtbarkeit im Service. Fehlt die
// Zwei-Faktor-Anmeldung, wird keine Action ausgeführt: Weiterleitung zur Einrichtung (F5-07). Ist das Notenbuch für die
// Sitzung wegen Inaktivität gesperrt (P5-12), ebenso wenig: Weiterleitung auf die Sperrseite.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/core/auth/auth";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { endLiveStreams } from "@/core/notifications/bus";
import { ForbiddenError } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { COLUMN_KINDS, type Weights } from "./berechnung";
import { lockNotenbuch, notenbuchActivity, sessionHasSecondFactor, sessionOf } from "./guard";
import { acknowledgeNotice, noticeAcknowledged } from "./hinweis";
import { activateOfflineDevice, deactivateOfflineDevice, offlineShare, parseOp, syncOfflineOps, type OfflineReason } from "./offline";
import type { OfflineOp, SyncResult } from "./offline-sync";
import {
  addColumn,
  addColumnFromExam,
  adoptSuggestions,
  createBook,
  deleteColumn,
  EntryConflictError,
  lockBook,
  moveColumn,
  notenbuchAccess,
  NotenbuchTwoFactorError,
  setEntry,
  setFinalGrade,
  setWeights,
  transferBook,
  twoFactorReady,
  TWO_FACTOR_SETUP_HREF,
  unlockBook,
  updateColumn,
  type ColumnInput,
} from "./service";

const { requireUser } = moduleActions("notenbuch");

const today = () => toBerlinDate(new Date());
const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();

/** Wohin nach einer Sperre wegen Inaktivität: die Seite zeigt dann nur die Sperre. */
const LOCKED_HREF = "/notenbuch";

/**
 * Angemeldet, Modul an, Zwei-Faktor eingerichtet, Datenschutzhinweis bestätigt (P5-17), Notenbuch nicht gesperrt – sonst
 * Weiterleitung (Action läuft nicht).
 */
async function notenbuchUser() {
  const current = await requireUser();
  const db = await getDb();
  // GATE-5a (Schülerzugriff): ohne Notenbuch-Recht bzw. Klassenleitung (Schüler:innen, Eltern, Admin ohne Recht) läuft keine
  // Action – vor jeder weiteren Prüfung, unabhängig von Hinweis und Sitzung
  if (!(await notenbuchAccess(db, current.perms)).any) redirect(LOCKED_HREF);
  if (!(await twoFactorReady(db, current.perms))) redirect(TWO_FACTOR_SETUP_HREF);
  if (!(await noticeAcknowledged(db, current.perms.userId))) redirect(LOCKED_HREF);
  // gesperrt (Inaktivität) oder Sitzung ohne zweiten Faktor (G5A-S04): die Seite zeigt den Weg zur neuen Anmeldung
  if ((await notenbuchActivity(db, current.perms.userId)) !== "ok") redirect(LOCKED_HREF);
  return { perms: current.perms, db };
}

function fail(err: unknown, form?: FormData): FormState & { conflict?: boolean } {
  if (err instanceof NotenbuchTwoFactorError) redirect(TWO_FACTOR_SETUP_HREF);
  if (err instanceof EntryConflictError) return { error: Object.values(err.fieldErrors)[0], conflict: true };
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: form ? formValues(form) : undefined };
  if (err instanceof ForbiddenError) return { error: "Dieses Notenbuch gibt es nicht (mehr)." };
  throw err;
}

/** Spalten-Angaben aus dem Client – Typen erzwingen, Prüfung im Service. */
function columnInput(input: ColumnInput): ColumnInput {
  return {
    kind: String(input?.kind ?? ""),
    title: String(input?.title ?? ""),
    date: input?.date ? String(input.date) : null,
    weight: input?.weight === undefined ? undefined : Number(input.weight),
    maxPoints: input?.maxPoints === null || input?.maxPoints === undefined ? null : Number(input.maxPoints),
    key: Array.isArray(input?.key) ? input.key.slice(0, 20).map((k) => ({ min: Number(k?.min), grade: String(k?.grade ?? "") })) : null,
  };
}

export async function createBookAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  const [groupId, subjectId] = str(form, "option").split("|");
  try {
    await createBook(db, perms, { groupId: groupId ?? "", subjectId: subjectId ?? "", term: Number(str(form, "term")), scale: str(form, "scale") }, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/notenbuch");
  return { ok: true };
}

export async function addColumnAction(bookId: string, input: ColumnInput): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await addColumn(db, perms, String(bookId), columnInput(input));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  return { ok: true };
}

export async function updateColumnAction(bookId: string, columnId: string, input: ColumnInput): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await updateColumn(db, perms, String(columnId), columnInput(input));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  return { ok: true };
}

export async function deleteColumnAction(bookId: string, columnId: string): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await deleteColumn(db, perms, String(columnId));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  return { ok: true };
}

export async function moveColumnAction(bookId: string, columnId: string, direction: number): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await moveColumn(db, perms, String(columnId), Number(direction));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  return { ok: true };
}

export async function addExamColumnAction(bookId: string, examId: string): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await addColumnFromExam(db, perms, String(bookId), String(examId));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  return { ok: true };
}

export async function setWeightsAction(bookId: string, weights: Weights): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  const clean: Weights = Object.fromEntries(COLUMN_KINDS.map((k) => [k, Number(weights?.[k] ?? 0)]));
  try {
    await setWeights(db, perms, String(bookId), clean);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  return { ok: true };
}

export async function setEntryAction(input: {
  columnId: string;
  studentId: string;
  value: string;
  comment?: string | null;
  expectedVersion?: number;
}): Promise<FormState & { version?: number; conflict?: boolean }> {
  const { perms, db } = await notenbuchUser();
  try {
    const version = await setEntry(db, perms, {
      columnId: String(input?.columnId ?? ""),
      studentId: String(input?.studentId ?? ""),
      value: String(input?.value ?? ""),
      comment: input?.comment == null ? null : String(input.comment),
      expectedVersion: input?.expectedVersion === undefined ? undefined : Number(input.expectedVersion),
    });
    return { ok: true, version };
  } catch (err) {
    return fail(err);
  }
}

export async function transferBookAction(bookId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await transferBook(db, perms, bookId, { toTeacherId: str(form, "toTeacherId"), removeTeacherId: str(form, "removeTeacherId") || null });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/notenbuch");
  return { ok: true };
}

// ------------------------------------------------------------------ Halbjahresabschluss (P5-13)

/** Halbjahresnote einer Person festlegen bzw. (leer) zurücknehmen – ohne Neuaufbau der Seite (die Tabelle zeigt sie schon). */
export async function setFinalAction(bookId: string, studentId: string, value: string): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await setFinalGrade(db, perms, String(bookId), String(studentId), String(value ?? ""));
  } catch (err) {
    return fail(err);
  }
  return { ok: true };
}

export async function adoptSuggestionsAction(bookId: string): Promise<FormState & { count?: number }> {
  const { perms, db } = await notenbuchUser();
  let count = 0;
  try {
    count = await adoptSuggestions(db, perms, String(bookId));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  return { ok: true, count };
}

export async function lockBookAction(bookId: string): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await lockBook(db, perms, String(bookId));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/notenbuch/${bookId}`);
  revalidatePath("/notenbuch");
  return { ok: true };
}

export async function unlockBookAction(bookId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms, db } = await notenbuchUser();
  try {
    await unlockBook(db, perms, String(bookId), str(form, "reason"));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/notenbuch");
  return { ok: true };
}

// ------------------------------------------------------------------ Inaktivitätsablauf (P5-12)

/** Lebenszeichen der Seite bei Tastatur-/Mauseingaben – `locked: true`, wenn das Notenbuch inzwischen gesperrt ist. */
export async function notenbuchKeepAliveAction(): Promise<{ locked: boolean }> {
  const current = await requireUser();
  return { locked: (await notenbuchActivity(await getDb(), current.perms.userId)) !== "ok" };
}

/** Die Seite meldet: so lange keine Eingabe – Notenbuch für diese Sitzung sperren. */
export async function lockNotenbuchAction(): Promise<void> {
  const current = await requireUser();
  await lockNotenbuch(await getDb(), current.perms.userId);
}

/** Entsperren = neu anmelden (neue Sitzung, mit zweitem Faktor). */
export async function notenbuchReloginAction(): Promise<void> {
  const auth = await getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  await auth.api.signOut({ headers: h });
  if (session) endLiveStreams(session.user.id);
  redirect("/login?next=%2Fnotenbuch");
}

// ------------------------------------------------------------------ Offline-Eingabe auf Dienstgeräten (P5-20)

/** Sitzungskennung der Anfrage – ohne Sitzung läuft keine Offline-Action (Weiterleitung zur Sperre). */
async function offlineSession(userId: string): Promise<string> {
  const s = await sessionOf(await headers());
  if (!s || s.userId !== userId) redirect(LOCKED_HREF);
  return s.sessionId;
}

/** Offline-Eingabe auf diesem Gerät einschalten – liefert den Server-Anteil des Cache-Schlüssels einmalig (offline.ts). */
export async function offlineActivateAction(deviceId: string, confirmed: boolean): Promise<FormState & { share?: string; expiresAt?: string; reason?: OfflineReason }> {
  const { perms, db } = await notenbuchUser();
  const sessionId = await offlineSession(perms.userId);
  try {
    const r = await activateOfflineDevice(db, perms, await headers(), { deviceId: String(deviceId ?? ""), sessionId, confirmed: confirmed === true });
    return { ok: true, share: r.share, expiresAt: r.expiresAt.toISOString(), reason: r.reason };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Server-Anteil für ein eingeschaltetes Gerät (bei jedem Öffnen der Notentabelle). `gone`: Gerät unbekannt oder nicht mehr
 * erlaubt – der Browser löscht seinen Cache. `keep: false`: nur noch offene Änderungen übertragen, dann löschen.
 */
export async function offlineShareAction(deviceId: string): Promise<{ gone: true } | { gone: false; share: string; keep: boolean; expiresAt: string; reason: OfflineReason }> {
  const { perms, db } = await notenbuchUser();
  const sessionId = await offlineSession(perms.userId);
  const r = await offlineShare(db, perms, await headers(), { deviceId: String(deviceId ?? ""), sessionId });
  if (!r) return { gone: true };
  return { gone: false, share: r.share, keep: r.keep, expiresAt: r.expiresAt.toISOString(), reason: r.reason };
}

/** Offline-Eingabe auf diesem Gerät ausschalten (Server-Anteil weg → Cache unlesbar; der Browser löscht ihn zusätzlich). */
export async function offlineDeactivateAction(deviceId: string): Promise<void> {
  const { perms, db } = await notenbuchUser();
  await deactivateOfflineDevice(db, perms, String(deviceId ?? ""));
}

/** Offline-Änderungen eines Buchs abgleichen – idempotent, Konflikte kommen unverändert zurück (offline-sync.ts). */
export async function offlineSyncAction(bookId: string, deviceId: string | null, ops: OfflineOp[]): Promise<FormState & { results?: SyncResult[] }> {
  const { perms, db } = await notenbuchUser();
  const clean = (Array.isArray(ops) ? ops : []).map(parseOp).filter((o): o is OfflineOp => o !== null);
  try {
    const results = await syncOfflineOps(db, perms, String(bookId ?? ""), clean, deviceId ? String(deviceId) : null);
    return { ok: true, results };
  } catch (err) {
    return fail(err);
  }
}

/**
 * P5-17: Datenschutzhinweis bestätigen (Kästchen „gelesen“ Pflicht). Nur mit Zwei-Faktor und Notenbuch-Zugang; zählt nicht als
 * Aktivität im Notenbuch. Danach lädt die Seite neu.
 */
export async function acknowledgeNoticeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const current = await requireUser();
  const db = await getDb();
  if (!(await twoFactorReady(db, current.perms))) redirect(TWO_FACTOR_SETUP_HREF);
  if (!(await sessionHasSecondFactor(db, current.perms.userId))) redirect(LOCKED_HREF);
  if (form.get("gelesen") !== "1") return { error: "Bitte bestätige, dass du den Hinweis gelesen hast." };
  try {
    await acknowledgeNotice(db, current.perms);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/notenbuch", "layout");
  return { ok: true };
}
