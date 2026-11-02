// CA-03 (docs/ZERTIFIKATE.md): Root der eigenen CA in der App. schulosctl legt sie bei TLS-Modus `internal` als `root-ca.crt` in den
// Konfigurationsordner (CA-02) und entfernt sie sonst – ohne Datei gibt es keinen Download (404). Die App liest nur diese Datei;
// `caddy_data` (mit dem Schlüssel) sieht sie nie.
//
// Wechsel der Root (ca-6): Der zuletzt bestätigte Fingerabdruck steht in `app_settings`. Beim ersten Sehen gilt die Root als
// bestätigt (frische Installation – nichts zu verteilen). Weicht sie ab (Neuinstallation, Wiederherstellung ohne CA-Sicherung), meldet
// collectAlarms „Schul-Zertifikat gewechselt“, bis ein Admin den neuen Fingerabdruck in Verwaltung → System bestätigt.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { parseRootCa } from "@schulos/server/root-ca";
import { ROOT_CA_FILE, type RootCaInfo } from "@schulos/server/system";
import { audit } from "@/core/audit";
import { configDir } from "@/core/backup/pairing";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";

export const ROOT_CA_CONFIRMED_KEY = "zertifikat.root";

/** Root aus dem Konfigurationsordner (null = keine eigene CA bzw. noch nicht vom Server abgelegt) */
export function readRootCa(dir = configDir()): { pem: string; info: RootCaInfo } | null {
  const file = path.join(dir, ROOT_CA_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseRootCa(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export interface RootCaConfirmation {
  fingerprint: string;
  at: string;
  /** null = beim ersten Sehen automatisch übernommen */
  by: string | null;
}

export interface RootCaState {
  current: RootCaInfo | null;
  confirmed: RootCaConfirmation | null;
  /** true = aktuelle Root weicht vom bestätigten Fingerabdruck ab */
  changed: boolean;
}

async function readConfirmation(db: Db): Promise<RootCaConfirmation | null> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, ROOT_CA_CONFIRMED_KEY));
  const v = row?.value as Partial<RootCaConfirmation> | undefined;
  return v && typeof v.fingerprint === "string" ? { fingerprint: v.fingerprint, at: String(v.at ?? ""), by: typeof v.by === "string" ? v.by : null } : null;
}

async function writeConfirmation(db: Db, value: RootCaConfirmation, now: Date) {
  await db
    .insert(appSettings)
    .values({ key: ROOT_CA_CONFIRMED_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
}

/** Stand der Root; die erste gesehene Root wird ohne Alarm als bestätigt übernommen. */
export async function rootCaState(db: Db, current: RootCaInfo | null = readRootCa()?.info ?? null, now = new Date()): Promise<RootCaState> {
  let confirmed = await readConfirmation(db);
  if (current && !confirmed) {
    confirmed = { fingerprint: current.fingerprint, at: now.toISOString(), by: null };
    await writeConfirmation(db, confirmed, now);
  }
  return { current, confirmed, changed: Boolean(current && confirmed && current.fingerprint !== confirmed.fingerprint) };
}

export class RootCaError extends Error {}

/** Admin bestätigt die neue Root (nur genau die gerade abgelegte) – kommt ins Protokoll; der Alarm endet beim nächsten Durchgang. */
export async function confirmRootCa(db: Db, actorId: string, fingerprint: string, current: RootCaInfo | null = readRootCa()?.info ?? null, now = new Date()) {
  if (!current || current.fingerprint !== fingerprint) throw new RootCaError("Das Schul-Zertifikat hat sich inzwischen geändert – Seite neu laden");
  const before = await readConfirmation(db);
  await writeConfirmation(db, { fingerprint, at: now.toISOString(), by: actorId }, now);
  await audit(db, actorId, "verwaltung.system.zertifikat_bestaetigt", null, { fingerabdruck: fingerprint, vorher: before?.fingerprint ?? null });
}
