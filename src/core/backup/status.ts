// Sicherungsstand des Hauptsystems aus dem Zustand des Backup-Agenten (backup-agent-state.json im Konfigurationsordner)
// und „Jetzt sichern“ über den Backupserver (der Agent holt die Anforderung mit dem nächsten Plan ab).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  backupHealth,
  normalizeRestoreCode,
  RESTORE_APPROVAL_FILE,
  restoreApproval,
  restoreRequestProblem,
  sanitizeImmutable,
  type AgentState,
  type ImmutableCopy,
  type BackupHealth,
} from "@schulos/server/agent-api";
import { pairingTrust, type StoredPairing } from "@schulos/server/pairing-client";
import { RequestError, requestJson } from "@schulos/server/pinned-request";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { configDir, readPairing } from "./pairing";

export const AGENT_STATE_FILE = "backup-agent-state.json";

export interface BackupStatus {
  paired: boolean;
  health: BackupHealth;
  lastOkAt: Date | null;
  lastRun: AgentState["lastRun"];
  /** der Agent erreicht den Backupserver nicht (Text des letzten Fehlers) */
  contactError: string | null;
  /** letzter Kontakt des Agenten – fehlt er, läuft der Agent vermutlich nicht */
  lastContactAt: Date | null;
  runningSince: Date | null;
  /** offener Wiederherstellungsauftrag (aus dem letzten Plan des Agenten) */
  restoreRequest: NonNullable<AgentState["restoreRequest"]> | null;
  lastRestore: NonNullable<AgentState["lastRestore"]> | null;
  /** SEC-11: letzte unveränderliche Kopie laut Backupserver (null = nicht eingerichtet bzw. unbekannt) */
  immutable?: ImmutableCopy | null;
}

export function readAgentState(dir: string, instanceId: string): AgentState | null {
  const file = path.join(dir, AGENT_STATE_FILE);
  if (!existsSync(file)) return null;
  const s = JSON.parse(readFileSync(file, "utf8")) as AgentState;
  return s.version === 1 && s.instanceId === instanceId ? s : null;
}

export function backupStatus(dir = configDir(), now = new Date()): BackupStatus {
  const p = readPairing(dir);
  const s = p ? readAgentState(dir, p.instanceId) : null;
  const lastOkAt = s?.lastOkAt ? new Date(s.lastOkAt) : null;
  return {
    paired: Boolean(p),
    health: backupHealth(lastOkAt, s?.lastRun ?? null, now),
    lastOkAt,
    lastRun: s?.lastRun ?? null,
    contactError: s?.lastContactError ?? null,
    lastContactAt: s?.lastContactAt ? new Date(s.lastContactAt) : null,
    runningSince: s?.runningSince ? new Date(s.runningSince) : null,
    restoreRequest: s?.restoreRequest ?? null,
    lastRestore: s?.lastRestore ?? null,
    immutable: sanitizeImmutable(s?.immutable ?? null),
  };
}

/** Warnung für die Verwaltung: ungekoppelt, fehlgeschlagen oder überfällig. */
export function needsAttention(s: BackupStatus): boolean {
  return !s.paired || s.health === "failed" || s.health === "overdue";
}

export class BackupRequestError extends Error {}

/** „Jetzt sichern“: Anforderung beim Backupserver ablegen (mit dem Agent-Token, TLS gepinnt). */
export async function requestBackupNow(db: Db, actorId: string, p: StoredPairing | null = readPairing(), request = requestJson): Promise<void> {
  if (!p) throw new BackupRequestError("Kein Backupserver gekoppelt.");
  try {
    const res = await request(`${p.backupUrl}/api/agent/run`, {
      method: "POST",
      body: {},
      trust: pairingTrust(p),
      headers: { authorization: `Bearer ${p.agentToken}` },
    });
    if (res.status === 401) throw new BackupRequestError("Der Backupserver kennt dieses Hauptsystem nicht mehr (entkoppelt?).");
    if (res.status !== 200) throw new BackupRequestError(`Der Backupserver hat die Anforderung abgelehnt (${res.status}).`);
  } catch (err) {
    if (err instanceof RequestError) throw new BackupRequestError(`Der Backupserver ist nicht erreichbar (${err.message}).`);
    throw err;
  }
  await audit(db, actorId, "verwaltung.backup.angefordert", p.instanceId);
}

