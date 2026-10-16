"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { readSchoolSettings } from "@/core/settings";
import { findAntraegeForAuskunft, type AuskunftTreffer } from "./auskunft";
import { decide, DECISIONS, markSpamSuspect, rejectAsSpam, unmarkSpamSuspect, type Decision, type SpamOp } from "./entscheidung";
import { anmeldungKatalog } from "./katalog";
import { OPTIONAL_FIELDS } from "./labels";
import { addNote, moveSlot } from "./sekretariat";
import {
  addSlots,
  closeVerfahren,
  completeVerfahren,
  createVerfahren,
  deleteSlot,
  deleteVerfahren,
  publishVerfahren,
  setChecklist,
  updateVerfahren,
  type VerfahrenInput,
} from "./service";

const { requireUser } = moduleActions("anmeldung");

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError)
    return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, ...(form ? { values: formValues(form) } : {}) };
  throw err;
}

function readVerfahren(form: FormData): VerfahrenInput {
  const str = (k: string) => String(form.get(k) ?? "");
  return {
    name: str("name"),
    kind: str("kind"),
    targetSchoolYearId: str("targetSchoolYearId"),
    targetGradeLevel: str("targetGradeLevel"),
    opensAt: str("opensAt"),
    closesAt: str("closesAt"),
    capacity: str("capacity"),
    intro: str("intro"),
    rejectKeepDays: str("rejectKeepDays"),
    fields: Object.fromEntries(OPTIONAL_FIELDS.map((f) => [f, form.get(`field_${f}`) === "on"])),
  };
}

const base = "/verwaltung/anmeldung";

export async function createVerfahrenAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createVerfahren(await getDb(), perms, readVerfahren(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(base);
  redirect(`${base}/${id}/termine`);
}

export async function updateVerfahrenAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateVerfahren(await getDb(), perms, id, readVerfahren(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`${base}/${id}`);
  return { ok: true };
}

/** Veröffentlichen / Schließen / Abschließen / Löschen eines Verfahrens (Knöpfe ohne Felder). */
export async function verfahrenStepAction(id: string, step: "veroeffentlichen" | "schliessen" | "abschliessen" | "loeschen"): Promise<FormState> {
  const { perms } = await requireUser();
  const db = await getDb();
  try {
    if (step === "veroeffentlichen") await publishVerfahren(db, perms, id);
    else if (step === "schliessen") await closeVerfahren(db, perms, id);
    else if (step === "abschliessen") await completeVerfahren(db, perms, id);
    else await deleteVerfahren(db, perms, id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(base);
  if (step === "loeschen") redirect(base);
  revalidatePath(`${base}/${id}`);
  return { ok: true };
}

export async function addSlotsAction(id: string, _prev: FormState, form: FormData): Promise<FormState & { added?: number; skipped?: number }> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const days = str("days")
    .split(/[\s,;]+/)
    .filter(Boolean);
  const windows = str("windows")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((w) => {
      const [from = "", to = ""] = w.split(/[-–]/);
      return { from: from.trim().padStart(5, "0"), to: to.trim().padStart(5, "0") };
    });
  try {
    const r = await addSlots(await getDb(), perms, id, {
      days,
      windows,
      durationMinutes: Number(str("durationMinutes")),
      parallel: Number(str("parallel") || "1"),
      breakMinutes: Number(str("breakMinutes") || "0"),
      roomId: str("roomId") || null,
      note: str("note") || null,
    });
    revalidatePath(`${base}/${id}/termine`);
    // Eingaben behalten: oft folgt gleich der nächste Tag mit denselben Zeiten
    return { ok: true, added: r.added, skipped: r.skipped, values: formValues(form) };
  } catch (err) {
    return fail(err, form);
  }
}

export async function deleteSlotAction(verfahrenId: string, slotId: string): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await deleteSlot(await getDb(), perms, slotId);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`${base}/${verfahrenId}/termine`);
  return { ok: true };
}

// ---------------------------------------------------------------- Anträge (P4-36)

const antragPath = (verfahrenId: string, antragId: string) => `${base}/${verfahrenId}/antrag/${antragId}`;

