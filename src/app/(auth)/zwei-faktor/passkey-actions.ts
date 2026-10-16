"use server";

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/core/auth/auth";
import { finishRegistration, PasskeyError, registrationOptions, relyingParty, removePasskey } from "@/core/auth/passkeys";
import { factorAddAllowedFor, SETUP_BLOCKED_TEXT } from "@/core/auth/pflicht";
import { getCurrentUser } from "@/core/auth/session";
import { twoFactorStatus } from "@/core/auth/zwei-faktor";
import { getDb } from "@/core/db/client";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { twoFactorErrorMessage } from "@schulos/server/two-factor";

// SEC-03: Sicherheitsschlüssel des eigenen Kontos einrichten und entfernen (Seite /zwei-faktor). Nur das eigene Konto – angemeldet
// reicht (Pflicht-Konten ohne 2FA landen genau hier). Passwort zur Bestätigung wie bei der Code-App.

async function me() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  return current;
}

async function passwordOk(password: string): Promise<string | null> {
  if (!password) return "Bitte das Passwort eingeben.";
  try {
    await (await getAuth()).api.verifyPassword({ body: { password }, headers: await headers() });
    return null;
  } catch (err) {
    if (isAuthApiError(err)) return twoFactorErrorMessage(err);
    throw err;
  }
}

/**
 * Ersteinrichtung (noch kein zweiter Faktor): nur im Schulnetz oder mit Freigabe der Verwaltung (SEC-01, Q-5A-30) – wie bei der
 * Code-App. Wer schon einen zweiten Faktor hat, hat sich damit angemeldet und darf weitere Schlüssel ergänzen.
 */
async function mayAdd(userId: string): Promise<boolean> {
  return factorAddAllowedFor(await getDb(), await headers(), userId);
}

export type PasskeyStartResult = { options: PublicKeyCredentialCreationOptionsJSON } | { error: string };

export async function passkeyRegistrationStartAction(password: string): Promise<PasskeyStartResult> {
  const { user } = await me();
  const db = await getDb();
  if (!(await mayAdd(user.id))) return { error: SETUP_BLOCKED_TEXT };
  const wrong = await passwordOk(password);
  if (wrong) return { error: wrong };
  try {
    return { options: await registrationOptions(db, user.id, relyingParty(await headers())) };
  } catch (err) {
    if (err instanceof PasskeyError) return { error: err.message };
    throw err;
  }
}

export async function passkeyRegistrationFinishAction(response: RegistrationResponseJSON, name: string, grund?: string): Promise<{ error: string }> {
  const { user } = await me();
  const db = await getDb();
  const h = await headers();
  if (!(await mayAdd(user.id))) return { error: SETUP_BLOCKED_TEXT };
  const session = await (await getAuth()).api.getSession({ headers: h });
  if (!session || session.user.id !== user.id) redirect("/login");
  try {
    await finishRegistration(db, { userId: user.id, currentSessionId: session.session.id, response, name, rp: relyingParty(h) });
  } catch (err) {
    if (err instanceof PasskeyError) return { error: err.message };
    throw err;
  }
  redirect(grund === "notenbuch" ? "/zwei-faktor?schluessel=1&grund=notenbuch" : "/zwei-faktor?schluessel=1");
}

export async function passkeyRemoveAction(_prev: { error?: string }, form: FormData): Promise<{ error?: string }> {
  const { user, perms } = await me();
  const db = await getDb();
  const wrong = await passwordOk(String(form.get("password") ?? ""));
  if (wrong) return { error: wrong };
  try {
    await removePasskey(db, user.id, String(form.get("id") ?? ""), (await twoFactorStatus(db, perms)).enforced);
  } catch (err) {
    if (err instanceof PasskeyError) return { error: err.message };
    throw err;
  }
  redirect("/zwei-faktor?entfernt=1");
}
