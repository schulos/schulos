"use server";

import { revalidatePath } from "next/cache";
import { AccountError, createAccount, resetPassword, resetTwoFactor, setLocked } from "@/accounts/service";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db/client";

export interface AccountFormState {
  error?: string;
  /** Startpasswort – wird genau einmal angezeigt */
  password?: { username: string; value: string };
  values?: { firstName: string; lastName: string; username: string };
  ok?: string;
}

async function guard(run: () => Promise<AccountFormState>, values?: AccountFormState["values"]): Promise<AccountFormState> {
  try {
    const r = await run();
    revalidatePath("/konten");
    return r;
  } catch (err) {
    if (err instanceof AccountError) return { error: err.message, values };
    throw err;
  }
}

export async function createAccountAction(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const user = await requireUser();
  const values = { firstName: String(form.get("firstName") ?? ""), lastName: String(form.get("lastName") ?? ""), username: String(form.get("username") ?? "") };
  return guard(async () => {
    const r = await createAccount(await getDb(), user.id, values);
    return { password: { username: values.username.trim().toLowerCase(), value: r.password } };
  }, values);
}

export async function accountAction(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const user = await requireUser();
  const id = String(form.get("id") ?? "");
  const what = String(form.get("what") ?? "");
  const username = String(form.get("username") ?? "");
  const db = await getDb();
  return guard(async () => {
    if (what === "lock") await setLocked(db, user.id, id, true);
    else if (what === "unlock") await setLocked(db, user.id, id, false);
    else if (what === "2fa") await resetTwoFactor(db, user.id, id);
    else if (what === "password") return { password: { username, value: await resetPassword(db, user.id, id) } };
    else return { error: "Unbekannte Aktion" };
    return { ok: what === "2fa" ? "Zwei-Faktor zurückgesetzt – beim nächsten Anmelden neu einrichten." : "Gespeichert." };
  });
}
