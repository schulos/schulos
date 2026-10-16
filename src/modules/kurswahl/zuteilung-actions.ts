"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/core/db/client";
import { moduleActions } from "@/core/modules/guard";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { assignManually, runAllocation } from "./zuteilen";

const { requireUser } = moduleActions("kurswahl");

function fail(err: unknown): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
  throw err;
}

export async function allocateAction(verfahrenId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await runAllocation(await getDb(), perms, verfahrenId, { newSeed: form.get("newSeed") === "on" });
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/kurswahl/${verfahrenId}`);
  return { ok: true };
}

/** Korrektur von Hand je Person und Platz (P4-67: Platz 1 bei einem Kurs je Person). */
export async function assignAction(verfahrenId: string, studentId: string, place: number, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await assignManually(await getDb(), perms, verfahrenId, studentId, String(form.get("offerId") ?? "") || null, place);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/kurswahl/${verfahrenId}`);
  return { ok: true };
}
