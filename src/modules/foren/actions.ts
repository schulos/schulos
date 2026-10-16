"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { dismissReport, hidePost, reportPost, setTopicLocked, unhidePost } from "./moderation";
import { createTopic, editPost, reply, setSubscription } from "./service";

const { requireUser } = moduleActions("foren");

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

// Rechte: Lesen/Schreiben hängt an der Mitgliedschaft im Forum (Gruppe mit Merkmal bzw. Kollegium) – geprüft im Service.
export async function createTopicAction(key: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createTopic(await getDb(), perms, key, { title: String(form.get("title") ?? ""), body: String(form.get("body") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/foren");
  redirect(`/foren/thema/${id}`);
}

export async function replyAction(topicId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await reply(await getDb(), perms, topicId, String(form.get("body") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/foren/thema/${topicId}`);
  return { ok: true };
}

export async function editPostAction(topicId: string, postId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await editPost(await getDb(), perms, postId, String(form.get("body") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/foren/thema/${topicId}`);
  return { ok: true };
}

export async function setSubscriptionAction(topicId: string, on: boolean): Promise<void> {
  const { perms } = await requireUser();
  await setSubscription(await getDb(), perms, topicId, on);
  revalidatePath(`/foren/thema/${topicId}`);
}

// ------------------------------------------------------------- Moderation (P3-07)

export async function hidePostAction(topicId: string, postId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await hidePost(await getDb(), perms, postId, String(form.get("reason") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/foren/thema/${topicId}`);
  revalidatePath("/foren/meldungen");
  return { ok: true };
}

export async function unhidePostAction(topicId: string, postId: string): Promise<void> {
  const { perms } = await requireUser();
  await unhidePost(await getDb(), perms, postId);
  revalidatePath(`/foren/thema/${topicId}`);
}

export async function setTopicLockedAction(topicId: string, locked: boolean): Promise<void> {
  const { perms } = await requireUser();
  await setTopicLocked(await getDb(), perms, topicId, locked);
  revalidatePath(`/foren/thema/${topicId}`);
}

export async function reportPostAction(postId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await reportPost(await getDb(), perms, postId, String(form.get("reason") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  return { ok: true };
}

export async function dismissReportAction(reportId: string): Promise<void> {
  const { perms } = await requireUser();
  await dismissReport(await getDb(), perms, reportId);
  revalidatePath("/foren/meldungen");
}
