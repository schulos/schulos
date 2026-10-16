// Kopplung des Hauptsystems mit dem Backupserver (INSTALLATION.md §4.3). Die Zugangsdaten liegen als Datei im
// Konfigurationsordner (nur für den App-Benutzer lesbar) – dort liest sie auch der Backup-Agent (B-24), der kein Datenbankzugriff hat.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { certFingerprint } from "@schulos/server/pairing";
import { pairWithBackup, PairingError, type PairInput, type RequestFn, type StoredPairing } from "@schulos/server/pairing-client";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";

export { PairingError };

export const PAIRING_FILE = "backup-pairing.json";

export type Env = Record<string, string | undefined>;

import { configDirOf as configDir } from "./maintenance";

export { configDir };

export function readPairing(dir = configDir()): StoredPairing | null {
  const file = path.join(dir, PAIRING_FILE);
  if (!existsSync(file)) return null;
  const p = JSON.parse(readFileSync(file, "utf8")) as StoredPairing;
  return p.version === 1 ? p : null;
}

function writePairing(dir: string, p: StoredPairing) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PAIRING_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows/Dateisysteme ohne Unix-Rechte
  }
  renameSync(tmp, file);
}

/** Was die Oberfläche zeigen darf – ohne Zugangsdaten und Repository-Passwort. */
export interface PairingView {
  backupUrl: string;
  serverName: string;
  instanceName: string;
  pairedAt: string;
  caFingerprint: string | null;
  /** gekoppelt über http (nur Entwicklung/Tests, SCHULOS_BACKUP_ALLOW_HTTP) */
  insecure: boolean;
  /** solange nicht als verwahrt bestätigt: der Wiederherstellungsschlüssel zum Ausdrucken */
  recoveryKeyToConfirm: string | null;
}

export function pairingView(p: StoredPairing | null): PairingView | null {
  if (!p) return null;
  return {
    backupUrl: p.backupUrl,
    serverName: p.serverName,
    instanceName: p.instanceName,
    pairedAt: p.pairedAt,
    caFingerprint: p.caPem ? certFingerprint(p.caPem) : null,
    insecure: p.backupUrl.startsWith("http:"),
    recoveryKeyToConfirm: p.recoveryConfirmedAt ? null : p.recoveryKey,
  };
}

export async function pairNow(
  db: Db,
  actorId: string,
  input: PairInput,
  opts: { dir?: string; allowHttp?: boolean; request?: RequestFn } = {},
): Promise<StoredPairing> {
  const dir = opts.dir ?? configDir();
  if (readPairing(dir)) throw new PairingError("Dieses Hauptsystem ist schon gekoppelt. Erst entkoppeln.");
  let p: StoredPairing;
  try {
    p = await pairWithBackup(input, { allowHttp: opts.allowHttp, request: opts.request });
  } catch (err) {
    if (err instanceof PairingError) await audit(db, actorId, "verwaltung.backup.kopplung_fehlgeschlagen", null, { adresse: input.backupUrl, grund: err.message });
    throw err;
  }
  writePairing(dir, p);
  await audit(db, actorId, "verwaltung.backup.gekoppelt", p.instanceId, { adresse: p.backupUrl, ca: p.caPem ? certFingerprint(p.caPem) : null });
  return p;
}

/** „Ausgedruckt und sicher verwahrt“ – danach zeigt SchulOS den Schlüssel nie wieder an. */
export async function confirmRecoveryKey(db: Db, actorId: string, dir = configDir(), now = new Date()): Promise<void> {
  const p = readPairing(dir);
  if (!p || p.recoveryConfirmedAt) return;
  writePairing(dir, { ...p, recoveryConfirmedAt: now.toISOString() });
  await audit(db, actorId, "verwaltung.backup.wiederherstellungsschluessel", p.instanceId);
}

/** Nur lokal: Zugangsdaten löschen. Auf dem Backupserver muss die Instanz zusätzlich entkoppelt werden. */
export async function unpairLocal(db: Db, actorId: string, dir = configDir()): Promise<void> {
  const p = readPairing(dir);
  if (!p) return;
  rmSync(path.join(dir, PAIRING_FILE), { force: true });
  await audit(db, actorId, "verwaltung.backup.entkoppelt", p.instanceId, { adresse: p.backupUrl });
}
