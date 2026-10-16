"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/core/auth/auth";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { getCurrentUser } from "@/core/auth/session";
import { CodeListError, redeemCode } from "@/core/auth/codeliste";
import { factorAddAllowedFor, SETUP_BLOCKED_TEXT } from "@/core/auth/pflicht";
import { discardPendingTotpSetup } from "@/core/auth/geraete-vertrauen";
import {
  confirmSetup,
  disableOwn,
  regenerateBackupCodes,
  startSetup,
  TwoFactorRequiredError,
} from "@/core/auth/zwei-faktor";
import { groupSecret, twoFactorErrorMessage } from "@schulos/server/two-factor";
import { getDb } from "@/core/db/client";
import type { TwoFactorFormState } from "@schulos/ui/auth-forms";

// Einschalten/Ausschalten tauscht die Sitzung aus (neues Cookie). Ohne Redirect würde Next die Seite noch mit dem
// alten Cookie rendern, keine Sitzung finden und zur Anmeldung springen.

// Nur das eigene Konto: angemeldet reicht (requireUser würde Pflicht-Konten ohne 2FA hierher zurückleiten).
async function me() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  return current;
}

async function guard(run: () => Promise<TwoFactorFormState>): Promise<TwoFactorFormState> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { error: err.message };
    if (isAuthApiError(err)) return { error: twoFactorErrorMessage(err) };
    throw err;
  }
}

// G4E-C10: wer schon einen zweiten Faktor hat (Sicherheitsschlüssel), ergänzt die Code-App wie einen weiteren Schlüssel (Q-4E-11)
const setupAllowedHere = async (userId: string) => factorAddAllowedFor(await getDb(), await headers(), userId);

/** Einrichten hier nicht erlaubt (SEC-01): eine angefangene Einrichtung verwerfen (G4E-S01), Hinweis zeigen. */
async function blocked(userId: string): Promise<TwoFactorFormState> {
  await discardPendingTotpSetup(await getDb(), userId);
  return { error: SETUP_BLOCKED_TEXT };
}

export async function startSetupAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  const { user } = await me();
  const password = String(form.get("password") ?? "");
  if (!password) return { error: "Bitte das Passwort eingeben." };
  // SEC-01 (Q-5A-30): Ersteinrichtung nur im Schulnetz oder mit Freigabe der Verwaltung
  if (!(await setupAllowedHere(user.id))) return blocked(user.id);
  return guard(async () => {
    const s = await startSetup(await getAuth(), await headers(), password);
    return { setup: { qrSvg: s.qrSvg, secret: groupSecret(s.secret), backupCodes: s.backupCodes } };
  });
}

async function confirmSetupTo(target: string, prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  const { user } = await me();
  const code = String(form.get("code") ?? "");
  if (!code.trim()) return { ...prev, error: "Bitte den 6-stelligen Code eingeben." };
  if (!(await setupAllowedHere(user.id))) return { ...(await blocked(user.id)), setup: undefined };
  const res = await guard(async () => {
    await confirmSetup(await getDb(), await getAuth(), await headers(), user.id, code);
    return {};
  });
  if (res.error) return { ...prev, error: res.error };
  redirect(target);
}

export async function confirmSetupAction(prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  return confirmSetupTo("/zwei-faktor?eingerichtet=1", prev, form);
}

/** Einrichtung aus dem Notenbuch heraus (`?grund=notenbuch`, F5-07): danach führt „Weiter zum Notenbuch“ zurück. */
export async function confirmSetupForNotenbuchAction(prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  return confirmSetupTo("/zwei-faktor?eingerichtet=1&grund=notenbuch", prev, form);
}

export async function regenerateCodesAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  const { user } = await me();
  const password = String(form.get("password") ?? "");
  if (!password) return { error: "Bitte das Passwort eingeben." };
  return guard(async () => ({ codes: await regenerateBackupCodes(await getDb(), await getAuth(), await headers(), user.id, password) }));
}

export async function disableAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  const { perms } = await me();
  const password = String(form.get("password") ?? "");
  if (!password) return { error: "Bitte das Passwort eingeben." };
  const res = await guard(async () => {
    await disableOwn(await getDb(), await getAuth(), await headers(), perms, password);
    return {};
  });
  if (res.error) return res;
  redirect("/zwei-faktor?ausgeschaltet=1");
}

/**
 * SEC-02: Anmeldung von außen mit einem Code von der gedruckten Code-Liste abschließen – kennzeichnet die Sitzung als „mit
 * zweitem Faktor“ (SEC-01), der Code ist danach verbraucht.
 */
export async function redeemCodeListAction(_prev: { error?: string }, form: FormData): Promise<{ error?: string }> {
  const { user } = await me();
  const h = await headers();
  const session = await (await getAuth()).api.getSession({ headers: h });
  if (!session || session.user.id !== user.id) redirect("/login");
  try {
    await redeemCode(await getDb(), user.id, session.session.id, String(form.get("code") ?? ""));
  } catch (err) {
    if (err instanceof CodeListError) return { error: err.message };
    throw err;
  }
  redirect("/");
}
