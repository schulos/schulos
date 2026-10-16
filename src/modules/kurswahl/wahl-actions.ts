"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { remindNonVoters } from "./erinnerung";
import { MAX_COURSES, confirmChoice, submitChoices } from "./service";

const { requireUser } = moduleActions("kurswahl");

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: form ? formValues(form) : undefined };
  throw err;
}

const today = () => toBerlinDate(new Date());

/** P4-67: Plätze aus dem Formular – 1. Platz „choice“, weitere „choice-2“ … (fehlende Felder = kein weiterer Platz). */
function placesOf(form: FormData): string[][] {
  const places = [form.getAll("choice").map(String)];
  for (let p = 2; p <= MAX_COURSES; p++) if (form.has(`choice-${p}`)) places.push(form.getAll(`choice-${p}`).map(String));
  return places;
}

/** Wahl abgeben: Wünsche als Felder „choice“ in der Reihenfolge der Priorität; die Verwaltung wählt die Person im Formular. */
export async function submitChoiceAction(verfahrenId: string, studentId: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const who = studentId ?? String(form.get("studentId") ?? "");
  if (!who) return { error: "Schüler:in wählen", fieldErrors: { studentId: "Schüler:in wählen" }, values: formValues(form) };
  try {
    await submitChoices(await getDb(), perms, verfahrenId, who, placesOf(form), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/kurswahl", "layout");
  return { ok: true };
}

export async function confirmChoiceAction(verfahrenId: string, studentId: string): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await confirmChoice(await getDb(), perms, verfahrenId, studentId, today());
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/kurswahl", "layout");
  return { ok: true };
}

export async function remindAction(verfahrenId: string): Promise<FormState> {
  const { perms } = await requireUser();
  let n: number;
  try {
    n = await remindNonVoters(await getDb(), perms, verfahrenId, today());
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/kurswahl/${verfahrenId}`);
  // Anzahl über `values` zurück (FormState kennt keine Meldung)
  return { ok: true, values: { sent: String(n) } };
}
