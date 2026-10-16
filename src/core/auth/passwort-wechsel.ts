import { eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { users } from "@/core/db/schema";
import type { Auth } from "./auth";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { validatePasswordChange, type PasswordContext, type PasswordFieldErrors } from "@schulos/server/passwort";

export type { PasswordFieldErrors };

/**
 * Eigenes Passwort ändern (auch der Pflicht-Wechsel nach Startpasswort): Regeln prüfen, über Better-Auth setzen
 * (meldet alle anderen Sitzungen ab und tauscht die eigene), Pflicht-Flag löschen, protokollieren.
 * Liefert Feldfehler oder null.
 */
export async function changeOwnPassword(
  db: Db,
  auth: Auth,
  headers: Headers,
  user: PasswordContext & { id: string },
  input: { current: string; next: string; repeat: string },
): Promise<PasswordFieldErrors | null> {
  const invalid = validatePasswordChange(user, input);
  if (invalid) return invalid;
  try {
    await auth.api.changePassword({ body: { currentPassword: input.current, newPassword: input.next, revokeOtherSessions: true }, headers });
  } catch (err) {
    if (isAuthApiError(err) && /password/i.test(err.message)) return { current: "Das bisherige Passwort ist falsch." };
    throw err;
  }
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, user.id));
  await audit(db, user.id, "konto.passwort.geaendert", user.id);
  return null;
}
