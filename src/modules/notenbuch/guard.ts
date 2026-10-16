// Notenbuch (P5-12): Inaktivitätsablauf für Seiten, Actions und Export – Sitzungskennung aus der Anmeldung, Logik in sitzung.ts.
// GATE-5a (G5A-S04): zusätzlich muss die **Sitzung** mit zweitem Faktor angemeldet sein (nicht nur das Konto 2FA haben) –
// sonst „zweiter-faktor“: die Seiten zeigen den Weg zur neuen Anmeldung mit Code, Actions und Export laufen nicht.
import "server-only";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth/auth";
import { sessionSecondFactorOk } from "@/core/auth/zwei-faktor";
import type { Db } from "@/core/db/client";
import { lockNotenbuchSession, touchNotenbuchSession, type NotenbuchSessionState } from "./sitzung";

/** Zustand des Notenbuchs für die Anfrage: frei, gesperrt (Inaktivität) oder Sitzung ohne zweiten Faktor. */
export type NotenbuchGate = NotenbuchSessionState | "zweiter-faktor";

/** Sitzung der Anfrage (Kennung + Konto) oder null. */
export async function sessionOf(h: Headers): Promise<{ sessionId: string; userId: string } | null> {
  const s = await (await getAuth()).api.getSession({ headers: h });
  return s ? { sessionId: s.session.id, userId: s.user.id } : null;
}

/**
 * Aktivität im Notenbuch verbuchen (Seite, Action, Export, Lebenszeichen). „locked“, wenn die Sitzung zu lange ruhte, gesperrt
 * wurde oder nicht zum Konto passt – ohne Sitzung ebenfalls; „zweiter-faktor“, wenn die Sitzung nicht mit Code angemeldet ist.
 */
export async function notenbuchActivity(db: Db, userId: string, h?: Headers): Promise<NotenbuchGate> {
  const s = await sessionOf(h ?? (await headers()));
  if (!s || s.userId !== userId) return "locked";
  if (!(await sessionSecondFactorOk(db, s.sessionId, userId))) return "zweiter-faktor";
  return touchNotenbuchSession(db, s.sessionId, userId);
}

/** G5A-S04: Sitzung der Anfrage mit zweitem Faktor angemeldet? Ohne Aktivität zu verbuchen (für Layout und Hinweis). */
export async function sessionHasSecondFactor(db: Db, userId: string, h?: Headers): Promise<boolean> {
  const s = await sessionOf(h ?? (await headers()));
  return Boolean(s && s.userId === userId && (await sessionSecondFactorOk(db, s.sessionId, userId)));
}

/** Notenbuch für die Sitzung der Anfrage sofort sperren. */
export async function lockNotenbuch(db: Db, userId: string): Promise<void> {
  const s = await sessionOf(await headers());
  if (s && s.userId === userId) await lockNotenbuchSession(db, s.sessionId, userId);
}

/**
 * Für jede Notenbuch-Seite: gesperrt bzw. ohne zweiten Faktor? Dann nur `<NotenbuchLocked reason={…} />` zeigen (das Layout
 * läuft bei Wechseln im Bereich nicht neu). null = frei.
 */
export async function notenbuchPageLocked(db: Db, userId: string): Promise<Exclude<NotenbuchGate, "ok"> | null> {
  const state = await notenbuchActivity(db, userId);
  return state === "ok" ? null : state;
}
