// Admin-Konto beim Erststart aus der Konfiguration (INSTALLATION.md §3.2/§3.3, §8.1) – gleiche Variablen für
// Hauptsystem (schulos.env) und Backupserver (backup.env). Das Klartext-Passwort wird danach aus der Datei entfernt.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkPassword } from "./passwort";

export type Env = Record<string, string | undefined>;

export interface AdminConfig {
  username: string;
  firstName: string;
  lastName: string;
  password: { plain: string } | { hash: string };
}

/** SCHULOS_ADMIN_* lesen und prüfen (Passwort im Klartext oder als scrypt-Hash von Better-Auth). */
export function parseAdminConfig(env: Env): { ok: true; admin: AdminConfig } | { ok: false; errors: string[] } {
  const username = env.SCHULOS_ADMIN_USERNAME?.trim().toLowerCase() ?? "";
  const firstName = env.SCHULOS_ADMIN_FIRST_NAME?.trim() ?? "";
  const lastName = env.SCHULOS_ADMIN_LAST_NAME?.trim() ?? "";
  const plain = env.SCHULOS_ADMIN_PASSWORD;
  const hash = env.SCHULOS_ADMIN_PASSWORD_HASH?.trim();
  const errors: string[] = [];
  if (!/^[a-z0-9._]{3,30}$/.test(username)) errors.push("SCHULOS_ADMIN_USERNAME: 3–30 Zeichen a–z, 0–9, Punkt, Unterstrich");
  if (!firstName || !lastName) errors.push("SCHULOS_ADMIN_FIRST_NAME und SCHULOS_ADMIN_LAST_NAME sind Pflicht");
  let password: AdminConfig["password"] | undefined;
  if (hash) {
    if (!/^[0-9a-f]+:[0-9a-f]+$/i.test(hash)) errors.push("SCHULOS_ADMIN_PASSWORD_HASH hat nicht das Format salt:key (hex)");
    else password = { hash };
  } else if (plain) {
    const problem = checkPassword(plain, { username, firstName, lastName });
    if (problem) errors.push(`SCHULOS_ADMIN_PASSWORD: ${problem}`);
    else password = { plain };
  } else {
    errors.push("SCHULOS_ADMIN_PASSWORD oder SCHULOS_ADMIN_PASSWORD_HASH fehlt");
  }
  if (errors.length || !password) return { ok: false, errors };
  return { ok: true, admin: { username, firstName, lastName, password } };
}

const PLAIN_LINE = /^\s*(export\s+)?SCHULOS_ADMIN_PASSWORD\s*=/;

/** Zeile mit dem Klartext-Passwort durch einen Vermerk ersetzen (rein). */
export function scrubPlainPassword(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => (PLAIN_LINE.test(l) ? "# SCHULOS_ADMIN_PASSWORD wurde nach dem Erststart entfernt" : l))
    .join("\n");
}

/**
 * Klartext-Passwort aus der Konfigurationsdatei entfernen. `false`, wenn das nicht ging (Datei schreibgeschützt
 * oder Passwort kam aus der Umgebung) – dann soll der Start einen Hinweis ausgeben.
 */
export function scrubConfigPassword(dir: string | undefined, file: string): boolean {
  const full = dir && path.join(dir, file);
  const text = full && existsSync(full) ? readFileSync(full, "utf8") : "";
  if (!full || !text.split(/\r?\n/).some((l) => PLAIN_LINE.test(l))) return false;
  try {
    writeFileSync(full, scrubPlainPassword(text));
    return true;
  } catch {
    return false; // schreibgeschützt eingebunden
  }
}
