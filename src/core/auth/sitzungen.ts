// P4-71: Sitzungsübersicht („Angemeldete Geräte“), einzelne Geräte bzw. überall abmelden, Inaktivitätsablauf je Schule.
//
// Inaktivität: Jede Anfrage mit Sitzung frischt `sessions.last_active_at` höchstens einmal je Minute auf; liegt die letzte
// Aktivität länger als die Einstellung der Schule zurück (Verwaltung → System → Anmeldung, Vorgabe aus = nur die 7 Tage der
// Sitzung), endet die Sitzung. Live-Ströme und automatisches Neuladen ohne Eingabe (Tagesleiste, Vertretungsplan, Gong,
// Herzschlag – G4E-C01, `@schulos/ui/passive`) zählen nicht als Aktivität. Das Notenbuch sperrt unabhängig davon nach 15 Minuten
// (Q-5A-7) – die Einstellung hat keine kürzere Stufe, das Notenbuch bleibt also mindestens so streng.
//
// Notenbuch-Offline (Q-5A-28): Ablauf durch Inaktivität ist kein echtes Abmelden (der Offline-Anteil bleibt, die Frist begrenzt).
// Abmelden eines Geräts hier und „überall abmelden“ gelten als echtes Abmelden: der Offline-Anteil der betroffenen Geräte geht
// mit (die Seite warnt vorher).
import { and, desc, eq, ne } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { notenbuchOfflineDevices, sessions } from "@/core/db/schema";
import { endLiveStreams } from "@/core/notifications/bus";
import { endOfflineForSession } from "@/modules/notenbuch/offline";
import { isPassiveRequest } from "@schulos/ui/passive";

/** Stufen des Inaktivitätsablaufs in Minuten (0 = aus). Keine Stufe unter 15 Minuten (Notenbuch-Sperre, Q-5A-7). */
export const IDLE_OPTIONS = [0, 15, 30, 60, 120, 240, 480] as const;
/** Auffrischen höchstens so oft (Schreiblast) */
export const TOUCH_EVERY_MS = 60_000;

export function idleLabel(minutes: number): string {
  if (minutes === 0) return "aus (Sitzung gilt 7 Tage)";
  return minutes < 60 ? `${minutes} Minuten` : minutes === 60 ? "1 Stunde" : `${minutes / 60} Stunden`;
}

/** Rein: ist die Sitzung wegen Inaktivität abgelaufen? */
export function sessionIdleExpired(lastActive: Date, now: Date, idleMinutes: number): boolean {
  return idleMinutes > 0 && now.getTime() - lastActive.getTime() > idleMinutes * 60_000;
}

/**
 * Aktivität verbuchen (Seiten, Actions, API): abgelaufen → Sitzung beendet, „abgelaufen“; sonst höchstens minütlich auffrischen.
 * `touch: false` nur prüfen (Live-Strom).
 */
export async function sessionActivity(db: Db, sessionId: string, idleMinutes: number, now = new Date(), touch = true): Promise<"ok" | "abgelaufen"> {
  const [row] = await db
    .select({ userId: sessions.userId, last: sessions.lastActiveAt, created: sessions.createdAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!row) return "abgelaufen";
  const last = row.last ?? row.created;
  if (sessionIdleExpired(last, now, idleMinutes)) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    endLiveStreams(row.userId);
    return "abgelaufen";
  }
  if (touch && now.getTime() - last.getTime() > TOUCH_EVERY_MS)
    await db.update(sessions).set({ lastActiveAt: now }).where(eq(sessions.id, sessionId));
  return "ok";
}

/**
 * G4E-C01: Aktivität einer Anfrage verbuchen – automatisches Neuladen ohne Eingabe der Person (Kennzeichen aus
 * `@schulos/ui/passive`) prüft nur und frischt nicht auf; Seitenaufrufe zählen immer.
 */
export async function requestActivity(db: Db, sessionId: string, idleMinutes: number, headers: Headers, now = new Date()): Promise<"ok" | "abgelaufen"> {
  return sessionActivity(db, sessionId, idleMinutes, now, !isPassiveRequest(headers));
}

export interface SessionRow {
  id: string;
  current: boolean;
  device: string;
  ip: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  secondFactor: boolean;
  /** Notenbuch-Offline-Eingabe auf diesem Gerät eingeschaltet */
  offline: boolean;
}

/** Rein: Browser und System aus dem User-Agent – grob, nur zum Wiedererkennen. */
export function deviceLabel(ua: string | null): string {
  if (!ua) return "Unbekanntes Gerät";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPad/.test(ua)
    ? "iPad"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : "unbekanntes System";
  return `${browser} auf ${os}`;
}

/** Eigene Sitzungen, neueste Aktivität zuerst. */
export async function listOwnSessions(db: Db, userId: string, currentId: string | null, now = new Date()): Promise<SessionRow[]> {
  const rows = await db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt));
  const offline = new Set(
    (
      await db
        .select({ sessionId: notenbuchOfflineDevices.sessionId })
        .from(notenbuchOfflineDevices)
        .where(eq(notenbuchOfflineDevices.userId, userId))
    ).map((r) => r.sessionId),
  );
  return rows
    .filter((s) => s.expiresAt > now)
    .map((s) => ({
      id: s.id,
      current: s.id === currentId,
      device: deviceLabel(s.userAgent),
      ip: s.ipAddress,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt ?? s.createdAt,
      secondFactor: s.secondFactorAt !== null,
      offline: offline.has(s.id),
    }))
    .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
}

/** Anzahl Geräte mit eingeschalteter Notenbuch-Offline-Eingabe (für die Warnung vor „überall abmelden“). */
export async function offlineDeviceCount(db: Db, userId: string): Promise<number> {
  return (await db.select({ id: notenbuchOfflineDevices.deviceId }).from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.userId, userId)))
    .length;
}

/** Ein anderes eigenes Gerät abmelden (echtes Abmelden – auch der Notenbuch-Offline-Anteil dieses Geräts geht). */
export async function endOwnSession(db: Db, userId: string, sessionId: string, currentId: string): Promise<boolean> {
  if (sessionId === currentId) return false;
  await endOfflineForSession(db, userId, sessionId);
  const ended = await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id });
  if (ended.length === 0) return false;
  endLiveStreams(userId);
  await audit(db, userId, "konto.sitzung.beendet", userId);
  return true;
}

/**
 * Überall abmelden – alle Sitzungen (auch diese) und die Notenbuch-Offline-Eingabe auf **allen** Geräten (auch solchen, deren
 * Sitzung schon abgelaufen ist): gilt als echtes Abmelden (Q-5A-28). Noch nicht übertragene Offline-Eingaben gehen verloren.
 */
export async function endAllOwnSessions(db: Db, userId: string, keep?: string): Promise<{ sessions: number; offline: number }> {
  const offline = await db
    .delete(notenbuchOfflineDevices)
    .where(eq(notenbuchOfflineDevices.userId, userId))
    .returning({ id: notenbuchOfflineDevices.deviceId });
  for (const r of offline) await audit(db, userId, "notenbuch.offline.aus", r.id, { grund: "ueberall-abmelden" });
  const ended = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), keep ? ne(sessions.id, keep) : undefined))
    .returning({ id: sessions.id });
  endLiveStreams(userId);
  await audit(db, userId, "konto.sitzung.ueberall_abgemeldet", userId, { sitzungen: ended.length, offline: offline.length });
  return { sessions: ended.length, offline: offline.length };
}
