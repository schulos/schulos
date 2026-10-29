"use server";

// RS-10/RS-11: Gebäude und Etagen (Stammdaten, `verwaltung.school`) und Tür-QR neu erzeugen (`canEditRoomInfo`). Rechte prüft
// der Service; hier zusätzlich `requireUser`, damit nur Angemeldete ohne Sperre ankommen.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { roomHref } from "@/core/room-href";
import type { FormState } from "./actions";
import { createBuilding, createFloor, deleteBuilding, deleteFloor, updateBuilding, updateFloor, type PlaceInput } from "./gebaeude-etagen";
import { renewRoomCode } from "./tuer-qr";
import { ValidationError } from "./users";

function values(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (!k.startsWith("$")) out[k] = String(v);
  return out;
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: values(form) };
  throw err;
}

const readPlace = (form: FormData): PlaceInput => ({ name: String(form.get("name") ?? ""), sortOrder: String(form.get("sortOrder") ?? "") });

async function run(form: FormData, fn: (db: Awaited<ReturnType<typeof getDb>>, perms: Awaited<ReturnType<typeof requireUser>>["perms"]) => Promise<unknown>): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await fn(await getDb(), perms);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function createBuildingAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, (db, perms) => createBuilding(db, perms, readPlace(form)));
}

export async function updateBuildingAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  return run(form, (db, perms) => updateBuilding(db, perms, id, readPlace(form)));
}

export async function deleteBuildingAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  return run(form, (db, perms) => deleteBuilding(db, perms, id));
}

export async function createFloorAction(buildingId: string, _prev: FormState, form: FormData): Promise<FormState> {
  return run(form, (db, perms) => createFloor(db, perms, buildingId, readPlace(form)));
}

export async function updateFloorAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  return run(form, (db, perms) => updateFloor(db, perms, id, readPlace(form)));
}

export async function deleteFloorAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  return run(form, (db, perms) => deleteFloor(db, perms, id));
}

/** RS-11: neuen Tür-QR-Code erzeugen – zurück in den Steckbrief mit Hinweis. */
export async function renewRoomCodeAction(roomId: string): Promise<void> {
  const { perms } = await requireUser();
  await renewRoomCode(await getDb(), perms, roomId);
  revalidatePath(roomHref(roomId));
  redirect(`${roomHref(roomId)}?qr=neu#tuer-qr`);
}
