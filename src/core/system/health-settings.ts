// BM-02: Einstellungen und Zugang für /api/health/details (docs/BETRIEBSMONITORING.md). Betriebsart, Schwellen und das Token
// für Monitore im Schulnetz; das Token liegt im Konfigurationsordner (Volume `config`), nicht in der Datenbank.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import { configDir } from "@/core/backup/pairing";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { BACKUP_HOURS_MAX, BACKUP_HOURS_MIN, HEALTH_MODES, HEALTH_SETTINGS_KEY, MAIL_BACKLOG_MAX, MAIL_BACKLOG_MIN, parseHealthSettings, type HealthMode, type HealthSettings } from "./health-config";

export * from "./health-config";

export const HEALTH_TOKEN_FILE = "health-token";

export async function readHealthSettings(db: Db): Promise<HealthSettings> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, HEALTH_SETTINGS_KEY));
  return parseHealthSettings(row?.value);
}

export class HealthSettingsError extends Error {}

/** Prüfen und speichern; Rechteprüfung macht der Aufrufer, die Änderung kommt ins Protokoll. Beim Wechsel auf „Token“ entsteht ggf. eines. */
export async function saveHealthSettings(
  db: Db,
  actorId: string,
  input: { mode: string; mailBacklogMinutes: string; backupMaxHours: string },
  dir = configDir(),
  now = new Date(),
): Promise<HealthSettings> {
  if (!HEALTH_MODES.includes(input.mode as HealthMode)) throw new HealthSettingsError("Betriebsart: aus, Schulnetz oder Token");
  const mail = Number(input.mailBacklogMinutes);
  if (!Number.isInteger(mail) || mail < MAIL_BACKLOG_MIN || mail > MAIL_BACKLOG_MAX)
    throw new HealthSettingsError(`Mail-Stau: ganze Minuten von ${MAIL_BACKLOG_MIN} bis ${MAIL_BACKLOG_MAX}`);
  const hours = Number(input.backupMaxHours);
  if (!Number.isInteger(hours) || hours < BACKUP_HOURS_MIN || hours > BACKUP_HOURS_MAX)
    throw new HealthSettingsError(`Alter der Sicherung: ganze Stunden von ${BACKUP_HOURS_MIN} bis ${BACKUP_HOURS_MAX}`);
  const value: HealthSettings = { mode: input.mode as HealthMode, mailBacklogMinutes: mail, backupMaxHours: hours };
  const before = await readHealthSettings(db);
  await db
    .insert(appSettings)
    .values({ key: HEALTH_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  if (value.mode === "token" && !readHealthToken(dir)) writeHealthToken(dir);
  await audit(db, actorId, "system.health.einstellungen", null, { vorher: before.mode, nachher: value.mode, mailStau: mail, sicherungStunden: hours });
  return value;
}

// ---------------------------------------------------------------- Token

export function readHealthToken(dir = configDir()): string | null {
  const file = path.join(dir, HEALTH_TOKEN_FILE);
  if (!existsSync(file)) return null;
  const t = readFileSync(file, "utf8").trim();
  return /^[A-Za-z0-9_-]{32,}$/.test(t) ? t : null;
}

function writeHealthToken(dir: string): string {
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, HEALTH_TOKEN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows (nur Entwicklung)
  }
  return token;
}

/** Neues Token erzeugen (das alte gilt sofort nicht mehr); Rechteprüfung macht der Aufrufer. Gibt das Token einmal zurück. */
export async function rotateHealthToken(db: Db, actorId: string, dir = configDir()): Promise<string> {
  const token = writeHealthToken(dir);
  await audit(db, actorId, "system.health.token_erneuert", null, {});
  return token;
}

/** `Authorization: Bearer <token>` gegen das gespeicherte Token – zeitkonstant; ohne gespeichertes Token nie. */
export function tokenMatches(authorization: string | null, stored: string | null): boolean {
  if (!stored || !authorization) return false;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Darf diese Anfrage die Details lesen? `zone` = Schulnetz/außen laut `requestNetwork`. */
export function healthAccess(input: { mode: HealthMode; zone: "schulnetz" | "aussen"; authorization: string | null; token: string | null }): boolean {
  if (input.mode === "aus") return false;
  if (input.mode === "token") return tokenMatches(input.authorization, input.token);
  return input.zone === "schulnetz";
}
