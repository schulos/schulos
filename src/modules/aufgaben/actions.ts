"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { fromBerlinLocal } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createTask, deleteTask, giveFeedback, submit, type FileInput, type SubmissionType } from "./service";

const { requireUser } = moduleActions("aufgaben");

async function readFiles(form: FormData, field: string): Promise<FileInput[]> {
  const files = form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
  return Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) })));
}

function fail(err: unknown): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
  throw err;
}

export async function createTaskAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    const start = String(form.get("startsAt") ?? "");
    const due = String(form.get("dueAt") ?? "");
    if (!due) throw new ValidationError({ dueAt: "Frist fehlt" });
    id = await createTask(await getDb(), getStorage(), perms, {
      title: String(form.get("title") ?? ""),
      description: String(form.get("description") ?? ""),
      groupIds: form.getAll("groupId").map(String),
      startsAt: start ? fromBerlinLocal(start) : undefined,
      dueAt: fromBerlinLocal(due),
      submissionType: String(form.get("submissionType") ?? "file") as SubmissionType,
      files: await readFiles(form, "files"),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/", "layout");
  redirect(`/aufgaben/${id}`);
}

export async function submitAction(taskId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await submit(await getDb(), getStorage(), perms, taskId, { text: String(form.get("text") ?? ""), files: await readFiles(form, "files") });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function feedbackAction(taskId: string, studentId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await giveFeedback(await getDb(), perms, taskId, studentId, { feedback: String(form.get("feedback") ?? ""), grade: String(form.get("grade") ?? "") });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/", "layout");
  redirect(`/aufgaben/${taskId}`);
}

export async function deleteTaskAction(taskId: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteTask(await getDb(), getStorage(), perms, taskId);
  revalidatePath("/", "layout");
  redirect("/aufgaben");
}
