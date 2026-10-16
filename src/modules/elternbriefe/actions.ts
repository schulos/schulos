"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { confirmLetter, createLetter, remindLetter, type LetterInput } from "./service";

const { requireUser } = moduleActions("elternbriefe");

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) {
    const values = Object.fromEntries([...form.entries()].filter(([k, v]) => !k.startsWith("$") && typeof v === "string").map(([k, v]) => [k, String(v)]));
    values.groupIds = form.getAll("groupIds").map(String).join(",");
    return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values };
  }
  throw err;
}

export async function createLetterAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  const file = form.get("attachment");
  const input: LetterInput = {
    title: str("title"),
    body: str("body"),
    groupIds: form.getAll("groupIds").map(String),
    responseType: (str("responseType") || "none") as LetterInput["responseType"],
    question: str("question"),
    dueDate: str("dueDate") || null,
    attachment: file instanceof File && file.size > 0 ? { name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) } : null,
  };
  let id: string;
  try {
    id = await createLetter(await getDb(), getStorage(), perms, input);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/elternbriefe/${id}`);
}

export async function confirmLetterAction(letterId: string, studentId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const yes = form.get("answer");
  try {
    await confirmLetter(await getDb(), perms, letterId, studentId, { yes: yes === "ja" ? true : yes === "nein" ? false : null, text: String(form.get("answerText") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function remindLetterAction(letterId: string): Promise<void> {
  const { perms } = await requireUser();
  await remindLetter(await getDb(), perms, letterId);
  revalidatePath("/", "layout");
}
