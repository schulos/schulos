"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { GANZTAG_MARK_STATUS, type GanztagMarkStatus } from "./schema";
import { createSeries, createSession, deleteSeries, deleteSession, setAllPresent, setListFeature, setMark, setOfferSettings, setSessionCancelled } from "./service";

// Rechte prüft der Service (Gruppenleitung bzw. „Ganztag verwalten“); moduleActions sperrt das ausgeschaltete Modul.
const { requireUser } = moduleActions("ganztag");

export interface ActionResult {
  error?: string;
  message?: string;
}

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, ...(form ? { values: formValues(form) } : {}) };
  throw err;
}

/** Fehlermeldung aus dem Service als Text (für Knöpfe ohne Formular). */
function failText(err: unknown): ActionResult {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben ungültig" };
  throw err;
}

export async function setListFeatureAction(groupId: string, on: boolean): Promise<ActionResult> {
  const { perms } = await requireUser();
  try {
    await setListFeature(await getDb(), perms, groupId, on);
  } catch (err) {
    return failText(err);
  }
  revalidatePath("/ganztag", "layout");
  return {};
}

export async function createSeriesAction(groupId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const r = await createSeries(await getDb(), perms, groupId, {
      weekday: Number(form.get("weekday")),
      startsAt: String(form.get("startsAt") ?? ""),
      endsAt: String(form.get("endsAt") ?? ""),
      validFrom: String(form.get("validFrom") ?? ""),
      validTo: String(form.get("validTo") ?? ""),
    });
    revalidatePath(`/ganztag/gruppe/${groupId}`);
    const skipped = r.skipped.length ? ` ${r.skipped.length === 1 ? "1 Tag" : `${r.skipped.length} Tage`} übersprungen (Ferien, Feiertage, unterrichtsfrei).` : "";
    return { ok: true, message: `${r.created === 1 ? "1 Termin" : `${r.created} Termine`} angelegt.${skipped}` };
  } catch (err) {
    return fail(err, form);
  }
}

export async function deleteSeriesAction(seriesId: string): Promise<ActionResult> {
  const { perms } = await requireUser();
  try {
    const r = await deleteSeries(await getDb(), perms, seriesId);
    revalidatePath("/ganztag", "layout");
    return { message: r.kept ? `Serie gelöscht; ${r.kept === 1 ? "1 erfasster Termin bleibt" : `${r.kept} erfasste Termine bleiben`}.` : "Serie gelöscht." };
  } catch (err) {
    return failText(err);
  }
}

export async function createSessionAction(groupId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await createSession(await getDb(), perms, groupId, {
      date: String(form.get("date") ?? ""),
      startsAt: String(form.get("startsAt") ?? ""),
      endsAt: String(form.get("endsAt") ?? ""),
    });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/ganztag/gruppe/${groupId}`);
  return { ok: true, message: "Termin angelegt." };
}

export async function setCancelledAction(sessionId: string, cancelled: boolean): Promise<ActionResult> {
  const { perms } = await requireUser();
  try {
    const sent = await setSessionCancelled(await getDb(), perms, sessionId, cancelled);
    revalidatePath("/ganztag", "layout");
    return { message: cancelled ? (sent ? "Ausfall vermerkt, Teilnehmende und Eltern sind benachrichtigt." : "Ausfall vermerkt.") : "Termin findet wieder statt." };
  } catch (err) {
    return failText(err);
  }
}

export async function deleteSessionAction(sessionId: string, back: boolean): Promise<ActionResult> {
  const { perms } = await requireUser();
  let groupId: string;
  try {
    groupId = await deleteSession(await getDb(), perms, sessionId);
  } catch (err) {
    return failText(err);
  }
  revalidatePath("/ganztag", "layout");
  if (back) redirect(`/ganztag/gruppe/${groupId}`);
  return {};
}

export async function setMarkAction(sessionId: string, studentId: string, status: string | null, minutesLate: number | null): Promise<ActionResult> {
  const { perms } = await requireUser();
  const s = status && (GANZTAG_MARK_STATUS as readonly string[]).includes(status) ? (status as GanztagMarkStatus) : null;
  try {
    await setMark(await getDb(), perms, sessionId, studentId, s, s === "verspaetet" ? minutesLate : null);
  } catch (err) {
    return failText(err);
  }
  revalidatePath(`/ganztag/termin/${sessionId}`);
  return {};
}

export async function setAllPresentAction(sessionId: string, on: boolean): Promise<ActionResult> {
  const { perms } = await requireUser();
  try {
    await setAllPresent(await getDb(), perms, sessionId, on);
  } catch (err) {
    return failText(err);
  }
  revalidatePath(`/ganztag/termin/${sessionId}`);
  return {};
}

/** GT-04: verpflichtend, Hinweis an die Klassenleitung, Vorbelegung aus den Abwesenheiten (nur „Ganztag verwalten“). */
export async function setOfferSettingsAction(groupId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await setOfferSettings(await getDb(), perms, groupId, {
      mandatory: form.get("mandatory") === "on",
      notifyClassLead: form.get("notifyClassLead") === "on",
      prefillAbsences: form.get("prefillAbsences") === "on",
    });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/ganztag/gruppe/${groupId}`);
  return { ok: true, message: "Einstellungen gespeichert." };
}
