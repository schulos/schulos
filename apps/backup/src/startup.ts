// Start des Backupservers (aus instrumentation.ts): Konfiguration laden, Datenbank migrieren, beim ersten Start Admin anlegen.
// Läuft, bevor der Server Anfragen annimmt – ein Fehler beendet den Start (Container startet neu).
import { scrubConfigPassword } from "@schulos/server/admin";
import { retentionFromEnv } from "@schulos/server/backup-retention";
import { BACKUP_CONFIG_FILE, loadConfig } from "@schulos/server/config";
import { getDbHandle } from "@/db/client";
import { appSecret } from "@/auth/auth";
import { initializeBackup } from "@/instance";
import { jobsEnabled, startScheduler } from "@/jobs";
import { pruneTime } from "@/maintenance/service";
import { ensureHtpasswd } from "@/pairing/htpasswd";
import { registerInitialCode } from "@/pairing/service";
import { restDir } from "@/settings";

export async function startup(): Promise<void> {
  const t0 = Date.now();
  const cfg = loadConfig(process.env, BACKUP_CONFIG_FILE);
  if (cfg.dir) {
    console.log(`[backup] Konfiguration aus ${cfg.dir}: ${cfg.files.join(", ") || "keine Dateien"}`);
    if (cfg.generatedSecret) console.log("[backup] Auth-Geheimnis erzeugt (secret.env)");
  }
  // Vorgabe-Aufbewahrung gleich prüfen: ein Fehler in backup.env hält den Start an, statt erst jede Kopplung mit 500 abzubrechen
  retentionFromEnv(process.env);
  const { db } = await getDbHandle(); // migriert
  console.log(`[backup] Datenbank bereit, ${Date.now() - t0} ms`);

  const r = await initializeBackup(db, process.env);
  if (r.action === "checked") console.log(`[backup] ${r.users} Konto/Konten`);
  if (r.action === "created-admin") {
    if (r.dev) console.warn(`[backup] Entwicklung ohne Konfiguration: Dev-Konto „admin“ / „schulos-backup“ angelegt – nie im Betrieb verwenden`);
    else console.log(`[backup] Erststart: Admin-Konto „${r.admin}“ angelegt`);
    if (r.usedPlainPassword && !r.dev) {
      if (scrubConfigPassword(cfg.dir, BACKUP_CONFIG_FILE)) console.log(`[backup] Klartext-Passwort aus ${BACKUP_CONFIG_FILE} entfernt`);
      else console.warn("[backup] Hinweis: SCHULOS_ADMIN_PASSWORD steht noch in der Konfiguration bzw. Umgebung – jetzt entfernen.");
    }
  }
  delete process.env.SCHULOS_ADMIN_PASSWORD;

  ensureHtpasswd(restDir());
  const initial = process.env.SCHULOS_INITIAL_PAIRING_CODE;
  if (initial) {
    const c = await registerInitialCode(db, initial, appSecret());
    if (c === "angelegt") console.log("[backup] Kopplungscode aus der Konfiguration übernommen (24 h gültig)");
    if (c === "ungueltig") console.warn("[backup] SCHULOS_INITIAL_PAIRING_CODE hat nicht das richtige Format (z. B. K7Q2-9MXA-4RT1) – ignoriert");
  }

  if (jobsEnabled()) {
    startScheduler(db);
    console.log(`[backup] Hintergrundjobs aktiv (Aufräumen täglich ${pruneTime()})`);
  }
}
