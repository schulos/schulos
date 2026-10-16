"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createEvent, deleteEvent, updateEvent, type CalendarKey, type EventInput } from "./service";

const { requireUser } = moduleActions("kalender");

function readInput(form: FormData): EventInput {
  const allDay = form.get("allDay") === "on";
  const repeat = form.get("repeat") === "on";
  return {
    calendar: String(form.get("calendar") ?? "personal") as CalendarKey,
    title: String(form.get("title") ?? ""),
    description: String(form.get("description") ?? ""),
    location: String(form.get("location") ?? ""),
    allDay,
    start: String(form.get(allDay ? "startDate" : "start") ?? ""),
    end: String(form.get(allDay ? "endDate" : "end") ?? ""),
    repeatWeeklyUntil: repeat ? String(form.get("repeatUntil") ?? "") || null : null,
  };
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

export async function createEventAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createEvent(await getDb(), perms, readInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/kalender/termin/${id}`);
}

export async function updateEventAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateEvent(await getDb(), perms, id, readInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/kalender/termin/${id}`);
}

export async function deleteEventAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteEvent(await getDb(), perms, id);
  revalidatePath("/", "layout");
  redirect("/kalender");
}
