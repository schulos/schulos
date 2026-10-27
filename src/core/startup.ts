// Start des Server-Prozesses (aus src/instrumentation.ts): Konfiguration laden, Datenbank migrieren,
// Instanz prüfen bzw. beim ersten Start anlegen (Demo-Seed oder leere Produktivinstanz).
// Läuft, bevor der Server Anfragen annimmt – ein Fehler hier beendet den Start (Container startet neu).
import { CONFIG_FILE, loadConfig } from "@schulos/server/config";
import { getDbHandle } from "./db/client";
import { enableQueryStats } from "./db/statements";
import { watchMaintenance } from "./backup/maintenance";
import { initializeInstance } from "./instance";
import { getStorage } from "./files/storage";
import { scrubConfigPassword } from "@schulos/server/admin";
import { jobsEnabled } from "./jobs";
import { releaseNote } from "./school/freigabe";
import { readSchoolSettings } from "./settings";
import { startAlarmChecks, startMailOutbox, startScheduler, startSolverQueue, startSubstitutionGong } from "./scheduler";
import { mailConfig } from "@schulos/server/mail";
import { executeQueued, failInterruptedRuns } from "@/modules/stundenplan/solverlauf";
import { syncHolidays } from "@/modules/verwaltung/ferien-abruf";
import { toBerlinDate } from "./time";
import { syncModules } from "./modules/registry";
import { MODULES } from "@/modules";
import { activeBans, banCache, startCrowdsecSync } from "./crowdsec";

export async function startup(): Promise<void> {
  const t0 = Date.now();
  const cfg = loadConfig();
  if (cfg.dir) {
    console.log(`[schulos] Konfiguration aus ${cfg.dir}: ${cfg.files.join(", ") || "keine Dateien"}`);
    if (cfg.generatedSecret) console.log("[schulos] Auth-Geheimnis erzeugt (secret.env)");
  }
  const { db } = await getDbHandle(); // migriert
  console.log(`[schulos] Datenbank bereit (${process.env.DATABASE_URL ? "PostgreSQL" : "PGlite"}), ${Date.now() - t0} ms`);
  if (process.env.DATABASE_URL && (await enableQueryStats(db))) console.log("[schulos] Abfragestatistik (pg_stat_statements) aktiv");

  const r = await initializeInstance(db, process.env, new Date(), getStorage());
  if (r.action === "seeded-demo") console.log(`[schulos] Erststart Demo: Demo-Schule mit ${r.users} Konten angelegt`);
  if (r.action === "checked") console.log(`[schulos] Instanz: ${r.type}`);
  if (r.action === "created-production") {
    console.log(`[schulos] Erststart Produktiv: leere Instanz mit Admin-Konto „${r.admin}“ angelegt`);
    if (r.usedPlainPassword) {
      if (scrubConfigPassword(cfg.dir, CONFIG_FILE)) console.log(`[schulos] Klartext-Passwort aus ${CONFIG_FILE} entfernt`);
      else console.warn("[schulos] Hinweis: SCHULOS_ADMIN_PASSWORD steht noch in der Konfiguration bzw. Umgebung – jetzt entfernen.");
    }
  }
  delete process.env.SCHULOS_ADMIN_PASSWORD;
  // nach einem Update: neue Module ausgeschaltet, ihre Standardrechte angelegt (B-34)
  if (r.action !== "none") {
    const { newlyDisabled } = await syncModules(db, MODULES);
    if (newlyDisabled.length)
      console.log(`[schulos] Neue Module (ausgeschaltet, unter „Rechte & Module“ einschalten): ${newlyDisabled.join(", ")}`);
  }
  if (r.action !== "none") {
    const note = releaseNote((await readSchoolSettings(db)).profile.state);
    if (note) console.warn(`[schulos] Hinweis: ${note}`);
  }

  // Wiederherstellung (B-27): nach „neustart“ beendet sich die App, Docker startet sie neu
  watchMaintenance();
  // SEC-15 (optional): Sperren von CrowdSec schon vor der ersten Anfrage kennen und laufend abgleichen (GATE-4e)
  if (await startCrowdsecSync())
    console.log(`[schulos] CrowdSec-Sperren aktiv (${banCache().error ? `noch nicht erreichbar: ${banCache().error}` : `${activeBans(banCache())} aktiv`})`);

  const interrupted = await failInterruptedRuns(db);
  if (interrupted) console.log(`[schulos] ${interrupted} unterbrochene Stundenplan-Berechnung(en) als abgebrochen markiert`);
  // wartende Läufe (SP-06) weiterrechnen – im Hintergrund, der Start wartet nicht darauf
  void executeQueued(db, toBerlinDate(new Date())).then((r) => {
    if (r.executed.length) console.log(`[schulos] ${r.executed.length} wartende Stundenplan-Berechnung(en) nach dem Start gerechnet`);
  });
  if (jobsEnabled(process.env)) {
    startScheduler(db);
    startMailOutbox(db);
    startSolverQueue(db);
    // VT-04: Vertretungsnachrichten zur geplanten Zeit (Minutentakt)
    startSubstitutionGong(db);
    // Alarm-Mails (B-38) nur mit SMTP-Konfiguration; fehlerhafte Angaben melden statt den Start zu verhindern
    try {
      if (mailConfig()) {
        startAlarmChecks(db);
        console.log("[schulos] Alarm-Mails aktiv (alle 15 Minuten geprüft)");
      }
    } catch (err) {
      console.error(`[schulos] ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("[schulos] Hintergrundjobs aktiv (Löschlauf 02:30, Ferienabruf 03:30, Vertretungsnachrichten minütlich)");
    // neue Produktivinstanz: Ferien gleich holen statt erst in der Nacht (blockiert den Start nicht)
    if (r.action === "created-production")
      void syncHolidays(db, toBerlinDate(new Date())).then((s) =>
        console.log(s.ok ? `[schulos] Ferien abgerufen: ${s.added} Einträge` : `[schulos] Ferienabruf fehlgeschlagen: ${s.error}`),
      );
  }
}
