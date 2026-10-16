"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { confirmEmailChange, EmailChangeError, removeOwnEmail, requestEmailChange } from "@/core/auth/email";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { mailAvailable } from "@/core/mail";
import { readSchoolSettings } from "@/core/settings";

export interface EmailFormState {
  ok?: string;
  error?: string;
  values?: { email: string };
}

/** Neue Adresse anfordern (Q5-04): Bestätigungslink an die neue Adresse. */
export async function requestEmailAction(_prev: EmailFormState, form: FormData): Promise<EmailFormState> {
  const { user } = await requireUser();
  const email = String(form.get("email") ?? "");
  if (!mailAvailable()) return { error: "Der E-Mail-Versand ist nicht eingerichtet – bitte an das Sekretariat wenden.", values: { email } };
  const db = await getDb();
  try {
    const r = await requestEmailChange(db, user.id, email, { school: (await readSchoolSettings(db)).name });
    return { ok: `Wir haben einen Bestätigungslink an ${r.sentTo} geschickt. Er gilt 24 Stunden.` };
  } catch (err) {
    if (err instanceof EmailChangeError) return { error: err.message, values: { email } };
    throw err;
  }
}

export async function confirmEmailAction(token: string): Promise<EmailFormState> {
  const { user } = await requireUser();
  const db = await getDb();
  try {
    await confirmEmailChange(db, user.id, token, { school: (await readSchoolSettings(db)).name });
  } catch (err) {
    if (err instanceof EmailChangeError) return { error: err.message };
    throw err;
  }
  revalidatePath("/konto/email");
  redirect("/konto/email?bestaetigt=1");
}

export async function removeEmailAction(): Promise<EmailFormState> {
  const { user } = await requireUser();
  try {
    await removeOwnEmail(await getDb(), user.id);
  } catch (err) {
    if (err instanceof EmailChangeError) return { error: err.message };
    throw err;
  }
  revalidatePath("/konto/email");
  return { ok: "Die E-Mail-Adresse ist entfernt." };
}
