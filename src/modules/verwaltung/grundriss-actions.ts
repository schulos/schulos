"use server";

// RS-13: Grundriss je Etage hochladen/ersetzen/löschen, Alternativtext ändern, Räume als Punkt verorten. Rechte prüft der
// Service (`verwaltung.school`); hier zusätzlich `requireUser`. Verwaltung ist ein Kernmodul (nicht abschaltbar).
import { revalidatePath } from "next/cache";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import type { FormState } from "./actions";
import { deleteFloorPlan, parsePlanPercent, setFloorPlan, setFloorPlanAlt, setRoomPlanPoint } from "./grundriss";
import { ValidationError } from "./users";

function values(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (!k.startsWith("$") && typeof v === "string") out[k] = v;
  return out;
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: values(form) };
  throw err;
}

function touch() {
  // Raumfinder, Steckbriefe und die Pflegeseite zeigen den Plan
  revalidatePath("/raeume", "layout");
  revalidatePath("/verwaltung/stammdaten/raeume/gebaeude", "layout");
}

export async function setFloorPlanAction(floorId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const file = form.get("plan");
  const image = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  try {
    await setFloorPlan(await getDb(), getStorage(), perms, floorId, { image, alt: String(form.get("alt") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  touch();
  return { ok: true };
}

export async function setFloorPlanAltAction(floorId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await setFloorPlanAlt(await getDb(), perms, floorId, String(form.get("alt") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  touch();
  return { ok: true };
}

export async function deleteFloorPlanAction(floorId: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteFloorPlan(await getDb(), getStorage(), perms, floorId);
  touch();
}

/** Punkt setzen (Felder `room`, `x`, `y` in Prozent) bzw. mit `remove=1` entfernen. */
export async function setRoomPlanPointAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const room = String(form.get("room") ?? "");
  try {
    if (!room) throw new ValidationError({ room: "Bitte einen Raum wählen" });
    if (form.get("remove") === "1") await setRoomPlanPoint(await getDb(), perms, room, null);
    else {
      const x = parsePlanPercent(String(form.get("x") ?? ""), "x");
      const y = parsePlanPercent(String(form.get("y") ?? ""), "y");
      if (x === null || y === null) throw new ValidationError({ [x === null ? "x" : "y"]: "Bitte auf den Plan tippen oder beide Werte eintragen" });
      await setRoomPlanPoint(await getDb(), perms, room, { x, y });
    }
  } catch (err) {
    return fail(err, form);
  }
  touch();
  return { ok: true, values: { room } };
}