/** Checkliste „vorgelegt“ (Häkchen je Unterlage des Landeskatalogs). */
export async function checklistAction(verfahrenId: string, antragId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const db = await getDb();
  const keys = anmeldungKatalog((await readSchoolSettings(db)).profile.state).checklist.map((c) => c.key);
  try {
    await setChecklist(db, perms, antragId, Object.fromEntries(keys.map((k) => [k, form.get(`doc_${k}`) === "on"])), keys);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(antragPath(verfahrenId, antragId));
  return { ok: true };
}

/** Interne Notiz. */
export async function noteAction(verfahrenId: string, antragId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await addNote(await getDb(), perms, antragId, String(form.get("note") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(antragPath(verfahrenId, antragId));
  return { ok: true };
}

/** Termin verschieben (leer = Termin entfernen); Eltern bekommen eine Mail. */
export async function moveSlotAction(verfahrenId: string, antragId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const db = await getDb();
  const slotId = String(form.get("slotId") ?? "").trim() || null;
  try {
    await moveSlot(db, perms, antragId, slotId, { school: (await readSchoolSettings(db)).name });
  } catch (err) {
    return fail(err);
  }
  revalidatePath(antragPath(verfahrenId, antragId));
  return { ok: true };
}

// ---------------------------------------------------------------- Entscheidung (P4-37)

function readDecision(form: FormData): Decision | null {
  const d = String(form.get("decision") ?? "");
  return (DECISIONS as readonly string[]).includes(d) ? (d as Decision) : null;
}

/**
 * Entscheidung für die ausgewählten Anträge (Liste) bzw. einen Antrag (`antragId` gebunden). Kein Losen, keine Automatik –
 * jede Auswahl trifft ein Mensch (Q-34). Eltern bekommen nach der ersten Entscheidung nur „Bescheid folgt per Post“ (Q-35).
 */
export async function decideAction(
  verfahrenId: string,
  antragId: string | null,
  _prev: FormState,
  form: FormData,
): Promise<FormState & { changed?: number; mails?: number }> {
  const { perms } = await requireUser();
  const db = await getDb();
  const ids = antragId ? [antragId] : form.getAll("antrag").map(String);
  const to = readDecision(form);
  try {
    if (!to) throw new ValidationError({ decision: "Entscheidung wählen" });
    const r = await decide(db, perms, verfahrenId, ids, to, { school: (await readSchoolSettings(db)).name, note: String(form.get("note") ?? "") || null });
    revalidatePath(`${base}/${verfahrenId}`, "layout");
    return { ok: true, changed: r.changed, mails: r.mails };
  } catch (err) {
    return fail(err);
  }
}

export interface AuskunftSearchState {
  query?: string;
  results?: AuskunftTreffer[];
  error?: string;
}

/** Auskunft (P4-42): Anträge zu einer Vorgangsnummer bzw. E-Mail-Adresse finden – Suche steht im Audit-Log. */
export async function auskunftSearchAction(_prev: AuskunftSearchState, form: FormData): Promise<AuskunftSearchState> {
  const { perms } = await requireUser();
  const query = String(form.get("q") ?? "").trim();
  if (!/^A-\d{4}-\d{1,6}$/i.test(query) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query))
    return { query, error: "Vorgangsnummer (z. B. A-2027-0042) oder vollständige E-Mail-Adresse eingeben" };
  return { query, results: await findAntraegeForAuskunft(await getDb(), perms, query) };
}

/**
 * P4-78/P4-78b: Spam-Schritte der Antragsliste (ohne Mail) – `ablehnen` (Schulleitung, bestätigt auch den Verdacht),
 * `markieren`/`zuruecknehmen` (Spam-Verdacht, Sekretariat). Die Rechte prüft der Service.
 */
export async function spamAction(verfahrenId: string, _prev: FormState, form: FormData): Promise<FormState & { changed?: number; op?: SpamOp }> {
  const { perms } = await requireUser();
  const op = String(form.get("op") ?? "") as SpamOp;
  const ids = form.getAll("antrag").map(String);
  try {
    const db = await getDb();
    const changed =
      op === "markieren" ? await markSpamSuspect(db, perms, verfahrenId, ids) : op === "zuruecknehmen" ? await unmarkSpamSuspect(db, perms, verfahrenId, ids) : await rejectAsSpam(db, perms, verfahrenId, ids);
    revalidatePath(`${base}/${verfahrenId}`, "layout");
    return { ok: true, changed, op: op === "markieren" || op === "zuruecknehmen" ? op : "ablehnen" };
  } catch (err) {
    return fail(err);
  }
}
