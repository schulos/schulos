"use server";

import { revalidatePath } from "next/cache";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { addResource, book, cancelBooking, setResourceActive } from "./service";

const { requireUser } = moduleActions("buchungen");

const errorState = (err: ValidationError): FormState => ({ error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors });

/** Ein Formular für die ganze Woche: der geklickte Knopf liefert „slot“ = „YYYY-MM-DD:Stunde“. */
export async function bookAction(resourceId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const [date, period] = String(form.get("slot") ?? "").split(":");
  try {
    await book(await getDb(), perms, { resourceId, date: date ?? "", periodNr: Number(period), groupId: String(form.get("groupId") ?? "") || null, note: String(form.get("note") ?? "") }, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) return errorState(err);
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function cancelBookingAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await cancelBooking(await getDb(), perms, id);
  revalidatePath("/", "layout");
}

export async function addResourceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const kind = form.get("kind") === "room" ? "room" : "device";
  try {
    await addResource(await getDb(), perms, { kind, roomId: String(form.get("roomId") ?? ""), name: String(form.get("name") ?? ""), description: String(form.get("description") ?? "") });
  } catch (err) {
    if (err instanceof ValidationError) return errorState(err);
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function toggleResourceAction(id: string, active: boolean): Promise<void> {
  const { perms } = await requireUser();
  await setResourceActive(await getDb(), perms, id, active);
  revalidatePath("/", "layout");
}
