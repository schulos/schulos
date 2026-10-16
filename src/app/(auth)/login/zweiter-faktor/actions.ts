"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/core/auth/auth";
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { completePasskeySecondFactor, completeSecondFactor, passkeySignInOptions } from "@/core/auth/zwei-faktor";
import { getDb } from "@/core/db/client";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { safeNext } from "@schulos/server/safe-next";
import { twoFactorErrorMessage } from "@schulos/server/two-factor";
import type { SecondFactorState } from "@schulos/ui/auth-forms";

export async function verifySecondFactorAction(_prev: SecondFactorState, form: FormData): Promise<SecondFactorState> {
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  const backup = form.get("mode") === "backup";
  if (!code) return { error: backup ? "Bitte einen Wiederherstellungscode eingeben." : "Bitte den 6-stelligen Code eingeben." };
  const auth = await getAuth();
  const h = await headers();
  try {
    // G5A-S04: die neue Sitzung als „mit zweitem Faktor angemeldet“ kennzeichnen (Notenbuch verlangt das)
    await completeSecondFactor(await getDb(), auth, h, code, backup);
  } catch (err) {
    if (isAuthApiError(err)) {
      const error = twoFactorErrorMessage(err);
      return { error, expired: error.startsWith("Die Anmeldung ist abgelaufen") };
    }
    throw err;
  }
  redirect(safeNext(form.get("next")));
}

/** Meldung zu einem Fehler beim Schlüssel: eigene Texte (Plugin) durchreichen, „abgelaufen“ wie beim Code. */
function passkeyError(err: { message?: string; body?: { code?: string } }): { error: string; expired?: boolean } {
  const code = err.body?.code ?? "";
  if (code === "INVALID_TWO_FACTOR_COOKIE") return { error: twoFactorErrorMessage(err), expired: true };
  return { error: err.message || "Der Schlüssel wurde nicht erkannt. Bitte noch einmal versuchen." };
}

export type PasskeyOptionsResult = { options: PublicKeyCredentialRequestOptionsJSON } | { error: string; expired?: boolean };

/** SEC-03: Aufforderung an den Sicherheitsschlüssel für die angefangene Anmeldung. */
export async function passkeyOptionsAction(): Promise<PasskeyOptionsResult> {
  try {
    return { options: await passkeySignInOptions(await getAuth(), await headers()) };
  } catch (err) {
    if (isAuthApiError(err)) return passkeyError(err);
    throw err;
  }
}

/** SEC-03: Antwort des Schlüssels prüfen und die Anmeldung abschließen (Sitzung „mit zweitem Faktor“). */
export async function passkeyVerifyAction(response: AuthenticationResponseJSON, next: string): Promise<{ error: string; expired?: boolean }> {
  try {
    await completePasskeySecondFactor(await getDb(), await getAuth(), await headers(), response);
  } catch (err) {
    if (isAuthApiError(err)) return passkeyError(err);
    throw err;
  }
  redirect(safeNext(next));
}
