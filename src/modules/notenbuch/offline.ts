// Notenbuch (P5-20): Offline-Eingabe auf Dienstgeräten – Serverseite.
//   · **Wo erlaubt** (`decideOffline`, rein): nach Moduleinstellung `notenbuch.offline` (settings.ts), Zone der Anfrage
//     (Kennzeichen von Caddy, src/core/external-access.ts) und Prüfung des Gerätezertifikats (src/core/device-certs). Ein gültiges,
//     freigegebenes Gerätezertifikat zählt immer; „Schulnetz“ nur, wenn die Schule es eingestellt hat. Von außen ohne Zertifikat
//     (Privatgerät) nie – dort gibt es keinen Cache (§ 2 Abs. 2 VO-DV I).
//   · **Schlüsselanteil je Person + Gerät** (`notenbuch_offline_devices`, GATE-5a): Einschalten legt die Zeile an, Abrufen
//     bindet sie an die aktuelle Sitzung. Echtes Abmelden löscht sie (`endOfflineForSession`, logoutAction), die Neuanmeldung
//     aus der 15-Minuten-Sperre nicht (Sitzung weg → `session_id` leer, neu gebunden). Frist OFFLINE_MAX_DAYS, nächtlicher Lauf
//     räumt ab (`purgeExpiredOfflineDevices`); nicht mehr berechtigt oder Frist abgelaufen → der Anteil wird nur noch zum
//     Übertragen offener Änderungen geliefert (Frist = jetzt), danach ist der Cache unlesbar. Ohne `notenbuch.own` oder
//     Zwei-Faktor: Zeile weg (`null`); Geräte anderer Personen bleiben unberührt (`null`).
//   · **Abgleich** (`syncOfflineOps`): je Änderung Revision der Zelle prüfen (offline-sync.ts), anwenden über `setEntry` (dieselben
//     Prüfungen und Spuren wie online: Rechte, Sperre, Vorjahr, Lerngruppe, Wert, `updated_by/at`), Konflikte unverändert
//     zurück, gesperrte Bücher lehnen ab; ein Audit-Eintrag je Abgleich mit Zahlen (kein Inhalt).
import { and, eq, lte } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { notenbuchColumns, notenbuchEntries, notenbuchOfflineDevices, users } from "@/core/db/schema";
import { certCheck } from "@/core/device-certs/service";
import { deviceFingerprint, externalZone } from "@/core/external-access";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { newShare } from "./offline-crypto";
import { decideOffline, OFFLINE_REASON_TEXT, type OfflineDecision, type OfflineReason } from "./offline-reasons";
import { applySyncResults, classifyOp, OFFLINE_MAX_DAYS, OFFLINE_OPS_MAX, offlineExpired, type OfflineOp, type SyncResult } from "./offline-sync";
import { EntryConflictError, hasNotenbuchRight, isPastYear, OWN, ownBook, PAST_YEAR_MESSAGE, setEntry, twoFactorReady } from "./service";
import { OFFLINE, type OfflineMode } from "./settings";

export { decideOffline, OFFLINE_REASON_TEXT, type OfflineDecision, type OfflineReason } from "./offline-reasons";

