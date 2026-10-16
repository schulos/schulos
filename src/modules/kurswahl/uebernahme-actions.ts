"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/core/db/client";
import { moduleActions } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createSuggestedAssignments, transfer } from "./uebernahme";

const { requireUser } = moduleActions("kurswahl");

function fail(err: unknown): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
  throw err;
}

export async function transferAction(verfahrenId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await transfer(await getDb(), perms, verfahrenId, { acceptConflicts: form.get("acceptConflicts") === "on" }, toBerlinDate(new Date()));
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function assignmentsAction(verfahrenId: string): Promise<FormState> {
  const { perms } = await requireUser();
  let n: number;
  try {
    n = await createSuggestedAssignments(await getDb(), perms, verfahrenId);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/kurswahl/${verfahrenId}`);
  return { ok: true, values: { sent: String(n) } };
}
