"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import type { PasswordFormState } from "@schulos/ui/auth-forms";
import { changeOwnPassword } from "@/accounts/service";
import { getAuth } from "@/auth/auth";
import { getCurrentUser } from "@/auth/session";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";

// Nur das eigene Konto: angemeldet reicht (requireUser würde Konten mit Startpasswort hierher zurückleiten).
export async function changePasswordAction(_prev: PasswordFormState, form: FormData): Promise<PasswordFormState> {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const db = await getDb();
  const [u] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, current.id));
  const errors = await changeOwnPassword(db, await getAuth(), await headers(), { ...current, ...u }, {
    current: String(form.get("current") ?? ""),
    next: String(form.get("next") ?? ""),
    repeat: String(form.get("repeat") ?? ""),
  });
  if (errors) return { fieldErrors: errors };
  // Better-Auth hat die Sitzung getauscht – Redirect, damit das neue Cookie gilt
  redirect("/passwort?geaendert=1");
}
