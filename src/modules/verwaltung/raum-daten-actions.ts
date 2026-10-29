"use server";

// RS-04…RS-06: Fotos, Ausstattung und Verantwortliche im Raumsteckbrief, Ausstattungskatalog aufräumen. Rechte prüft der Service
// (`canEditRoomInfo`, `canMaintainAllRooms`, `canManageInfoFields`); hier zusätzlich `requireUser`. Verwaltung ist ein Kernmodul (nicht abschaltbar).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { ForbiddenError } from "@/core/permissions";
import type { LayoutCells } from "@/core/raumlayout-raster";
import { roomHref } from "@/core/room-href";
import type { FormState } from "./actions";
import { addRoomEquipment, deleteEquipmentType, mergeEquipmentTypes, renameEquipmentType, setRoomEquipmentQuantities } from "./raumausstattung";
import { addRoomPhoto, deleteRoomPhoto, setCoverPhoto, setPhotoCaption } from "./raumfotos";
import { createRoomLayout, deleteRoomLayout, setDefaultRoomLayout, updateRoomLayout } from "./raumlayout";
import { addResponsible, removeResponsible } from "./raumverantwortliche";
import { ValidationError } from "./users";

const CATALOG_PAGE = "/verwaltung/stammdaten/raeume/ausstattung";

function values(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (!k.startsWith("$") && typeof v === "string") out[k] = v;
  return out;
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: values(form) };
  throw err;
}

function touchRoom(roomId: string) {
  revalidatePath(roomHref(roomId));
  revalidatePath("/raeume");
}

// ---------------------------------------------------------------- Fotos (RS-04)

export async function addRoomPhotoAction(roomId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const file = form.get("photo");
  const photo = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  try {
    await addRoomPhoto(await getDb(), getStorage(), perms, roomId, { photo, caption: String(form.get("caption") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  touchRoom(roomId);
  return { ok: true };
}

export async function setPhotoCaptionAction(roomId: string, photoId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await setPhotoCaption(await getDb(), perms, photoId, String(form.get("caption") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  touchRoom(roomId);
  return { ok: true };
}

export async function setCoverPhotoAction(roomId: string, photoId: string): Promise<void> {
  const { perms } = await requireUser();
  await setCoverPhoto(await getDb(), perms, photoId);
  touchRoom(roomId);
}

export async function deleteRoomPhotoAction(roomId: string, photoId: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteRoomPhoto(await getDb(), getStorage(), perms, photoId);
  touchRoom(roomId);
}

// ---------------------------------------------------------------- Ausstattung am Raum (RS-05)

export async function addRoomEquipmentAction(roomId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await addRoomEquipment(await getDb(), perms, roomId, { name: String(form.get("name") ?? ""), quantity: String(form.get("quantity") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  touchRoom(roomId);
  return { ok: true };
}

/** Mengen speichern: Formularfelder `menge.<katalog-id>` (0 entfernt). */
export async function saveRoomEquipmentAction(roomId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const input: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("menge.")) input[k.slice(6)] = String(v);
  try {
    await setRoomEquipmentQuantities(await getDb(), perms, roomId, input);
  } catch (err) {
    if (err instanceof ValidationError) {
      const fe = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [`menge.${k}`, v]));
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: fe, values: values(form) };
    }
    throw err;
  }
  touchRoom(roomId);
  return { ok: true };
}

// ---------------------------------------------------------------- Raumlayouts (RS-08)

/** Editor: Layout anlegen (`layoutId` null) oder speichern – Name, Variante, Raster in einem Schritt. */
export async function saveRoomLayoutAction(
  roomId: string,
  layoutId: string | null,
  input: { name: string; variant: string; rows: number; cols: number; cells: LayoutCells },
): Promise<FormState & { id?: string }> {
  const { perms } = await requireUser();
  const cells: LayoutCells = {};
  if (input?.cells && typeof input.cells === "object" && !Array.isArray(input.cells)) for (const [k, v] of Object.entries(input.cells)) cells[String(k)] = String(v) as LayoutCells[string];
  const clean = { name: String(input?.name ?? ""), variant: String(input?.variant ?? ""), rows: Number(input?.rows), cols: Number(input?.cols), cells };
  let id = layoutId ?? undefined;
  try {
    const db = await getDb();
    if (layoutId) await updateRoomLayout(db, perms, layoutId, clean);
    else id = await createRoomLayout(db, perms, roomId, clean);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    if (err instanceof ForbiddenError) return { error: "Dieses Layout darfst du nicht bearbeiten." };
    throw err;
  }
  touchRoom(roomId);
  revalidatePath(`${roomHref(roomId)}/layout`);
  return { ok: true, id };
}

export async function setDefaultRoomLayoutAction(roomId: string, layoutId: string): Promise<void> {
  const { perms } = await requireUser();
  await setDefaultRoomLayout(await getDb(), perms, layoutId);
  touchRoom(roomId);
  revalidatePath(`${roomHref(roomId)}/layout`);
}

export async function deleteRoomLayoutAction(roomId: string, layoutId: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteRoomLayout(await getDb(), perms, layoutId);
  touchRoom(roomId);
  redirect(`${roomHref(roomId)}/layout`);
}

// ---------------------------------------------------------------- Raumverantwortliche (RS-06)

export async function addResponsibleAction(roomId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await addResponsible(await getDb(), perms, roomId, { target: String(form.get("target") ?? ""), note: String(form.get("note") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  touchRoom(roomId);
  return { ok: true };
}

export async function removeResponsibleAction(roomId: string, id: string): Promise<void> {
  const { perms } = await requireUser();
  await removeResponsible(await getDb(), perms, id);
  touchRoom(roomId);
}

// ---------------------------------------------------------------- Katalog aufräumen (RS-05, Verwaltung)

export async function renameEquipmentTypeAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await renameEquipmentType(await getDb(), perms, id, String(form.get("name") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function mergeEquipmentTypeAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await mergeEquipmentTypes(await getDb(), perms, id, String(form.get("into") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  revalidatePath(CATALOG_PAGE);
  return { ok: true };
}

export async function deleteEquipmentTypeAction(id: string): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await deleteEquipmentType(await getDb(), perms, id);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich" };
    throw err;
  }
  revalidatePath(CATALOG_PAGE);
  return { ok: true };
}
