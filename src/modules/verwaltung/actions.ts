"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { unlockLogin } from "@/core/auth/sperre";
import { resetTwoFactor } from "@/core/auth/zwei-faktor";
import { getDb } from "@/core/db/client";
import { ROLES, type Role } from "@/core/db/schema";
import { formValues } from "@/core/form-values";
import { createParentForChild, linkParentByUsername, unlinkParent } from "./eltern";
import { readSchoolSettings } from "@/core/settings";
import { setSelfResponsible } from "./volljaehrig";
import { createUser, resetPassword, sendEmailConfirmation, setUserLocked, updateUser, ValidationError, type UserInput } from "./users";

export interface FormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Einmalig angezeigte Zugangsdaten nach Anlegen/Reset */
  credentials?: { username: string; password: string };
  /** Eingaben nach einem Fehler – React setzt Formulare nach einer Action zurück */
  values?: Record<string, string>;
  /** Erfolgsmeldung mit Einzelheiten (statt des Standardtexts) */
  message?: string;
}

function readUserInput(form: FormData): UserInput {
  const role = String(form.get("role") ?? "");
  return {
    firstName: String(form.get("firstName") ?? ""),
    lastName: String(form.get("lastName") ?? ""),
    role: (ROLES as readonly string[]).includes(role) ? (role as Role) : ("" as Role),
    shortCode: String(form.get("shortCode") ?? "") || null,
    username: String(form.get("username") ?? "") || null,
    // fehlt das Feld (z. B. ältere Formulare), bleibt die Adresse unverändert
    email: form.has("email") ? String(form.get("email") ?? "") : undefined,
    officeHours: String(form.get("officeHours") ?? "") || null,
  };
}

function toState(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError) return { fieldErrors: err.fieldErrors, error: "Bitte die markierten Felder prüfen.", ...(form ? { values: formValues(form) } : {}) };
  throw err;
}

/** Fehler als eine Meldung in Alltagssprache (für Knöpfe ohne Formularfelder). */
function firstError(err: unknown): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich.", fieldErrors: err.fieldErrors };
  throw err;
}

export async function createUserAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    const res = await createUser(await getDb(), user.id, readUserInput(form));
    revalidatePath("/verwaltung/benutzer");
    return { ok: true, credentials: { username: res.username, password: res.password } };
  } catch (err) {
    return toState(err, form);
  }
}

export async function updateUserAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    await updateUser(await getDb(), user.id, id, readUserInput(form));
    revalidatePath(`/verwaltung/benutzer/${id}`);
    return { ok: true };
  } catch (err) {
    return toState(err, form);
  }
}

export async function setLockedAction(id: string, locked: boolean): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    await setUserLocked(await getDb(), user.id, id, locked);
    revalidatePath(`/verwaltung/benutzer/${id}`);
    return { ok: true };
  } catch (err) {
    return firstError(err);
  }
}

/** Vorübergehende Anmeldesperre nach Fehlversuchen vorzeitig aufheben. */
export async function unlockLoginAction(form: FormData): Promise<void> {
  const { user } = await requirePermission("verwaltung.users");
  await unlockLogin(await getDb(), user.id, String(form.get("username") ?? ""));
  revalidatePath("/verwaltung");
}

/** Verlorenes Gerät ohne Codes: 2FA zurücksetzen (nicht für sich selbst – dafür gibt es die Wiederherstellungscodes). */
export async function resetTwoFactorAction(id: string): Promise<FormState> {
  // SEC-02: eigenes Recht (Vorgabe Rolle Verwaltung = Sekretariat), Protokoll + Gong im Service
  const { user } = await requirePermission("verwaltung.zwei_faktor");
  if (id === user.id) return { error: "Das eigene Konto lässt sich hier nicht zurücksetzen." };
  try {
    await resetTwoFactor(await getDb(), user.id, id);
  } catch (err) {
    return firstError(err);
  }
  revalidatePath(`/verwaltung/benutzer/${id}`);
  return { ok: true };
}

export async function resetPasswordAction(id: string): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    const password = await resetPassword(await getDb(), user.id, id);
    return { ok: true, credentials: { username: "", password } };
  } catch (err) {
    return firstError(err);
  }
}

/** Q5-24: Bestätigungslink an die eingetragene, unbestätigte Adresse senden (Rate-Limit, Audit, nur mit SMTP). */
export async function sendEmailConfirmationAction(id: string): Promise<FormState & { sentTo?: string }> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    const db = await getDb();
    const sentTo = await sendEmailConfirmation(db, user.id, id, { school: (await readSchoolSettings(db)).name });
    return { ok: true, sentTo };
  } catch (err) {
    return firstError(err);
  }
}

// ---------------------------------------------------------------- Elternkonten (P4-38)

/** Neues Elternkonto zum Kind anlegen – Zugangsdaten werden einmalig angezeigt. */
export async function createParentAction(childId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    const res = await createParentForChild(await getDb(), user.id, childId, {
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      email: String(form.get("email") ?? "") || null,
    });
    revalidatePath(`/verwaltung/benutzer/${childId}`);
    return { ok: true, credentials: { username: res.username, password: res.password } };
  } catch (err) {
    return toState(err, form);
  }
}

/** Vorhandenes Elternkonto (Benutzername) mit dem Kind verknüpfen. */
export async function linkParentAction(childId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    await linkParentByUsername(await getDb(), user.id, childId, String(form.get("username") ?? ""));
  } catch (err) {
    return toState(err, form);
  }
  revalidatePath(`/verwaltung/benutzer/${childId}`);
  return { ok: true };
}

export async function unlinkParentAction(parentId: string, childId: string): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    await unlinkParent(await getDb(), user.id, parentId, childId);
  } catch (err) {
    return firstError(err);
  }
  revalidatePath(`/verwaltung/benutzer/${childId}`);
  revalidatePath(`/verwaltung/benutzer/${parentId}`);
  return { ok: true };
}

/** Q5-05: Kennzeichen „eigenständig (volljährig)“ setzen bzw. entfernen. */
export async function setSelfResponsibleAction(id: string, on: boolean): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    await setSelfResponsible(await getDb(), user.id, id, on);
  } catch (err) {
    return firstError(err);
  }
  revalidatePath(`/verwaltung/benutzer/${id}`);
  return { ok: true };
}
