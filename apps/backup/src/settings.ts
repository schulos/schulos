// Betriebsangaben des Backupservers aus der Umgebung bzw. backup.env (INSTALLATION.md §8.1).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type Env = Record<string, string | undefined>;

/** Ordner des rest-servers (Repositories + .htpasswd); beide Container teilen ihn. */
export function restDir(env: Env = process.env): string {
  return env.SCHULOS_REST_DIR ?? path.join(process.cwd(), ".data", "rest");
}

/** Öffentliche Adresse des rest-servers (Caddy leitet /restic/ weiter); ohne Angabe <BETTER_AUTH_URL>/restic. */
export function restBaseUrl(env: Env = process.env): string {
  const base = env.SCHULOS_REST_URL ?? `${env.BETTER_AUTH_URL ?? "http://localhost:3100"}/restic`;
  return base.replace(/\/+$/, "");
}

/**
 * CA, die das Hauptsystem pinnt (Caddy `tls internal`: root.crt aus Caddys Datenordner). Ohne Angabe oder ohne Datei – Caddy mit
 * Let's Encrypt legt keine eigene CA an – gilt das öffentliche Zertifikat.
 */
export function tlsCaPem(env: Env = process.env): string | null {
  const file = env.SCHULOS_TLS_CA_FILE;
  if (!file || !existsSync(file)) return null;
  const pem = readFileSync(file, "utf8");
  if (!pem.includes("BEGIN CERTIFICATE")) throw new Error(`SCHULOS_TLS_CA_FILE (${file}) enthält kein Zertifikat`);
  return pem;
}

export function serverName(env: Env = process.env): string {
  return env.SCHULOS_BACKUP_NAME?.trim() || "SchulOS Backup";
}
