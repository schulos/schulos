"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { FormState } from "./actions";
import { IMPRESSUM_FIELD_KEYS, saveImpressum } from "@/core/school/impressum";
import { saveA11yStatement } from "@/core/school/barrierefreiheit";
import { getStorage } from "@/core/files/storage";
import { hasPermission } from "@/core/permissions";
import { MODULES } from "@/modules";
import { importSchulprofil, parseSchulprofil, SCHULPROFIL_MAX_BYTES } from "./schulprofil";
import { saveSchoolSettings } from "./school";
import { ValidationError } from "./users";

const A11Y_INPUT_KEYS = ["status", "contactName", "contactEmail", "contactPhone", "reviewedOn", "extraBarriers", "enforcement"] as const;

export async function saveSchoolAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.school");
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    await saveSchoolSettings(await getDb(), user.id, {
      name: str("name"),
      number: str("number"),
      color: str("color"),
      state: str("state"),
      form: str("form"),
      oberstufe: form.get("oberstufe") === "on",
      abitur: str("abitur") || "g9",
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      const values = Object.fromEntries([...form.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Impressum für die öffentlichen Seiten (P4-33, Q5-22: einzelne Felder nach § 5 DDG). */
export async function saveImpressumAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.school");
  const input = Object.fromEntries(IMPRESSUM_FIELD_KEYS.map((k) => [k, String(form.get(k) ?? "")]));
  try {
    await saveImpressum(await getDb(), user.id, input);
  } catch (err) {
    if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, values: input };
    throw err;
  }
  revalidatePath("/impressum");
  revalidatePath("/verwaltung/schule");
  return { ok: true };
}

/** Erklärung zur Barrierefreiheit (A11Y-02) – Angaben der Schule für /barrierefreiheit. */
export async function saveA11yStatementAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.school");
  const input = Object.fromEntries(A11Y_INPUT_KEYS.map((k) => [k, String(form.get(k) ?? "")]));
  try {
    await saveA11yStatement(await getDb(), user.id, input);
  } catch (err) {
    if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, values: input };
    throw err;
  }
  revalidatePath("/barrierefreiheit");
  revalidatePath("/verwaltung/schule");
  return { ok: true };
}

export interface SchulprofilImportState {
  ok?: boolean;
  error?: string;
  summary?: string;
  skipped?: string[];
}

/** P4-77: Schulprofil einspielen – nur Demo-/Vorschau-Instanz (prüft der Service), mit Schul- und Rechteverwaltung. */
export async function importSchulprofilAction(_prev: SchulprofilImportState, form: FormData): Promise<SchulprofilImportState> {
  const { user, perms } = await requirePermission("verwaltung.school");
  if (!hasPermission(perms, "verwaltung.rights")) return { error: "Dafür fehlt das Recht „Rechte & Module“." };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Bitte eine Schulprofil-Datei (JSON) auswählen." };
  if (file.size > SCHULPROFIL_MAX_BYTES) return { error: "Die Datei ist zu groß für ein Schulprofil." };
  try {
    const profile = parseSchulprofil(await file.text());
    const r = await importSchulprofil(await getDb(), getStorage(), MODULES, user.id, profile);
    revalidatePath("/", "layout");
    return {
      ok: true,
      summary: `Schulprofil eingespielt: ${r.modules} Module, ${r.settings} Einstellungen, ${r.grants} Rechte, ${r.logos} Logos.`,
      skipped: r.skipped,
    };
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Datei prüfen." };
    throw err;
  }
}
