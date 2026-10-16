// GATE-4e (G4E-S01/S02): Reste, die den zweiten Faktor umgehen könnten, gezielt wegräumen.
//
// - „Gerät vertrauen“ (Better Auth trustDevice) ist abgeschaltet (`trustDeviceMaxAge: 0`, Migration 0085 löscht alte Einträge).
//   Zusätzlich räumen Zurücksetzen der 2FA, Passwort-Reset, Einrichtung und reset-admin etwaige Einträge des Kontos weg – falls
//   die Einstellung je wieder geändert wird, übersteht kein Vertrauens-Cookie diese Schritte.
// - Eine angefangene, nie bestätigte Einrichtung der Code-App (Zeile mit `verified = false`) wird verworfen, sobald sie nicht
//   mehr gebraucht wird (neue Anmeldung, Einrichtung nicht erlaubt) – damit liegt kein Geheimnis herum, das später ohne die
//   Schulnetz-Prüfung bestätigt werden könnte.
import { and, eq, like } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { twoFactors, verifications } from "@/core/db/schema";

/** Vertrauens-Einträge („Gerät vertrauen“) des Kontos löschen. Liefert die Anzahl. */
export async function dropTrustedDevices(db: Db, userId: string): Promise<number> {
  const rows = await db
    .delete(verifications)
    .where(and(like(verifications.identifier, "trust-device-%"), eq(verifications.value, userId)))
    .returning({ id: verifications.id });
  return rows.length;
}

/** Nie bestätigte Einrichtung der Code-App verwerfen (bestätigte bleiben). Liefert, ob etwas verworfen wurde. */
export async function discardPendingTotpSetup(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .delete(twoFactors)
    .where(and(eq(twoFactors.userId, userId), eq(twoFactors.verified, false)))
    .returning({ id: twoFactors.id });
  return rows.length > 0;
}
