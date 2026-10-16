import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./auth";

export interface CurrentUser {
  id: string;
  name: string;
  username: string | null;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
}

/** Aktuelles Konto oder null. Pro Request gecacht. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const u = session.user as typeof session.user & { username?: string | null; twoFactorEnabled?: boolean | null; status?: string; mustChangePassword?: boolean };
  if (u.status === "locked") return null;
  return { id: u.id, name: u.name, username: u.username ?? null, twoFactorEnabled: Boolean(u.twoFactorEnabled), mustChangePassword: Boolean(u.mustChangePassword) };
});

/** Geschützter Bereich: ohne Anmeldung zum Login, mit Startpasswort zum Wechsel, ohne zweiten Faktor zur Einrichtung (Pflicht für alle). */
export async function requireUser(): Promise<CurrentUser> {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (current.mustChangePassword) redirect("/passwort");
  if (!current.twoFactorEnabled) redirect("/zwei-faktor");
  return current;
}
