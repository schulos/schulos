"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/core/auth/auth";
import { getDemoAccounts } from "@/core/auth/demo";
import { needsSecondFactor, secondFactorUrl } from "@schulos/server/two-factor";
import { DEMO_PASSWORD } from "@/core/seed/data";

/** Meldet (ggf. nach Abmelden) als Demo-Konto an. Nur wenn der Demo-Login aktiv ist. */
export async function demoLoginAction(username: string): Promise<void> {
  const allowed = await getDemoAccounts();
  if (!allowed.some((a) => a.username === username)) throw new Error("Demo-Login nicht erlaubt");
  const auth = await getAuth();
  const h = await headers();
  await auth.api.signOut({ headers: h }).catch(() => undefined);
  const res = await auth.api.signInUsername({ body: { username, password: DEMO_PASSWORD }, headers: h });
  redirect(needsSecondFactor(res) ? secondFactorUrl("/") : "/");
}
