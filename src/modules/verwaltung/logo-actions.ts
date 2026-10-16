"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { LOGO_VARIANTS, type LogoVariant } from "@/core/school/logo-meta";
import { removeSchoolLogo, setSchoolLogo } from "@/core/school/logo";
import type { FormState } from "./actions";
import { ValidationError } from "./users";

function variantOf(form: FormData): LogoVariant | null {
  const v = String(form.get("variant") ?? "");
  return (LOGO_VARIANTS as readonly string[]).includes(v) ? (v as LogoVariant) : null;
}

/** Erscheinungsbild (P4-03): Logo, Variante für dunkle Darstellung oder Symbol hochladen bzw. ersetzen. */
export async function uploadLogoAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.school");
  const variant = variantOf(form);
  if (!variant) return { error: "Unbekanntes Feld." };
  const file = form.get("file");
  try {
    const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
    await setSchoolLogo(await getDb(), getStorage(), user.id, variant, bytes);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Datei prüfen.", fieldErrors: err.fieldErrors };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Logo-Variante entfernen – danach gilt wieder der Rückfall (Schulname bzw. SchulOS-Zeichen). */
export async function removeLogoAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.school");
  const variant = variantOf(form);
  if (!variant) return { error: "Unbekanntes Feld." };
  await removeSchoolLogo(await getDb(), getStorage(), user.id, variant);
  revalidatePath("/", "layout");
  return { ok: true };
}
