// Einstieg des Backup-Agenten (Container `backup-agent` im Haupt-Stack): ohne Befehl jede Minute ein Takt, nie zwei gleichzeitig.
// Einmal-Befehle (Installer, `docker compose run --rm backup-agent node /opt/schulos-agent/agent.mjs <befehl>`), Exitcode 0 = geschafft:
//   koppeln <adresse> <code> [name]  – mit dem Backupserver koppeln (wie Verwaltung → Backup), schreibt backup-pairing.json
//   sichern                          – jetzt sichern (ohne Plan), Ergebnis an den Backupserver
//   wiederherstellen                 – neue Hardware: neuesten Stand zurückspielen, vor dem ersten Start der App
//   wiederherstellen-offsite         – beide Server verloren: neuesten Stand aus der Offsite-Kopie (SCHULOS_OFFSITE = rclone-Ziel,
//                                      RCLONE_CONFIG_OFFSITE_*, SCHULOS_RECOVERY_KEY = Wiederherstellungsschlüssel), vor dem ersten Start
//   probe-einspielen                 – Test-Restore mit App-Start (schulosctl test-restore): neuesten Dump in schulos_probelauf
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exec } from "@schulos/server/exec";
import { pairWithBackup, type StoredPairing } from "@schulos/server/pairing-client";
import { requestJson } from "@schulos/server/pinned-request";
import { cleanTmpDir } from "@schulos/server/tmp-aufraeumen";
import { backupNow, clearRunningMark, PAIRING_FILE, tick } from "./agent";
import { agentConfig, VERSION } from "./config";
import { PROBE_DATABASE, restoreDumpIntoProbe, restoreFromOffsite, restoreFromScratch } from "./restore";

const cfg = agentConfig();
const log = (msg: string) => console.log(`[agent] ${new Date().toISOString()} ${msg}`);
const deps = { cfg, exec, request: requestJson, now: () => new Date(), log };
const pairingFile = path.join(cfg.configDir, PAIRING_FILE);

function pairing(): StoredPairing {
  if (!existsSync(pairingFile)) throw new Error("Nicht gekoppelt (backup-pairing.json fehlt).");
  return JSON.parse(readFileSync(pairingFile, "utf8")) as StoredPairing;
}

async function command(name: string, args: string[]): Promise<string> {
  if (name === "koppeln") {
    const [url, code, ...rest] = args;
    if (!url || !code) throw new Error("Aufruf: koppeln <adresse> <code> [name]");
    if (existsSync(pairingFile)) throw new Error("Schon gekoppelt – erst in Verwaltung → Backup entkoppeln.");
    const p = await pairWithBackup(
      { backupUrl: url, code, instanceName: rest.join(" ") || process.env.SCHULOS_SCHOOL_NAME || "SchulOS", mainUrl: process.env.BETTER_AUTH_URL ?? "" },
      { allowHttp: process.env.SCHULOS_BACKUP_ALLOW_HTTP === "1" },
    );
    writeFileSync(pairingFile, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
    return `gekoppelt mit ${p.serverName} (${p.backupUrl}), Instanz ${p.instanceId}${p.recoveryKey ? " – Wiederherstellungsschlüssel in Verwaltung → Backup bestätigen" : ""}`;
  }
  if (name === "sichern") {
    const r = await backupNow(deps, pairing());
    if (r.status !== "ok") throw new Error(r.error ?? "Sicherung fehlgeschlagen");
    return `Sicherung fertig: Snapshot ${r.snapshotId}`;
  }
  if (name === "probe-einspielen") {
    const r = await restoreDumpIntoProbe(deps, pairing());
    return `Stand ${r.snapshot} (${r.time}) in die Prüfdatenbank ${PROBE_DATABASE} eingespielt`;
  }
  if (name === "wiederherstellen") {
    const r = await restoreFromScratch(deps, pairing());
    return `Wiederherstellung von Stand ${r.snapshot} fertig: ${JSON.stringify(r.details)}`;
  }
  if (name === "wiederherstellen-offsite") {
    const base = process.env.SCHULOS_OFFSITE;
    const key = process.env.SCHULOS_RECOVERY_KEY;
    if (!base || !key) throw new Error("SCHULOS_OFFSITE und SCHULOS_RECOVERY_KEY fehlen.");
    const r = await restoreFromOffsite(deps, base, key.trim().toUpperCase());
    return `Wiederherstellung aus der Offsite-Kopie ${r.repository}, Stand ${r.snapshot} fertig: ${JSON.stringify(r.details)} – Hauptsystem ist ungekoppelt`;
  }
  throw new Error(`Unbekannter Befehl „${name}“ (koppeln, sichern, wiederherstellen, wiederherstellen-offsite, probe-einspielen)`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd) {
  command(cmd, args).then(
    (msg) => {
      log(msg);
      process.exit(0);
    },
    (err: unknown) => {
      log(`${cmd} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
} else {
  startLoop();
}

function startLoop() {
  let busy = false;
  let lastOutcome = "";

  let lastCleanup = 0;
  async function run() {
    if (busy) return;
    busy = true;
    try {
      // G4E-O18: Reste abgebrochener Dumps/Wiederherstellungen unter /tmp (Volume agent_tmp) – höchstens stündlich, älter als 24 h
      if (Date.now() - lastCleanup >= 3600_000) {
        lastCleanup = Date.now();
        const removed = cleanTmpDir();
        if (removed.length) log(`/tmp aufgeräumt: ${removed.length} alte Einträge`);
      }
      const outcome = await tick(deps);
      // nur Wechsel loggen, nicht jede Minute „nichts fällig“
      if (outcome !== lastOutcome && (outcome === "ungekoppelt" || outcome === "keine-verbindung"))
        log(outcome === "ungekoppelt" ? "nicht gekoppelt – warte" : "Backupserver nicht erreichbar");
      lastOutcome = outcome;
    } catch (err) {
      log(`Fehler im Takt: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  }

  log(`SchulOS Backup-Agent ${VERSION} – Konfiguration ${cfg.configDir}, Dateien ${cfg.filesDir}, Datenbank ${cfg.databaseUrl ? "PostgreSQL" : "fehlt"}`);
  clearRunningMark(cfg);
  void run();
  const timer = setInterval(run, cfg.intervalMs);
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      clearInterval(timer);
      log("beendet");
      process.exit(0);
    });
}
