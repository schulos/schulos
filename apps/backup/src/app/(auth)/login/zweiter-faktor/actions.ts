"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { twoFactorErrorMessage } from "@schulos/server/two-factor";
import type { SecondFactorState } from "@schulos/ui/auth-forms";
import { getAuth } from "@/auth/auth";
import { safeNext } from "../../auth-card";

export async function verifySecondFactorAction(_prev: SecondFactorState, form: FormData): Promise<SecondFactorState> {
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  const backup = form.get("mode") === "backup";
  if (!code) return { error: backup ? "Bitte einen Wiederherstellungscode eingeben." : "Bitte den 6-stelligen Code eingeben." };
  const auth = await getAuth();
  const h = await headers();
  try {
    if (backup) await auth.api.verifyBackupCode({ body: { code }, headers: h });
    else await auth.api.verifyTOTP({ body: { code }, headers: h });
  } catch (err) {
    if (isAuthApiError(err)) {
      const error = twoFactorErrorMessage(err);
      return { error, expired: error.startsWith("Die Anmeldung ist abgelaufen") };
    }
    throw err;
  }
  redirect(safeNext(form.get("next")));
}
