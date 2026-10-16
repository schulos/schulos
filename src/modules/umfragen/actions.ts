"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { ROLES, type Role } from "@/core/roles";
import { fromBerlinLocal } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { QUESTION_KINDS, type QuestionKind } from "./schema";
import { createSurvey, deleteSurvey, updateSurvey, type QuestionInput, type SurveyInput } from "./service";
import { answerQuickPoll, endQuickPoll, startQuickPoll } from "./schnell";
import { remindNonParticipants, submitResponse, type AnswerInput } from "./teilnahme";

const { requirePermission, requireUser } = moduleActions("umfragen");

function when(raw: FormDataEntryValue | null): Date {
  try {
    return fromBerlinLocal(String(raw ?? ""));
  } catch {
    return new Date(NaN);
  }
}

/** Fragen kommen als JSON aus dem Baukasten (survey-form.tsx); alles Unbekannte fällt heraus. */
function readQuestions(raw: FormDataEntryValue | null): QuestionInput[] {
  try {
    const list: unknown = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(list)) return [];
    return list.slice(0, 100).map((q: Record<string, unknown>) => ({
      kind: (QUESTION_KINDS as readonly string[]).includes(String(q.kind)) ? (q.kind as QuestionKind) : ("" as QuestionKind),
      text: String(q.text ?? ""),
      options: Array.isArray(q.options) ? q.options.slice(0, 50).map(String) : [],
      required: q.required !== false,
    }));
  } catch {
    return [];
  }
}

function readInput(form: FormData): SurveyInput {
  return {
    title: String(form.get("title") ?? ""),
    description: String(form.get("description") ?? ""),
    anonymous: form.get("anonymous") !== "named",
    opensAt: when(form.get("opensAt")),
    closesAt: when(form.get("closesAt")),
    targets: {
      roles: form.getAll("targetRole").map(String).filter((r): r is Role => (ROLES as readonly string[]).includes(r)),
      groups: form
        .getAll("targetGroup")
        .map(String)
        .filter(Boolean)
        .map((v) => ({ groupId: v.replace(/:eltern$/, ""), parents: v.endsWith(":eltern") })),
    },
    questions: readQuestions(form.get("questions")),
    notify: form.get("notify") === "on",
  };
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

export async function createSurveyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requirePermission("umfragen.create");
  let id: string;
  try {
    id = await createSurvey(await getDb(), perms, readInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/umfragen");
  redirect(`/umfragen/${id}`);
}

export async function updateSurveyAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requirePermission("umfragen.create");
  try {
    await updateSurvey(await getDb(), perms, id, readInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/umfragen");
  redirect(`/umfragen/${id}`);
}

export async function deleteSurveyAction(id: string): Promise<void> {
  const { perms } = await requirePermission("umfragen.create");
  await deleteSurvey(await getDb(), perms, id);
  revalidatePath("/umfragen");
  redirect("/umfragen");
}

/** Antworten kommen als c:<frage> (Auswahl, mehrfach), s:<frage> (Skala) und t:<frage> (Freitext). */
function readAnswers(form: FormData): Record<string, AnswerInput> {
  const out: Record<string, AnswerInput> = {};
  for (const [key, value] of form.entries()) {
    const m = key.match(/^([cst]):([\w-]{1,64})$/);
    if (!m || typeof value !== "string") continue;
    const a = (out[m[2]!] ??= {});
    if (m[1] === "c") (a.choices ??= []).push(Number(value));
    else if (m[1] === "s" && value) a.scale = Number(value);
    else if (m[1] === "t") a.text = value;
  }
  return out;
}

export async function submitResponseAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await submitResponse(await getDb(), perms, id, readAnswers(form));
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.fieldErrors.survey ?? "Bitte die markierten Fragen beantworten.", fieldErrors: err.fieldErrors };
    throw err;
  }
  revalidatePath("/umfragen");
  redirect(`/umfragen/${id}?danke=1`);
}

export interface RemindState {
  message?: string;
  error?: string;
}

export async function remindAction(id: string): Promise<RemindState> {
  const { perms } = await requirePermission("umfragen.create");
  try {
    const n = await remindNonParticipants(await getDb(), perms, id);
    return { message: n === 1 ? "1 Person erinnert." : `${n} Personen erinnert.` };
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] };
    throw err;
  }
}

// ------------------------------------------------------------- Schnellumfrage (P3-05)

export async function startQuickPollAction(groupId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await startQuickPoll(await getDb(), perms, groupId, {
      question: String(form.get("question") ?? ""),
      options: form.getAll("option").map(String),
      minutes: Number(form.get("minutes")),
    });
  } catch (err) {
    return fail(err, form);
  }
  return { ok: true };
}

export async function answerQuickPollAction(pollId: string, choice: number): Promise<string | null> {
  const { perms } = await requireUser();
  try {
    await answerQuickPoll(await getDb(), perms, pollId, choice);
    return null;
  } catch (err) {
    if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0] ?? "Antwort nicht möglich";
    throw err;
  }
}

export async function endQuickPollAction(pollId: string): Promise<void> {
  const { perms } = await requireUser();
  await endQuickPoll(await getDb(), perms, pollId);
}
