"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/core/auth/auth";
import { changeOwnPassword } from "@/core/auth/passwort-wechsel";
import type { PasswordFormState } from "@schulos/ui/auth-forms";
import { getCurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";

// Nur das eigene Konto: angemeldet reicht (requireUser würde Konten mit Startpasswort hierher zurückleiten).
export async function changePasswordAction(_prev: PasswordFormState, form: FormData): Promise<PasswordFormState> {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const errors = await changeOwnPassword(await getDb(), await getAuth(), await headers(), current.user, {
    current: String(form.get("current") ?? ""),
    next: String(form.get("next") ?? ""),
    repeat: String(form.get("repeat") ?? ""),
  });
  if (errors) return { fieldErrors: errors };
  // Better-Auth hat die Sitzung getauscht – Redirect, damit das neue Cookie gilt (wie bei /zwei-faktor)
  redirect("/passwort?geaendert=1");
}