/** Entscheidung für die Anfrage: Einstellung, Zone und Zertifikat (frisch aus der DB). */
export async function offlineDecision(db: Db, perms: PermissionSet, headers: Headers, now = new Date()): Promise<OfflineDecision> {
  const mode = (await readModuleSetting(db, OFFLINE)) as OfflineMode;
  const zone = externalZone(headers);
  const cert = zone === "intern" ? "fehlt" : await certCheck(db, deviceFingerprint(headers), perms.userId, now);
  return decideOffline(mode, zone, cert);
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function assertOfflineUser(db: Db, perms: PermissionSet): Promise<void> {
  if (!hasNotenbuchRight(perms, OWN) || !(await twoFactorReady(db, perms))) throw new ForbiddenError(OWN);
}

/**
 * Offline-Eingabe auf diesem Gerät einschalten: nur, wo es erlaubt ist, nur mit `notenbuch.own` und Zwei-Faktor. Legt den
 * Server-Anteil an (ersetzt eine alte Zeile derselben Person für dieselbe Gerätekennung) und liefert ihn einmalig.
 */
export async function activateOfflineDevice(
  db: Db,
  perms: PermissionSet,
  headers: Headers,
  input: { deviceId: string; sessionId: string; confirmed: boolean },
  now = new Date(),
): Promise<{ share: string; expiresAt: Date; reason: OfflineReason }> {
  await assertOfflineUser(db, perms);
  if (!DEVICE_ID.test(input.deviceId)) throw new ValidationError({ deviceId: "Gerätekennung ungültig" });
  const decision = await offlineDecision(db, perms, headers, now);
  if (!decision.allowed) throw new ValidationError({ offline: OFFLINE_REASON_TEXT[decision.reason] });
  if (decision.reason === "schulnetz" && !input.confirmed)
    throw new ValidationError({ confirmed: "Bitte bestätige, dass dies ein Dienstgerät der Schule ist" });
  const share = newShare();
  const expiresAt = new Date(now.getTime() + OFFLINE_MAX_DAYS * 86_400_000);
  // G5A-S05: eine Gerätekennung einer anderen Person wird nie ersetzt (deren Anteil bliebe sonst weg)
  const [taken] = await db.select({ userId: notenbuchOfflineDevices.userId }).from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, input.deviceId));
  if (taken && taken.userId !== perms.userId) throw new ValidationError({ deviceId: "Gerätekennung ungültig" });
  await db.delete(notenbuchOfflineDevices).where(and(eq(notenbuchOfflineDevices.deviceId, input.deviceId), eq(notenbuchOfflineDevices.userId, perms.userId)));
  await db.insert(notenbuchOfflineDevices).values({
    deviceId: input.deviceId,
    userId: perms.userId,
    sessionId: input.sessionId,
    serverShare: share,
    reason: decision.reason,
    createdAt: now,
    expiresAt,
  });
  await audit(db, perms.userId, "notenbuch.offline.ein", input.deviceId, { grund: decision.reason, bis: expiresAt.toISOString() });
  return { share, expiresAt, reason: decision.reason };
}

export interface OfflineShare {
  share: string;
  expiresAt: Date;
  /** Gerät darf den Cache weiterführen; sonst nur noch offene Änderungen übertragen, dann löschen */
  keep: boolean;
  reason: OfflineReason;
}

/**
 * G5A-C05: Darf ein **schon eingeschaltetes** Gerät den Zwischenspeicher weiterführen? Wie beim Einschalten – mit einer
 * Ausnahme: ein mit Gerätezertifikat eingeschaltetes Gerät bleibt im Schulnetz eingeschaltet (dort sieht Caddy keine
 * Client-Zertifikate, „kein-zertifikat“ heißt nur „nicht erkennbar“). Entzug nur durch Einstellung aus, Privatgerät (von außen
 * ohne Zertifikat) oder – für „Schulnetz“-Geräte – wenn die Schule „Schulnetz“ nicht mehr erlaubt.
 */
export function offlineStillAllowed(activatedFor: string, decision: OfflineDecision): boolean {
  return decision.allowed || (activatedFor === "zertifikat" && decision.reason === "kein-zertifikat");
}

/**
 * Server-Anteil für ein eingeschaltetes Gerät abrufen (bei jedem Öffnen der Notentabelle). Bindet die Zeile an die aktuelle
 * Sitzung (auch nach der Neuanmeldung aus der 15-Minuten-Sperre, G5A-C01). Nicht mehr berechtigt oder Frist abgelaufen →
 * `keep: false`: der Anteil wird weiter geliefert, **nur zum Übertragen** offener Änderungen aller Bücher, bis der Browser das
 * Gerät danach ausschaltet oder spätestens der nächtliche Lauf die Zeile löscht (Frist auf „jetzt“ gesetzt, G5A-C04/S06).
 * Gerät einer anderen Person → `null`, die Zeile bleibt (G5A-S05: geteiltes Dienstgerät). Eigenes Recht oder Zwei-Faktor weg →
 * Zeile weg, `null`.
 */
