"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createDoc, deleteDoc, updateDoc } from "./service";

const { requireUser } = moduleActions("texte");

// Rechte hängen an der Rolle in der Gruppe (Leitung/Mitglied) – geprüft im Service.

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Bitte die Eingaben prüfen.", fieldErrors: err.fieldErrors, ...(form ? { values: formValues(form) } : {}) };
  throw err;
}

export async function createDocAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createDoc(await getDb(), perms, { title: String(form.get("title") ?? ""), mode: String(form.get("mode") ?? ""), groupId: String(form.get("groupId") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/texte");
  redirect(`/texte/${id}`);
}

export async function updateDocAction(docId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateDoc(await getDb(), perms, docId, { title: String(form.get("title") ?? ""), mode: String(form.get("mode") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/texte/${docId}`);
  return { ok: true };
}

export async function deleteDocAction(docId: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteDoc(await getDb(), perms, docId);
  revalidatePath("/texte");
  redirect("/texte");
}
