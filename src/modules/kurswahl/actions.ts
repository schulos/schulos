"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import type { KurswahlChooser, KurswahlKind } from "@/core/db/schema";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAngebot, createVerfahren, deleteAngebot, deleteVerfahren, updateAngebot, updateVerfahren, type AngebotInput, type VerfahrenInput } from "./service";

const { requireUser } = moduleActions("kurswahl");

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
/** Zahl oder null (leeres Feld) */
const num = (form: FormData, k: string) => (str(form, k) === "" ? null : Number(str(form, k)));

function readVerfahren(form: FormData): VerfahrenInput {
  return {
    title: str(form, "title"),
    kind: str(form, "kind") as KurswahlKind,
    note: str(form, "note") || null,
    gradeLevel: Number(str(form, "gradeLevel")),
    classIds: form.getAll("classIds").map(String).filter(Boolean),
    courseGrade: Number(str(form, "courseGrade") || str(form, "gradeLevel")),
    schoolYearId: str(form, "schoolYearId") || null,
    opensOn: str(form, "opensOn"),
    closesOn: str(form, "closesOn"),
    choices: Number(str(form, "choices")),
    minCourses: Number(str(form, "minCourses") || 1),
    maxCourses: Number(str(form, "maxCourses") || 1),
    chooser: str(form, "chooser") as KurswahlChooser,
    parentConfirm: form.get("parentConfirm") === "on",
  };
}

function readAngebot(form: FormData): AngebotInput {
  return {
    title: str(form, "title"),
    subjectId: str(form, "subjectId") || null,
    level: str(form, "level") || null,
    minSize: num(form, "minSize") ?? 0,
    maxSize: num(form, "maxSize"),
    note: str(form, "note") || null,
    teacherId: str(form, "teacherId") || null,
    hours: num(form, "hours"),
  };
}

export async function createVerfahrenAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createVerfahren(await getDb(), perms, readVerfahren(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/kurswahl");
  redirect(`/kurswahl/${id}`);
}

export async function updateVerfahrenAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateVerfahren(await getDb(), perms, id, readVerfahren(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/kurswahl", "layout");
  return { ok: true };
}

export async function deleteVerfahrenAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteVerfahren(await getDb(), perms, id);
  revalidatePath("/kurswahl", "layout");
  redirect("/kurswahl");
}

export async function createAngebotAction(verfahrenId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await createAngebot(await getDb(), perms, verfahrenId, readAngebot(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/kurswahl/${verfahrenId}`);
  return { ok: true };
}

export async function updateAngebotAction(verfahrenId: string, angebotId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateAngebot(await getDb(), perms, angebotId, readAngebot(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/kurswahl/${verfahrenId}`);
  return { ok: true };
}

export async function deleteAngebotAction(verfahrenId: string, angebotId: string): Promise<{ error?: string }> {
  const { perms } = await requireUser();
  try {
    await deleteAngebot(await getDb(), perms, angebotId);
  } catch (err) {
    // G4E-C06: z. B. „Die Wahl läuft – nur noch n Angebote …“
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich" };
    throw err;
  }
  revalidatePath(`/kurswahl/${verfahrenId}`);
  return {};
}
