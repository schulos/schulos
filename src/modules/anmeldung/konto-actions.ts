"use server";

// Anmeldung über das Elternkonto (P4-34b) – mit Sitzung und Modulsperre (`moduleActions`).
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { readSchoolSettings } from "@/core/settings";
import { submitAccountAntrag } from "./konto";
import { changeVorgangSlot, withdrawVorgang } from "./public";
import type { PublicFormState } from "./public-actions";

const { requireUser } = moduleActions("anmeldung");

export async function submitAccountAntragAction(verfahrenId: string, _prev: PublicFormState, form: FormData): Promise<PublicFormState> {
  const { perms } = await requireUser();
  const db = await getDb();
  const raw = formValues(form);
  const r = await submitAccountAntrag(db, perms, String(verfahrenId).slice(0, 64), raw, { now: new Date(), school: (await readSchoolSettings(db)).name });
  if (!r.ok) return { error: r.error, fieldErrors: r.fieldErrors, values: raw };
  revalidatePath("/schulanmeldung");
  redirect(`/schulanmeldung/antrag/${r.antragId}?neu=1`);
}

/** Elternkonto: Termin ändern (P4-35). */
export async function changeSlotAccountAction(antragId: string, _prev: PublicFormState, form: FormData): Promise<PublicFormState> {
  const { perms } = await requireUser();
  const db = await getDb();
  const r = await changeVorgangSlot(db, { antragId: String(antragId), viewer: perms }, String(form.get("slotId") ?? ""), {
    ip: perms.userId,
    now: new Date(),
    school: (await readSchoolSettings(db)).name,
  });
  revalidatePath("/schulanmeldung");
  return r.ok ? { ok: true, message: r.message } : { error: r.error };
}

/** Elternkonto: Anmeldung zurückziehen (P4-35). */
export async function withdrawAccountAction(antragId: string, _prev: PublicFormState, form: FormData): Promise<PublicFormState> {
  const { perms } = await requireUser();
  if (form.get("confirm") !== "on") return { error: "Bitte bestätigen Sie, dass Sie die Anmeldung zurückziehen möchten." };
  const db = await getDb();
  const r = await withdrawVorgang(db, { antragId: String(antragId), viewer: perms }, { ip: perms.userId, now: new Date(), school: (await readSchoolSettings(db)).name });
  revalidatePath("/schulanmeldung");
  return r.ok ? { ok: true, message: r.message } : { error: r.error };
}
