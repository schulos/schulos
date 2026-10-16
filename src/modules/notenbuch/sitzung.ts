// Notenbuch (P5-12): Inaktivitätsablauf nur für Notenbuch-Seiten (PHASE5-NOTENBUCH §0/§4, Vordruck B1 „Sperre nach max.
// 15 min“; Q-5A-7). P4-71 hat den Inaktivitätsablauf der ganzen Sitzung als Einstellung je Schule ergänzt (src/core/auth/sitzungen.ts);
// dessen kürzeste Stufe sind 15 Minuten – das Notenbuch bleibt damit immer mindestens so streng.
//   · Je Sitzung merkt sich SchulOS die letzte Aktivität im Notenbuch (Seitenaufruf, Action, Export, Lebenszeichen der Seite
//     bei Tastatur/Maus). Liegt sie länger als `IDLE_MINUTES` zurück, ist das Notenbuch für diese Sitzung gesperrt – dauerhaft:
//     Seiten zeigen nur noch die Sperre, Actions und Export werden abgelehnt.
//   · Die Seite selbst sperrt nach derselben Zeit ohne Eingabe (blendet die Daten aus, lädt neu) und meldet das dem Server.
//   · Entsperren nur durch eine neue Anmeldung (neue Sitzung, mit zweitem Faktor) – kein „weiter“-Knopf.
//   · Erster Notenbuch-Aufruf einer Sitzung beginnt die Zählung (der Rest der Sitzung läuft nach den Regeln des Kerns).
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { notenbuchSessions } from "@/core/db/schema";

/** Minuten ohne Aktivität, nach denen das Notenbuch sperrt. */
export const IDLE_MINUTES = 15;
const IDLE_MS = IDLE_MINUTES * 60_000;

/** Rein: ist die letzte Aktivität zu alt? */
export function idleExpired(lastActiveAt: Date, now: Date): boolean {
  return now.getTime() - lastActiveAt.getTime() > IDLE_MS;
}

export type NotenbuchSessionState = "ok" | "locked";

/**
 * Aktivität verbuchen: gesperrt bzw. abgelaufen → „locked“ (und bleibt es), sonst Zeitpunkt auffrischen. Eine Sitzung gehört
 * genau einem Konto – passt `userId` nicht, gilt sie als gesperrt.
 */
export async function touchNotenbuchSession(db: Db, sessionId: string, userId: string, now = new Date()): Promise<NotenbuchSessionState> {
  const [row] = await db.select().from(notenbuchSessions).where(eq(notenbuchSessions.sessionId, sessionId));
  if (row) {
    if (row.userId !== userId || row.lockedAt) return "locked";
    if (idleExpired(row.lastActiveAt, now)) {
      await db.update(notenbuchSessions).set({ lockedAt: now }).where(eq(notenbuchSessions.sessionId, sessionId));
      return "locked";
    }
    await db.update(notenbuchSessions).set({ lastActiveAt: now }).where(eq(notenbuchSessions.sessionId, sessionId));
    return "ok";
  }
  await db.insert(notenbuchSessions).values({ sessionId, userId, lastActiveAt: now }).onConflictDoNothing();
  return "ok";
}

/** Nur lesen (ohne aufzufrischen): ist das Notenbuch für diese Sitzung gesperrt? */
export async function notenbuchSessionLocked(db: Db, sessionId: string, userId: string, now = new Date()): Promise<boolean> {
  const [row] = await db.select().from(notenbuchSessions).where(eq(notenbuchSessions.sessionId, sessionId));
  return Boolean(row && (row.userId !== userId || row.lockedAt || idleExpired(row.lastActiveAt, now)));
}

/** Sofort sperren (die Seite meldet Inaktivität, oder die Person sperrt selbst). */
export async function lockNotenbuchSession(db: Db, sessionId: string, userId: string, now = new Date()): Promise<void> {
  await db
    .insert(notenbuchSessions)
    .values({ sessionId, userId, lastActiveAt: now, lockedAt: now })
    .onConflictDoUpdate({ target: notenbuchSessions.sessionId, set: { lockedAt: now } });
}
