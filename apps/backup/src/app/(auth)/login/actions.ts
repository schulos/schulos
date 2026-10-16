"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { needsSecondFactor, secondFactorUrl } from "@schulos/server/two-factor";
import type { LoginState } from "@schulos/ui/auth-forms";
import { getAuth } from "@/auth/auth";
import { safeNext } from "../auth-card";

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!username || !password) return { error: "Bitte Benutzername und Passwort eingeben." };
  const auth = await getAuth();
  const next = safeNext(form.get("next"));
  let res: unknown;
  try {
    res = await auth.api.signInUsername({ body: { username, password }, headers: await headers() });
  } catch (err) {
    if (isAuthApiError(err)) {
      const shown = err.status === "FORBIDDEN" || err.status === "TOO_MANY_REQUESTS";
      return { error: shown ? err.message : "Benutzername oder Passwort ist falsch." };
    }
    throw err;
  }
  // Ohne eingerichteten zweiten Faktor gibt es eine Sitzung – requireUser() schickt dann zur Pflicht-Einrichtung
  redirect(needsSecondFactor(res) ? secondFactorUrl(next) : next);
}

export async function logoutAction(): Promise<void> {
  const auth = await getAuth();
  await auth.api.signOut({ headers: await headers() });
  redirect("/login");
}
