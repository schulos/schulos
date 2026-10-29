"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { FormState } from "./actions";
import { parsePlaceValue } from "./gebaeude-etagen";
import { createRoom, deleteRoom, setRoomActive, updateRoom, type RoomInput } from "./rooms";
import { ValidationError } from "./users";

const PERM = "verwaltung.school";
const LIST = "/verwaltung/stammdaten?bereich=raeume";

function readRoom(form: FormData): RoomInput {
  return {
    code: String(form.get("code") ?? ""),
    name: String(form.get("name") ?? ""),
    kind: String(form.get("kind") ?? ""),
    // RS-10: eine Auswahl „Gebäude und Etage“ (f:<etage> bzw. b:<gebäude>)
    ...parsePlaceValue(String(form.get("place") ?? "")),
    capacity: String(form.get("capacity") ?? ""),
    accessible: form.get("accessible") === "on",
    active: form.get("active") === "on",
  };
}

function values(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (!k.startsWith("$")) out[k] = k in out ? `${out[k]},${String(v)}` : String(v);
  return out;
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: values(form) };
  throw err;
}

export async function createRoomAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await createRoom(await getDb(), user.id, readRoom(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(LIST);
}

export async function updateRoomAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await updateRoom(await getDb(), user.id, id, readRoom(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(LIST);
}

export async function deleteRoomAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await deleteRoom(await getDb(), user.id, id);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(LIST);
}

/** Raum stilllegen (`active=false`) bzw. wieder in Betrieb nehmen – ohne die übrigen Felder anzufassen. */
export async function setRoomActiveAction(id: string, active: boolean): Promise<void> {
  const { user } = await requirePermission(PERM);
  await setRoomActive(await getDb(), user.id, id, active);
  revalidatePath("/", "layout");
  redirect(LIST);
}
