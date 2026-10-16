"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import type { Preset, Seat } from "./layout";
import { copyPlan, createPlan, deletePlan, savePlan, updatePlanMeta } from "./service";

const { requireUser } = moduleActions("sitzplan");

const today = () => toBerlinDate(new Date());
const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: form ? formValues(form) : undefined };
  if (err instanceof ForbiddenError) return { error: "Diesen Sitzplan gibt es nicht (mehr)." };
  throw err;
}

export async function createPlanAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createPlan(
      await getDb(),
      perms,
      {
        groupId: str(form, "groupId"),
        title: str(form, "title"),
        subjectId: str(form, "subjectId") || null,
        roomId: str(form, "roomId") || null,
        rows: Number(str(form, "rows")),
        cols: Number(str(form, "cols")),
        preset: str(form, "preset") as Preset,
      },
      today(),
    );
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/sitzplan");
  redirect(`/sitzplan/${id}`);
}

export async function updatePlanMetaAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updatePlanMeta(await getDb(), perms, id, { title: str(form, "title"), subjectId: str(form, "subjectId") || null, roomId: str(form, "roomId") || null }, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/sitzplan", "layout");
  return { ok: true };
}

/** Editor: Raster, Tische und Plätze in einem Schritt speichern. */
export async function savePlanAction(id: string, input: { rows: number; cols: number; desks: string[]; seats: Seat[] }): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const seats = Array.isArray(input?.seats)
      ? input.seats.map((s) => ({ studentId: String(s?.studentId ?? ""), row: Number(s?.row), col: Number(s?.col) }))
      : [];
    const desks = Array.isArray(input?.desks) ? input.desks.map(String) : [];
    await savePlan(await getDb(), perms, id, { rows: Number(input?.rows), cols: Number(input?.cols), desks, seats }, today());
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/sitzplan", "layout");
  return { ok: true };
}

export async function copyPlanAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let newId: string;
  try {
    newId = await copyPlan(await getDb(), perms, id, str(form, "title"), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/sitzplan");
  redirect(`/sitzplan/${newId}`);
}

export async function deletePlanAction(id: string): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await deletePlan(await getDb(), perms, id, today());
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/sitzplan");
  redirect("/sitzplan");
}
