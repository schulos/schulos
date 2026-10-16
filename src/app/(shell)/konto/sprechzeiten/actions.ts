"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { updateOwnOfficeHours, ValidationError } from "@/modules/verwaltung/users";

export interface OfficeHoursState {
  ok?: string;
  error?: string;
  values?: { officeHours: string };
}

/** Q5-25: eigene Sprechzeiten und Raum speichern (nur Rolle Beratung, nur das eigene Konto aus der Sitzung). */
export async function saveOfficeHoursAction(_prev: OfficeHoursState, form: FormData): Promise<OfficeHoursState> {
  const { user } = await requireUser();
  const officeHours = String(form.get("officeHours") ?? "");
  try {
    const saved = await updateOwnOfficeHours(await getDb(), user.id, officeHours);
    revalidatePath("/konto/sprechzeiten");
    revalidatePath("/adressbuch", "layout");
    return { ok: saved ? "Gespeichert – so steht es jetzt im Adressbuch." : "Gespeichert – im Adressbuch stehen keine Sprechzeiten mehr.", values: { officeHours: saved ?? "" } };
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich", values: { officeHours } };
    throw err;
  }
}
