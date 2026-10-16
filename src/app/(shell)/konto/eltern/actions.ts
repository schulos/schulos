"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ValidationError } from "@/modules/verwaltung/users";
import { setParentsInformed } from "@/modules/verwaltung/volljaehrig";

export interface ParentsInformedState {
  ok?: string;
  error?: string;
}

/** Q5-05: Einwilligung „Eltern weiter informieren“ – nur das eigene Konto aus der Sitzung, nur eigenständige Schüler:innen. */
export async function setParentsInformedAction(on: boolean): Promise<ParentsInformedState> {
  const { user } = await requireUser();
  try {
    await setParentsInformed(await getDb(), user.id, on);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich" };
    throw err;
  }
  revalidatePath("/konto/eltern");
  return { ok: on ? "Deine Eltern werden weiter informiert." : "Deine Eltern sehen deine Daten nicht mehr." };
}
