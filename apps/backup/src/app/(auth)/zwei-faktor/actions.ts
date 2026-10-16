"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { groupSecret, twoFactorErrorMessage } from "@schulos/server/two-factor";
import type { TwoFactorFormState } from "@schulos/ui/auth-forms";
import { getAuth } from "@/auth/auth";
import { getCurrentUser } from "@/auth/session";
import { confirmSetup, regenerateBackupCodes, startSetup } from "@/auth/two-factor";
import { getDb } from "@/db/client";

// Nur das eigene Konto: angemeldet reicht (requireUser würde ohne 2FA hierher zurückleiten).
async function me() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  return current;
}

async function guard(run: () => Promise<TwoFactorFormState>): Promise<TwoFactorFormState> {
  try {
    return await run();
  } catch (err) {
    if (isAuthApiError(err)) return { error: twoFactorErrorMessage(err) };
    throw err;
  }
}

export async function startSetupAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  await me();
  const password = String(form.get("password") ?? "");
  if (!password) return { error: "Bitte das Passwort eingeben." };
  return guard(async () => {
    const s = await startSetup(await getAuth(), await headers(), password);
    return { setup: { qrSvg: s.qrSvg, secret: groupSecret(s.secret), backupCodes: s.backupCodes } };
  });
}

// Einschalten tauscht die Sitzung aus (neues Cookie) – deshalb Redirect statt Re-Render.
export async function confirmSetupAction(prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  const user = await me();
  const code = String(form.get("code") ?? "");
  if (!code.trim()) return { ...prev, error: "Bitte den 6-stelligen Code eingeben." };
  const res = await guard(async () => {
    await confirmSetup(await getDb(), await getAuth(), await headers(), user.id, code);
    return {};
  });
  if (res.error) return { ...prev, error: res.error };
  redirect("/zwei-faktor?eingerichtet=1");
}

export async function regenerateCodesAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  const user = await me();
  const password = String(form.get("password") ?? "");
  if (!password) return { error: "Bitte das Passwort eingeben." };
  return guard(async () => ({ codes: await regenerateBackupCodes(await getDb(), await getAuth(), await headers(), user.id, password) }));
}
