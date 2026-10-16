"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { mailAvailable } from "@/core/mail";
import { moduleActions } from "@/core/modules/guard";
import { readSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { inviteFamily, withdrawInvitation } from "./einladung";
import { bookAppointments, cancelAppointment, createEvent, deleteEvent, releaseAvailability, updateEvent, withdrawAvailability, type EventInput } from "./service";
import { parseBreaks } from "./slots";

const { requireUser } = moduleActions("sprechtag");

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

const today = () => toBerlinDate(new Date());

function readEvent(form: FormData): EventInput {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  return {
    title: str("title"),
    date: str("date"),
    startsAt: str("startsAt"),
    endsAt: str("endsAt"),
    slotMinutes: Number(str("slotMinutes")),
    breaks: parseBreaks(str("breaks")),
    bookingOpensOn: str("bookingOpensOn"),
    bookingClosesOn: str("bookingClosesOn"),
  };
}

export async function createEventAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createEvent(await getDb(), perms, readEvent(form), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/sprechtag");
  redirect(`/sprechtag/${id}`);
}

export async function updateEventAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateEvent(await getDb(), perms, id, readEvent(form), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/sprechtag", "layout");
  return { ok: true };
}

export async function deleteEventAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteEvent(await getDb(), perms, id);
  revalidatePath("/sprechtag", "layout");
  redirect("/sprechtag");
}

export async function releaseAction(eventId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const offered = new Set(form.getAll("slot").map(String));
  const all = form.getAll("allSlots").map(String);
  try {
    await releaseAvailability(await getDb(), perms, eventId, { roomId: String(form.get("roomId") ?? "") || null, blockedSlots: all.filter((s) => !offered.has(s)) }, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/sprechtag", "layout");
  return { ok: true };
}

export async function withdrawAction(eventId: string): Promise<void> {
  const { perms } = await requireUser();
  await withdrawAvailability(await getDb(), perms, eventId);
  revalidatePath("/sprechtag", "layout");
}

export async function inviteAction(eventId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const db = await getDb();
  try {
    await inviteFamily(db, perms, eventId, String(form.get("studentId") ?? ""), { mail: mailAvailable(), school: (await readSchoolSettings(db)).name }, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/sprechtag/${eventId}`);
  return { ok: true };
}

export async function withdrawInvitationAction(eventId: string, studentId: string): Promise<void> {
  const { perms } = await requireUser();
  await withdrawInvitation(await getDb(), perms, eventId, studentId);
  revalidatePath(`/sprechtag/${eventId}`);
}

export async function cancelAppointmentAction(appointmentId: string): Promise<void> {
  const { perms } = await requireUser();
  await cancelAppointment(await getDb(), perms, appointmentId);
  revalidatePath("/sprechtag", "layout");
  revalidatePath("/", "layout");
}

export async function bookOneAction(eventId: string, teacherId: string, studentId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await bookAppointments(await getDb(), perms, eventId, [{ teacherId, studentId, slot: String(form.get("slot") ?? "") }]);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/sprechtag/buchen?e=${eventId}&gebucht=1`);
}

/** Vorschlag „hintereinander“ übernehmen: Werte „Lehrkraft|Kind|Zeit“, alles oder nichts. */
export async function bookSuggestionAction(eventId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const items = form
    .getAll("b")
    .map((v) => String(v).split("|"))
    .filter((p): p is [string, string, string] => p.length === 3)
    .map(([teacherId, studentId, slot]) => ({ teacherId, studentId, slot }));
  try {
    await bookAppointments(await getDb(), perms, eventId, items);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/sprechtag/buchen?e=${eventId}&gebucht=1`);
}
