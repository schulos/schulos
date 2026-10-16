"use server";

import { isAuthApiError } from "@schulos/server/auth-errors";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/core/auth/auth";
import { getDb } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { secondFactorMethods } from "@/core/auth/passkeys";
import { discardPendingTotpSetup } from "@/core/auth/geraete-vertrauen";
import { eq } from "drizzle-orm";
import { endLiveStreams } from "@/core/notifications/bus";
import { endOfflineForSession } from "@/modules/notenbuch/offline";
import { safeNext } from "@schulos/server/safe-next";
import { needsSecondFactor, secondFactorUrl } from "@schulos/server/two-factor";
import type { LoginState } from "@schulos/ui/auth-forms";

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
  // G4E-S01: eine angefangene, nie bestätigte Einrichtung der Code-App gilt mit der neuen Anmeldung als abgebrochen
  const userId = (res as { user?: { id?: string } } | null)?.user?.id;
  if (!needsSecondFactor(res) && userId) await discardPendingTotpSetup(await getDb(), userId);
  redirect(needsSecondFactor(res) ? await secondFactorPage(username, next) : next);
}

/**
 * SEC-03: Seite für den zweiten Faktor – mit Hinweis, welche Wege das Konto hat (Code-App, Schlüssel). Nur Anzeige: das Passwort
 * war schon richtig, die Seite prüft selbst nichts daran.
 */
async function secondFactorPage(username: string, next: string): Promise<string> {
  const db = await getDb();
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username.toLowerCase()));
  const url = secondFactorUrl(next);
  if (!u) return url;
  const m = await secondFactorMethods(db, u.id);
  if (!m.passkeys) return url;
  return `${url}${url.includes("?") ? "&" : "?"}schluessel=1${m.totp ? "" : "&code=0"}`;
}

export async function logoutAction(): Promise<void> {
  const auth = await getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  // G5A-C01: echtes Abmelden beendet die Offline-Eingabe des Notenbuchs auf diesem Gerät (die Neuanmeldung aus der
  // 15-Minuten-Sperre läuft über notenbuchReloginAction und lässt sie stehen); die Seite warnt vorher, wenn noch etwas offen ist
  if (session) await endOfflineForSession(await getDb(), session.user.id, session.session.id);
  await auth.api.signOut({ headers: h });
  // offene Live-Ströme sofort beenden (SEC-04); andere Geräte verbinden neu und werden dabei geprüft
  if (session) endLiveStreams(session.user.id);
  redirect("/login");
}