async function callBackup<T>(p: StoredPairing, body: unknown, request = requestJson): Promise<{ status: number; body: T | null }> {
  try {
    return await request<T>(`${p.backupUrl}/api/agent/restore`, { method: "POST", body, trust: pairingTrust(p), headers: { authorization: `Bearer ${p.agentToken}` } });
  } catch (err) {
    if (err instanceof RequestError) throw new BackupRequestError(`Der Backupserver ist nicht erreichbar (${err.message}).`);
    throw err;
  }
}

/**
 * Wiederherstellung bestätigen: der Code steht auf dem Backupserver beim Auftrag. Erst danach führt der Agent sie aus.
 * Ergebnis „falsch“ bzw. „verworfen“ (nach 5 falschen Codes).
 * SEC-06: Zusätzlich legt die App eine lokale Freigabe (restore-approval.json, 30 min) für genau diesen Auftrag, Stand und
 * Umfang ab – der Agent führt nur damit aus. So reicht ein übernommener Backupserver allein nicht. Die Freigabe entsteht vor
 * dem Senden (der Agent könnte „bestätigt“ sonst vor ihr sehen) und wird gelöscht, wenn der Code nicht stimmt.
 */
export async function confirmRestoreOnServer(
  db: Db,
  actorId: string,
  restoreId: string,
  code: string,
  p: StoredPairing | null = readPairing(),
  request = requestJson,
  dir = configDir(),
  now = new Date(),
): Promise<"bestaetigt" | "falsch" | "verworfen"> {
  if (!p) throw new BackupRequestError("Kein Backupserver gekoppelt.");
  if (!normalizeRestoreCode(code)) return "falsch";
  const req = readAgentState(dir, p.instanceId)?.restoreRequest ?? null;
  if (!req || req.id !== restoreId || req.status !== "wartet" || restoreRequestProblem(req))
    throw new BackupRequestError("Dieser Auftrag liegt dem Backup-Agenten nicht (mehr) vor – Seite neu laden.");
  const approvalFile = path.join(dir, RESTORE_APPROVAL_FILE);
  const tmp = `${approvalFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(restoreApproval(req, now), null, 2), { mode: 0o600 });
  renameSync(tmp, approvalFile);
  let confirmed = false;
  try {
    const res = await callBackup<{ ergebnis?: "bestaetigt" | "falsch" | "verworfen"; error?: string }>(p, { aktion: "bestaetigen", id: restoreId, code }, request);
    if (res.status !== 200 || !res.body?.ergebnis) throw new BackupRequestError(res.body?.error ?? `Der Backupserver hat abgelehnt (${res.status}).`);
    confirmed = res.body.ergebnis === "bestaetigt";
    await audit(db, actorId, confirmed ? "verwaltung.backup.wiederherstellung_bestaetigt" : "verwaltung.backup.wiederherstellung_code_falsch", p.instanceId, { auftrag: restoreId });
    return res.body.ergebnis;
  } finally {
    if (!confirmed) rmSync(approvalFile, { force: true });
  }
}

export async function rejectRestoreOnServer(db: Db, actorId: string, restoreId: string, p: StoredPairing | null = readPairing(), request = requestJson): Promise<void> {
  if (!p) throw new BackupRequestError("Kein Backupserver gekoppelt.");
  const res = await callBackup<{ error?: string }>(p, { aktion: "ablehnen", id: restoreId }, request);
  if (res.status !== 200) throw new BackupRequestError(res.body?.error ?? `Der Backupserver hat abgelehnt (${res.status}).`);
  rmSync(path.join(configDir(), RESTORE_APPROVAL_FILE), { force: true });
  await audit(db, actorId, "verwaltung.backup.wiederherstellung_abgelehnt", p.instanceId, { auftrag: restoreId });
}
