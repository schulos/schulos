"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import {
  admissionCredentialsCsv,
  admitStudents,
  regenerateAdmissionPasswords,
  type AdmissionCredential,
  type AdmissionInput,
  type AdmissionResult,
} from "@/modules/anmeldung/uebernahme";
import { confirmHandover } from "@/modules/klassenbuch/archiv";
import type { FormState } from "./actions";
import { addNextSchoolYear } from "./school-years";
import { archiveYearGroups, completeTransition, confirmReview, promote, startTransition, type PromotionInput } from "./schuljahreswechsel";
import { ValidationError } from "./users";

const PAGE = "/verwaltung/schuljahreswechsel";
const PERM = "verwaltung.privacy";

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError)
    return {
      error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen",
      fieldErrors: err.fieldErrors,
      values: form ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])) : undefined,
    };
  throw err;
}

async function step(form: FormData | null, run: (actorId: string) => Promise<unknown>): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await run(user.id);
  } catch (err) {
    return fail(err, form ?? undefined);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function addYearAction(): Promise<void> {
  const { user } = await requirePermission(PERM);
  await addNextSchoolYear(await getDb(), user.id);
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function startTransitionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await getDb();
  return step(form, (actor) => startTransition(db, actor, String(form.get("fromYearId") ?? ""), String(form.get("toYearId") ?? "")));
}

export async function promoteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await getDb();
  const input: PromotionInput = { classes: [], overrides: {} };
  for (const [k, v] of form.entries()) {
    const val = String(v).trim();
    if (k.startsWith("to:")) input.classes.push({ groupId: k.slice(3), toName: val, keepLeaders: form.get(`lead:${k.slice(3)}`) === "1" });
    else if (k.startsWith("s:") && val) input.overrides[k.slice(2)] = val;
  }
  return step(form, (actor) => promote(db, actor, String(form.get("transitionId") ?? ""), input));
}

export async function archiveGroupsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await getDb();
  return step(form, (actor) => archiveYearGroups(db, actor, String(form.get("transitionId") ?? "")));
}

export async function reviewAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await getDb();
  return step(form, (actor) => confirmReview(db, actor, String(form.get("transitionId") ?? ""), form.get("confirm") === "1"));
}

export async function completeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await getDb();
  return step(form, (actor) => completeTransition(db, actor, String(form.get("transitionId") ?? "")));
}

export async function handoverAction(form: FormData): Promise<void> {
  const { user } = await requirePermission(PERM);
  await confirmHandover(await getDb(), user.id, String(form.get("groupId") ?? ""));
  revalidatePath(PAGE);
}

export type AdmissionsState = FormState & { result?: AdmissionResult; csv?: string };

/**
 * Schritt „Neuaufnahmen“ (P4-39): braucht zusätzlich `verwaltung.users` (legt Konten an) und das eingeschaltete Modul
 * Schulanmeldung. Ohne revalidate – die Zugangsdaten werden einmalig angezeigt, „Weiter“ lädt danach die Seite neu.
 */
export async function admissionsAction(_prev: AdmissionsState, form: FormData): Promise<AdmissionsState> {
  const { user, perms } = await requirePermission(PERM);
  // GATE-4c (Code-M4): „Niemanden übernehmen“ legt keine Konten an und braucht daher kein „Benutzer verwalten“
  const skipAll = form.get("skipAll") === "on";
  if (!skipAll && !hasPermission(perms, "verwaltung.users")) return { error: "Für die Neuaufnahmen braucht es das Recht „Benutzer verwalten“." };
  if (!(await moduleOn("anmeldung"))) return { error: "Die Schulanmeldung ist ausgeschaltet." };
  const linkSuggested: string[] = [];
  const linkSuggested2: string[] = [];
  const input: AdmissionInput = { classes: {}, assign: {}, skipAll, linkSuggested, linkSuggested2 };
  for (const [k, v] of form.entries()) {
    const val = String(v).trim();
    if (k.startsWith("classes:")) input.classes[Number(k.slice(8))] = val.split(/[\s,;]+/).filter(Boolean);
    else if (k.startsWith("a:")) input.assign[k.slice(2)] = val;
    // Q5-20: Haken am Vorschlag (unbestätigte E-Mail) – nur die Antrags-ID, das Konto ermittelt der Server neu
    else if (k.startsWith("link:") && val === "1") linkSuggested.push(k.slice(5));
    // Q5-23: dasselbe für den zweiten Elternteil
    else if (k.startsWith("link2:") && val === "1") linkSuggested2.push(k.slice(6));
  }
  try {
    const result = await admitStudents(await getDb(), user.id, String(form.get("transitionId") ?? ""), input);
    return { ok: true, result, csv: admissionCredentialsCsv(result.credentials) };
  } catch (err) {
    return fail(err, form);
  }
}

export type RegeneratePasswordsState = FormState & { list?: AdmissionCredential[]; skipped?: number; csv?: string };

/**
 * Q5-21: Startpasswörter der im Schritt „Neuaufnahmen“ angelegten Konten neu erzeugen (Anzeige ging verloren). Braucht wie das
 * Anlegen `verwaltung.users`; ohne revalidate – die neuen Passwörter werden einmalig angezeigt.
 */
export async function regeneratePasswordsAction(_prev: RegeneratePasswordsState, form: FormData): Promise<RegeneratePasswordsState> {
  const { user, perms } = await requirePermission(PERM);
  if (!hasPermission(perms, "verwaltung.users")) return { error: "Dafür braucht es das Recht „Benutzer verwalten“." };
  if (form.get("confirm") !== "1") return { error: "Bitte bestätigen, dass die bisher ausgegebenen Startpasswörter ungültig werden." };
  try {
    const r = await regenerateAdmissionPasswords(await getDb(), user.id, String(form.get("transitionId") ?? ""));
    return { ok: true, list: r.credentials, skipped: r.skipped, csv: admissionCredentialsCsv(r.credentials) };
  } catch (err) {
    return fail(err, form);
  }
}
