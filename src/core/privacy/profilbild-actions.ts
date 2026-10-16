"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { removeProfilePhoto, setProfilePhoto } from "./profilbild";

// Befugnis hängt an der Beziehung (selbst, Elternteil, Verwaltung) – geprüft in setProfilePhoto/removeProfilePhoto.

export async function setPhotoAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const file = form.get("photo");
  try {
    const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
    await setProfilePhoto(
      await getDb(),
      getStorage(),
      perms,
      String(form.get("userId") ?? ""),
      { bytes, consent: form.get("consent") === "1", consentOn: String(form.get("consentOn") ?? "") || undefined },
      toBerlinDate(new Date()),
    );
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function removePhotoAction(form: FormData): Promise<void> {
  const { perms } = await requireUser();
  await removeProfilePhoto(await getDb(), getStorage(), perms, String(form.get("userId") ?? ""));
  revalidatePath("/", "layout");
}
