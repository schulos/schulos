// Zugänge des restic rest-servers (.htpasswd im gemeinsamen Datenordner). Der rest-server liest die Datei bei Änderungen
// selbst neu (geprüft: nach wenigen Sekunden, ohne Neustart) – die Backup-App braucht deshalb keinen Docker-Socket.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

export function htpasswdFile(dir: string): string {
  return path.join(dir, ".htpasswd");
}

/** Rein: Zeilen „user:hash“, Benutzer ersetzt bzw. ergänzt (hash = null entfernt ihn). */
export function withUser(text: string, user: string, hash: string | null): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith(`${user}:`));
  if (hash) lines.push(`${user}:${hash}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function update(dir: string, user: string, hash: string | null) {
  if (!/^[a-z0-9-]{3,40}$/.test(user)) throw new Error(`Ungültiger rest-server-Benutzer: ${user}`);
  mkdirSync(dir, { recursive: true });
  const file = htpasswdFile(dir);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  // In place schreiben, nicht per rename ersetzen: der rest-server überwacht die Datei selbst und bemerkt eine
  // ersetzte Datei nicht (live geprüft – Zugänge blieben bei 401). Die Datei ist klein, er liest sie erst nach der Änderung.
  writeFileSync(file, withUser(current, user, hash), { mode: 0o640 });
}

/** Leere .htpasswd anlegen, falls sie fehlt – ohne Datei startet der rest-server nicht. */
export function ensureHtpasswd(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = htpasswdFile(dir);
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o640 });
}

export async function setRestUser(dir: string, user: string, password: string): Promise<void> {
  update(dir, user, await bcrypt.hash(password, 10));
}

export function removeRestUser(dir: string, user: string): void {
  update(dir, user, null);
}
