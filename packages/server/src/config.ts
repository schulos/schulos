// Konfiguration aus der Umgebung bzw. aus SCHULOS_CONFIG_DIR (Container: /srv/schulos/config).
// Dort liegen `schulos.env` (Hauptsystem) bzw. `backup.env` (Backupserver) vom Installer bzw. Admin (KEY=VALUE)
// und `secret.env` (beim ersten Start erzeugt).
// Umgebungsvariablen haben Vorrang vor den Dateien.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Env = Record<string, string | undefined>;

export const CONFIG_FILE = "schulos.env";
export const BACKUP_CONFIG_FILE = "backup.env";
export const SECRET_FILE = "secret.env";

/** Liest KEY=VALUE-Zeilen (Kommentare mit #, Werte optional in "…" oder '…'). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out[m[1]!] = v;
  }
  return out;
}

/** Übernimmt Werte in die Umgebung, ohne gesetzte Variablen zu überschreiben. Gibt die übernommenen Schlüssel zurück. */
export function applyDefaults(env: Env, values: Record<string, string>): string[] {
  const taken: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined) {
      env[k] = v;
      taken.push(k);
    }
  }
  return taken;
}

/**
 * Lädt die Konfigurationsdateien und erzeugt beim ersten Start ein Auth-Geheimnis (secret.env, nur für den
 * App-Benutzer lesbar), falls weder Umgebung noch Dateien eines liefern. Ohne SCHULOS_CONFIG_DIR passiert nichts.
 */
export function loadConfig(
  env: Env = process.env,
  configFile = CONFIG_FILE,
  /** false: fehlendes Geheimnis nicht anlegen (Kommandozeile neben der laufenden App – nur der Server legt es an) */
  opts: { generateSecret?: boolean } = {},
): { dir?: string; files: string[]; generatedSecret: boolean } {
  const dir = env.SCHULOS_CONFIG_DIR;
  if (!dir) return { files: [], generatedSecret: false };
  const files: string[] = [];
  for (const name of [configFile, SECRET_FILE]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    applyDefaults(env, parseEnvFile(readFileSync(file, "utf8")));
    files.push(name);
  }
  let generatedSecret = false;
  if (!env.BETTER_AUTH_SECRET && opts.generateSecret !== false) {
    const secret = randomBytes(32).toString("base64url");
    const file = path.join(dir, SECRET_FILE);
    writeFileSync(file, `# Beim ersten Start erzeugt – nicht weitergeben, im Backup enthalten\nBETTER_AUTH_SECRET=${secret}\n`, { flag: "a", mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows/Dateisysteme ohne Unix-Rechte
    }
    env.BETTER_AUTH_SECRET = secret;
    generatedSecret = true;
  }
  return { dir, files, generatedSecret };
}