export async function offlineShare(
  db: Db,
  perms: PermissionSet,
  headers: Headers,
  input: { deviceId: string; sessionId: string },
  now = new Date(),
): Promise<OfflineShare | null> {
  if (!DEVICE_ID.test(input.deviceId)) return null;
  const [row] = await db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, input.deviceId));
  if (!row || row.userId !== perms.userId) return null;
  if (!hasNotenbuchRight(perms, OWN) || !(await twoFactorReady(db, perms))) {
    await db.delete(notenbuchOfflineDevices).where(and(eq(notenbuchOfflineDevices.deviceId, input.deviceId), eq(notenbuchOfflineDevices.userId, perms.userId)));
    await audit(db, perms.userId, "notenbuch.offline.aus", input.deviceId, { grund: "recht" });
    return null;
  }
  const decision = await offlineDecision(db, perms, headers, now);
  const still = offlineStillAllowed(row.reason, decision);
  const keep = still && !offlineExpired(row.expiresAt, now);
  const own = and(eq(notenbuchOfflineDevices.deviceId, input.deviceId), eq(notenbuchOfflineDevices.userId, perms.userId));
  if (keep) {
    await db.update(notenbuchOfflineDevices).set({ sessionId: input.sessionId }).where(own);
  } else {
    // nur noch Übertragen: Frist auf jetzt, der nächtliche Lauf räumt ab (falls der Browser nicht vorher ausschaltet)
    const first = !offlineExpired(row.expiresAt, now);
    await db.update(notenbuchOfflineDevices).set({ sessionId: input.sessionId, expiresAt: first ? now : row.expiresAt }).where(own);
    if (first) await audit(db, perms.userId, "notenbuch.offline.aus", input.deviceId, { grund: still ? "frist" : decision.reason });
  }
  return { share: row.serverShare, expiresAt: keep ? row.expiresAt : now < row.expiresAt ? now : row.expiresAt, keep, reason: decision.reason };
}

/**
 * G5A-C01: echtes Abmelden (nicht die Neuanmeldung aus der 15-Minuten-Sperre) beendet die Offline-Eingabe des Geräts, das an
 * dieser Sitzung hängt – sein Zwischenspeicher wird unlesbar (die Seite warnt vorher, wenn noch etwas offen ist).
 */
export async function endOfflineForSession(db: Db, userId: string, sessionId: string): Promise<number> {
  const rows = await db
    .delete(notenbuchOfflineDevices)
    .where(and(eq(notenbuchOfflineDevices.userId, userId), eq(notenbuchOfflineDevices.sessionId, sessionId)))
    .returning({ id: notenbuchOfflineDevices.deviceId });
  for (const r of rows) await audit(db, userId, "notenbuch.offline.aus", r.id, { grund: "abmelden" });
  return rows.length;
}

/** Offline-Eingabe auf dem Gerät ausschalten (die Person selbst) – Zeile weg, Cache unlesbar. */
export async function deactivateOfflineDevice(db: Db, perms: PermissionSet, deviceId: string): Promise<void> {
  if (!DEVICE_ID.test(deviceId)) return;
  const done = await db
    .delete(notenbuchOfflineDevices)
    .where(and(eq(notenbuchOfflineDevices.deviceId, deviceId), eq(notenbuchOfflineDevices.userId, perms.userId)))
    .returning({ id: notenbuchOfflineDevices.deviceId });
  if (done.length) await audit(db, perms.userId, "notenbuch.offline.aus", deviceId, { grund: "selbst" });
}

/** Abgelaufene Zeilen entfernen (nächtlicher Lauf „notenbuch-offline-frist“, G5A-S06) – liefert die Anzahl. */
export async function purgeExpiredOfflineDevices(db: Db, now = new Date()): Promise<number> {
  const rows = await db.delete(notenbuchOfflineDevices).where(lte(notenbuchOfflineDevices.expiresAt, now)).returning({ id: notenbuchOfflineDevices.deviceId });
  return rows.length;
}

/** Eine Änderung aus dem Client in Form bringen – Typen erzwingen, Inhalt prüft `setEntry`. */
export function parseOp(raw: unknown): OfflineOp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const opId = String(o.opId ?? "");
  if (!/^[0-9a-f-]{36}$/.test(opId)) return null;
  const baseVersion = Number(o.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return null;
  return {
    opId,
    columnId: String(o.columnId ?? ""),
    studentId: String(o.studentId ?? ""),
    value: String(o.value ?? "").slice(0, 20),
    comment: o.comment == null ? null : String(o.comment).slice(0, 400),
    baseVersion,
    at: String(o.at ?? ""),
  };
}

