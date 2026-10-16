"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { ROLES, type Role } from "@/core/roles";
import { formValues } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createPost, deletePost, updatePost, type PostInput } from "./service";

const { requireUser } = moduleActions("news");

function readInput(form: FormData): PostInput {
  const expires = String(form.get("expiresAt") ?? "");
  return {
    title: String(form.get("title") ?? ""),
    body: String(form.get("body") ?? ""),
    pinned: form.get("pinned") === "on",
    onMonitor: form.get("onMonitor") === "on",
    // Ablauf am Ende des gewählten Tages (deutsche Zeit, vereinfacht 23:59 lokal)
    expiresAt: expires ? new Date(`${expires}T23:59:00`) : null,
    targetRoles: form.getAll("targetRole").map(String).filter((r): r is Role => (ROLES as readonly string[]).includes(r)),
    targetGroupIds: form.getAll("targetGroup").map(String).filter(Boolean),
    notify: form.get("notify") === "on",
  };
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

export async function createPostAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createPost(await getDb(), perms, readInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/news/${id}`);
}

export async function updatePostAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updatePost(await getDb(), perms, id, readInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/news/${id}`);
}

export async function deletePostAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deletePost(await getDb(), perms, id);
  revalidatePath("/", "layout");
  redirect("/news");
}
