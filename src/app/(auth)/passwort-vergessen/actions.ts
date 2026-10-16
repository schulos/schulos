"use server";

// P4-70: „Passwort vergessen“ ohne Anmeldung – Antworten immer gleich und frühestens nach 400 ms (kein Aufzählen von Konten).
import { completePasswordReset, PasswordResetError, requestPasswordReset } from "@/core/auth/passwort-reset";
import { getDb } from "@/core/db/client";
import { mailAvailable } from "@/core/mail";
import { PUBLIC_MIN_MS, publicIp } from "@/core/public-action";
import { withMinDuration } from "@/core/public-token";
import { readSchoolSettings } from "@/core/settings";

export interface ResetRequestState {
  done?: boolean;
  error?: string;
}

export async function requestResetAction(_prev: ResetRequestState, form: FormData): Promise<ResetRequestState> {
  const input = String(form.get("konto") ?? "");
  if (!input.trim()) return { error: "Bitte Benutzername oder E-Mail-Adresse eingeben." };
  if (!mailAvailable()) return { error: "Der E-Mail-Versand ist nicht eingerichtet – bitte an das Sekretariat wenden." };
  return withMinDuration(PUBLIC_MIN_MS, async () => {
    const db = await getDb();
    await requestPasswordReset(db, input, { school: (await readSchoolSettings(db)).name, ip: await publicIp() });
    return { done: true };
  });
}

export interface ResetCompleteState {
  done?: boolean;
  error?: string;
}

export async function completeResetAction(token: string, _prev: ResetCompleteState, form: FormData): Promise<ResetCompleteState> {
  return withMinDuration(PUBLIC_MIN_MS, async () => {
    const db = await getDb();
    try {
      await completePasswordReset(
        db,
        token,
        { next: String(form.get("next") ?? ""), repeat: String(form.get("repeat") ?? "") },
        { school: (await readSchoolSettings(db)).name },
      );
    } catch (err) {
      if (err instanceof PasswordResetError) return { error: err.message };
      throw err;
    }
    return { done: true };
  });
}