/**
 * Offline-Änderungen eines Buchs abgleichen. Idempotent: Änderungen, die der Server schon trägt, gelten als angewendet.
 * Konflikte überschreiben nichts. Prüfungen und Spuren je Zelle wie bei der Online-Eingabe (`setEntry`).
 */
export async function syncOfflineOps(
  db: Db,
  perms: PermissionSet,
  bookId: string,
  ops: readonly OfflineOp[],
  deviceId: string | null,
  now = new Date(),
): Promise<SyncResult[]> {
  await assertOfflineUser(db, perms);
  // erst die Zugehörigkeit zum Buch – fremde oder unbekannte Bücher wie gewohnt ForbiddenError, bevor irgendeine Zelle gelesen wird
  const book = await ownBook(db, perms, bookId);
  if (!book) throw new ForbiddenError(OWN);
  if (ops.length > OFFLINE_OPS_MAX) throw new ValidationError({ ops: `Höchstens ${OFFLINE_OPS_MAX} Änderungen je Abgleich` });
  // abgeschlossene Bücher und vergangene Schuljahre lehnen jede Änderung ab – vor der Revisionsprüfung (sonst hieße es „Konflikt“)
  const closed = book.lockedAt ? "Das Notenbuch ist abgeschlossen und gesperrt" : (await isPastYear(db, book.schoolYearId)) ? PAST_YEAR_MESSAGE : null;
  const columns = await db
    .select({ id: notenbuchColumns.id, bookId: notenbuchColumns.bookId })
    .from(notenbuchColumns)
    .where(eq(notenbuchColumns.bookId, bookId));
  const columnIds = new Set(columns.map((c) => c.id));
  const results: SyncResult[] = [];
  for (const op of ops) {
    if (closed) {
      results.push({ opId: op.opId, status: "rejected", reason: closed });
      continue;
    }
    if (!columnIds.has(op.columnId)) {
      results.push({ opId: op.opId, status: "rejected", reason: "Die Spalte gibt es nicht mehr" });
      continue;
    }
    const [current] = await db
      .select({ value: notenbuchEntries.value, comment: notenbuchEntries.comment, version: notenbuchEntries.version, updatedBy: notenbuchEntries.updatedBy })
      .from(notenbuchEntries)
      .where(and(eq(notenbuchEntries.columnId, op.columnId), eq(notenbuchEntries.studentId, op.studentId)));
    const cell = current ? { value: current.value, comment: current.comment, version: current.version } : null;
    const outcome = classifyOp(cell, op);
    if (outcome === "applied") {
      results.push({ opId: op.opId, status: "applied", version: cell?.version ?? 0 });
      continue;
    }
    if (outcome === "conflict") {
      let label: string | null = null;
      if (current?.updatedBy && current.updatedBy !== perms.userId) {
        const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, current.updatedBy));
        label = u?.name ?? null;
      }
      results.push({ opId: op.opId, status: "conflict", server: cell, serverLabel: label });
      continue;
    }
    try {
      const version = await setEntry(
        db,
        perms,
        { columnId: op.columnId, studentId: op.studentId, value: op.value, comment: op.comment, expectedVersion: op.baseVersion },
        now,
      );
      results.push({ opId: op.opId, status: "applied", version });
    } catch (err) {
      if (err instanceof EntryConflictError) {
        results.push({ opId: op.opId, status: "conflict", server: cell, serverLabel: null });
      } else if (err instanceof ValidationError) {
        results.push({ opId: op.opId, status: "rejected", reason: Object.values(err.fieldErrors)[0] ?? "abgelehnt" });
      } else if (err instanceof ForbiddenError) {
        results.push({ opId: op.opId, status: "rejected", reason: "Kein Zugriff auf dieses Notenbuch" });
      } else throw err;
    }
  }
  const outcome = applySyncResults(ops, results);
  if (deviceId && DEVICE_ID.test(deviceId)) {
    await db
      .update(notenbuchOfflineDevices)
      .set({ lastSyncAt: now })
      .where(and(eq(notenbuchOfflineDevices.deviceId, deviceId), eq(notenbuchOfflineDevices.userId, perms.userId)));
  }
  if (ops.length) {
    await audit(db, perms.userId, "notenbuch.offline.abgleich", bookId, {
      geraet: deviceId,
      angewendet: outcome.applied.size,
      konflikte: outcome.conflicts.length,
      abgelehnt: outcome.rejected.length,
    });
  }
  return results;
}
