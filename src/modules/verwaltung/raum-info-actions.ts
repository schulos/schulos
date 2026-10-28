"use server";

// RS-03: Infofelder des Raumsteckbriefs. Rechte prüft der Service (`canEditRoomInfo`, `canManageInfoFields`); hier zusätzlich
// `requireUser`, damit nur Angemeldete ohne Sperre überhaupt ankommen. Verwaltung ist ein Kernmodul (nicht abschaltbar).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { roomHref as steckbriefHref } from "@/core/room-href";
import type { FormState } from "./actions";
import { createInfoField, deleteInfoField, setRoomInfo, updateInfoField, type InfoFieldInput } from "./raumsteckbrief";
import { ValidationError } from "./users";

const FIELDS_PAGE = "/verwaltung/stammdaten/raeume/infofelder";

function values(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (!k.startsWith("$")) out[k] = String(v);
  return out;
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: values(form) };
  throw err;
}

const readField = (form: FormData): InfoFieldInput => ({
  label: String(form.get("label") ?? ""),
  visibility: String(form.get("visibility") ?? ""),
  sortOrder: String(form.get("sortOrder") ?? ""),
});

/** Infofelder eines Raums speichern: Formularfelder `info.<feld-id>`. */
export async function saveRoomInfoAction(roomId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const input: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("info.")) input[k.slice(5)] = String(v);
  try {
    await setRoomInfo(await getDb(), perms, roomId, input);
  } catch (err) {
    if (err instanceof ValidationError) {
      const fe = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [`info.${k}`, v]));
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: fe, values: values(form) };
    }
    throw err;
  }
  revalidatePath(steckbriefHref(roomId));
  redirect(`${steckbriefHref(roomId)}?gespeichert=1#infofelder`);
}

export async function createInfoFieldAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await createInfoField(await getDb(), perms, readField(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function updateInfoFieldAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateInfoField(await getDb(), perms, id, readField(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteInfoFieldAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteInfoField(await getDb(), perms, id);
  revalidatePath("/", "layout");
  redirect(FIELDS_PAGE);
}
