"use server";

// Öffentliche Server Actions der Schulanmeldung (P4-34) – ohne Sitzung, über `publicAction()` (Modulsperre, IP, gleich
// lange Antworten). Keine personenbezogenen Daten in Adressen oder Logs; Eingaben prüft der Service.
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { publicAction } from "@/core/public-action";
import { readSchoolSettings } from "@/core/settings";
import { changeVorgangSlot, confirmAntrag, liveSlots, submitAntrag, withdrawVorgang } from "./public";
import { toSlotOptions, type SlotOption } from "./slot-options";

export interface PublicFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  message?: string;
}

/** Formular absenden. Erfolg = „bitte E-Mail bestätigen“ (immer gleich, siehe submitAntrag). */
export async function submitAntragAction(verfahrenId: string, _prev: PublicFormState, form: FormData): Promise<PublicFormState> {
  return publicAction("anmeldung", async (ctx) => {
    const db = await getDb();
    const school = await readSchoolSettings(db);
    const raw = formValues(form);
    const r = await submitAntrag(db, verfahrenId, raw, { ...ctx, school: school.name, state: school.profile.state });
    if (r.ok) return { ok: true };
    // Eingaben zurückgeben (React setzt das Formular sonst zurück) – ohne Honeypot und Zeitstempel
    const values = { ...raw };
    delete values.website;
    delete values.stamp;
    return { error: r.error, fieldErrors: r.fieldErrors, values };
  });
}

/** Freie Termine neu laden (Slot-Wahl live) – nur Zeiten, Raum und freie Plätze. */
export async function freeSlotsAction(verfahrenId: string): Promise<SlotOption[]> {
  return publicAction(
    "anmeldung",
    async (ctx) => toSlotOptions(await liveSlots(await getDb(), String(verfahrenId).slice(0, 64), ctx)),
    { minMs: 0 },
  );
}

/** Bestätigungslink einlösen (Knopf – Mailprogramme, die Links vorab öffnen, bestätigen so nichts). */
export async function confirmAntragAction(token: string): Promise<PublicFormState> {
  const r = await publicAction("anmeldung", async (ctx) => {
    const db = await getDb();
    const school = await readSchoolSettings(db);
    return confirmAntrag(db, String(token), { ...ctx, school: school.name, state: school.profile.state });
  });
  if (r.state === "limited") return { error: "Zu viele Versuche in kurzer Zeit. Bitte später noch einmal versuchen." };
  if (r.state === "invalid") return { error: "Der Link ist ungültig oder abgelaufen." };
  redirect(`/anmeldung/vorgang/${r.value.accessToken}?bestaetigt=1`);
}

/** Vorgangslink: Termin ändern (P4-35). */
export async function changeSlotAction(token: string, _prev: PublicFormState, form: FormData): Promise<PublicFormState> {
  return publicAction("anmeldung", async (ctx) => {
    const db = await getDb();
    const r = await changeVorgangSlot(db, { token: String(token) }, String(form.get("slotId") ?? ""), { ...ctx, school: (await readSchoolSettings(db)).name });
    return r.ok ? { ok: true, message: r.message } : { error: r.error };
  });
}

/** Vorgangslink: Anmeldung zurückziehen (P4-35). */
export async function withdrawAction(token: string, _prev: PublicFormState, form: FormData): Promise<PublicFormState> {
  if (form.get("confirm") !== "on") return { error: "Bitte bestätigen Sie, dass Sie die Anmeldung zurückziehen möchten." };
  return publicAction("anmeldung", async (ctx) => {
    const db = await getDb();
    const r = await withdrawVorgang(db, { token: String(token) }, { ...ctx, school: (await readSchoolSettings(db)).name });
    return r.ok ? { ok: true, message: r.message } : { error: r.error };
  });
}
