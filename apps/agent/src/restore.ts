// Wiederherstellung auf das Hauptsystem (B-27, INSTALLATION.md §4.4) – nur bestätigte Aufträge (Code im Hauptsystem eingegeben).
//  komplett: Sicherung des aktuellen Stands → Wartungsmodus → Datenbank (pg_restore --clean) → Dateien genau wie im Stand → Neustart
//  dateien:  nur fehlende Dateien zurück, vorhandene bleiben unverändert (versehentlich gelöschte Dateien)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAINTENANCE_FILE, type AgentState, type MaintenanceState, type RestoreReport, type RestoreRequest } from "@schulos/server/agent-api";
import { checkDumpToc } from "@schulos/server/dump-toc";
import { lastLine } from "@schulos/server/exec";
import type { StoredPairing } from "@schulos/server/pairing-client";
import type { AgentDeps } from "./agent";
import { pgEnv } from "./config";
import { dumpFile, latestSnapshot, ResticError, restoreSnapshot, type ResticContext } from "./restic";

/** Pfad des Dumps im Snapshot (so legt ihn runBackup ab). */
export const dumpPathIn = (workDir: string) => path.join(workDir, "datenbank", "schulos.dump");

/**
 * Inhaltsverzeichnis des Dumps prüfen (SEC-06, @schulos/server/dump-toc): nur Arten des SchulOS-Schemas, sonst Abbruch.
 * Liefert die Datei für `pg_restore --use-list` (pg_stat_statements und Rechte übersprungen).
 */
export async function checkedDumpList(d: AgentDeps, dump: string, dir: string): Promise<string> {
  const r = await d.exec(d.cfg.pgRestore, ["--list", dump]);
  if (r.code !== 0) throw new ResticError(`Dump nicht lesbar: ${lastLine(r.stderr)}`);
  const toc = checkDumpToc(r.stdout);
  if (toc.rejected.length)
    throw new ResticError(`Dump enthält Einträge, die SchulOS nie anlegt (${toc.rejected.slice(0, 3).join("; ")}) – nicht eingespielt.`);
  if (!toc.entries) throw new ResticError("Dump ist leer – nicht eingespielt.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "inhalt.list");
  writeFileSync(file, toc.list, { mode: 0o600 });
  return file;
}

function maintenance(d: AgentDeps, phase: MaintenanceState["phase"], reason: string) {
  const state: MaintenanceState = { since: d.now().toISOString(), reason, phase };
  writeFileSync(path.join(d.cfg.configDir, MAINTENANCE_FILE), JSON.stringify(state), { mode: 0o644 });
}

export interface RestoreDeps extends AgentDeps {
  /** Sicherung vor der Wiederherstellung (komplett) – liefert ok/Fehler; in Tests ersetzbar */
  backupFirst: () => Promise<{ status: "ok" | "failed"; error?: string | null }>;
  report: (r: RestoreReport) => Promise<boolean>;
}

export async function runRestore(d: RestoreDeps, p: StoredPairing, state: AgentState, req: RestoreRequest): Promise<RestoreReport> {
  await d.report({ id: req.id, status: "laeuft" });
  d.log(`Wiederherstellung startet: Stand ${req.snapshotShort}, ${req.scope}`);
  const caFile = p.caPem ? path.join(d.cfg.workDir, "backupserver-ca.pem") : null;
  mkdirSync(d.cfg.workDir, { recursive: true, mode: 0o700 });
  if (caFile) writeFileSync(caFile, p.caPem!);
  const ctx = { exec: d.exec, bin: d.cfg.restic, pairing: p, caFile, sleep: d.sleep };
  const details: Record<string, unknown> = {};
  const restoreDir = path.join(d.cfg.workDir, "wiederherstellung");
  let inMaintenance = false;
  try {
    if (req.scope === "dateien") {
      // Inhalt von /srv/schulos/files aus dem Stand direkt in den Ordner (ohne /srv, /srv/schulos – GATE-4e)
      await restoreSnapshot(ctx, req.snapshotId, d.cfg.filesDir, [], { overwrite: "never", sub: d.cfg.filesDir });
      details.umfang = "nur fehlende Dateien";
    } else {
      if (!d.cfg.databaseUrl) throw new ResticError("Keine PostgreSQL-Datenbank (DATABASE_URL).");
      const before = await d.backupFirst();
      details.sicherungVorher = before.status === "ok" ? "ok" : `fehlgeschlagen: ${before.error ?? "?"}`;
      maintenance(d, "wartung", `Wiederherstellung von Stand ${req.snapshotShort}`);
      inMaintenance = true;
      rmSync(restoreDir, { recursive: true, force: true });
      await restoreSnapshot(ctx, req.snapshotId, restoreDir, [dumpPathIn(d.cfg.workDir)], { overwrite: "always" });
      const dump = path.join(restoreDir, dumpPathIn(d.cfg.workDir));
      const list = await checkedDumpList(d, dump, restoreDir);
      const r = await d.exec(d.cfg.pgRestore, ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--use-list", list, "--dbname", pgEnv(d.cfg.databaseUrl).PGDATABASE!, dump], {
        env: pgEnv(d.cfg.databaseUrl),
      });
      if (r.code !== 0) throw new ResticError(`Datenbank einspielen fehlgeschlagen: ${lastLine(r.stderr)}`);
      details.datenbank = "eingespielt";
      // Dateien genau wie im Stand: Neueres wird ersetzt, seitdem Hinzugekommenes gelöscht
      await restoreSnapshot(ctx, req.snapshotId, d.cfg.filesDir, [], { overwrite: "always", deleteExtra: true, sub: d.cfg.filesDir });
      details.dateien = "wie im Stand";
    }
    return { id: req.id, status: "fertig", details };
  } catch (err) {
    return { id: req.id, status: "fehlgeschlagen", details, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
  } finally {
    rmSync(restoreDir, { recursive: true, force: true });
    // Auch nach einem Fehler: Neustart statt dauerhafter Wartung – die App kommt zurück, die Admin sieht das Ergebnis,
    // der Stand von vor der Wiederherstellung liegt als eigene Sicherung vor.
    if (inMaintenance) maintenance(d, "neustart", `Wiederherstellung von Stand ${req.snapshotShort} beendet`);
    state.restoreRequest = null;
  }
}

/**
 * Neue Hardware (INSTALLATION.md §4.4, Installer „aus Backup wiederherstellen“): vor dem ersten Start der App den neuesten Stand
 * zurückspielen – Datenbank, Dateien und secret.env (mit dem alten Geheimnis sind die Zwei-Faktor-Geheimnisse verschlüsselt).
 * Voraussetzung: Ersatz-Kopplung (backup-pairing.json mit dem Passwort des bestehenden Repositorys).
 */
export async function restoreFromScratch(d: AgentDeps, p: StoredPairing): Promise<{ snapshot: string; details: Record<string, unknown> }> {
  mkdirSync(d.cfg.workDir, { recursive: true, mode: 0o700 });
  const caFile = p.caPem ? path.join(d.cfg.workDir, "backupserver-ca.pem") : null;
  if (caFile) writeFileSync(caFile, p.caPem!);
  return restoreLatest(d, { exec: d.exec, bin: d.cfg.restic, pairing: p, caFile, sleep: d.sleep });
}

/**
 * Beide Server verloren (INSTALLATION.md §4.4, Installer „aus der Offsite-Kopie wiederherstellen“): neuesten Stand direkt aus
 * der Offsite-Kopie (B-37) zurückspielen – geöffnet mit dem Wiederherstellungsschlüssel der Schule. Das rclone-Ziel kommt über
 * die Umgebung (RCLONE_CONFIG_OFFSITE_*), `base` ist entweder das Repository selbst oder der Ordner darüber (B-37 legt je
 * Instanz einen Unterordner an); gibt es dort genau eine Sicherung, wird sie genommen. Danach ist das Hauptsystem ungekoppelt.
 */
export async function restoreFromOffsite(d: AgentDeps, base: string, recoveryKey: string): Promise<{ snapshot: string; repository: string; details: Record<string, unknown> }> {
  const repository = await resolveOffsiteRepository(d, base);
  mkdirSync(d.cfg.workDir, { recursive: true, mode: 0o700 });
  const r = await restoreLatest(d, {
    exec: d.exec,
    bin: d.cfg.restic,
    pairing: null,
    caFile: null,
    sleep: d.sleep,
    repoEnv: { RESTIC_REPOSITORY: `rclone:${repository}`, RESTIC_PASSWORD: recoveryKey },
  });
  return { ...r, repository };
}

/** Repository unter einem rclone-Ziel finden: das Ziel selbst (enthält `config`) oder sein einziger Unterordner mit `config`. */
export async function resolveOffsiteRepository(d: AgentDeps, base: string): Promise<string> {
  const root = base.replace(/\/+$/, "");
  const r = await d.exec(d.cfg.rclone, ["lsf", "--files-only", "--max-depth", "2", root]);
  if (r.code === 127) throw new ResticError("rclone fehlt im Agent-Image.");
  if (r.code !== 0) throw new ResticError(`Offsite-Ziel nicht erreichbar: ${lastLine(r.stderr)}`);
  const configs = r.stdout.split(/\r?\n/).filter((l) => l === "config" || /^[^/]+\/config$/.test(l));
  if (configs.includes("config")) return root;
  const dirs = configs.map((c) => c.slice(0, -"/config".length));
  if (dirs.length === 1) return `${root}/${dirs[0]}`;
  if (!dirs.length) throw new ResticError(`Unter ${root} liegt keine Sicherung.`);
  throw new ResticError(`Unter ${root} liegen mehrere Sicherungen (${dirs.join(", ")}) – den Ordner der Schule angeben, z. B. ${root}/${dirs[0]}.`);
}

async function restoreLatest(d: AgentDeps, ctx: ResticContext): Promise<{ snapshot: string; details: Record<string, unknown> }> {
  if (!d.cfg.databaseUrl) throw new ResticError("Keine PostgreSQL-Datenbank (DATABASE_URL).");
  const snap = await latestSnapshot(ctx);
  if (!snap) throw new ResticError("Im Repository gibt es keinen Stand.");
  const restoreDir = path.join(d.cfg.workDir, "wiederherstellung");
  try {
    rmSync(restoreDir, { recursive: true, force: true });
    await restoreSnapshot(ctx, snap.id, restoreDir, [dumpPathIn(d.cfg.workDir)], { overwrite: "always" });
    const dump = path.join(restoreDir, dumpPathIn(d.cfg.workDir));
    const list = await checkedDumpList(d, dump, restoreDir);
    const r = await d.exec(d.cfg.pgRestore, ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--use-list", list, "--dbname", pgEnv(d.cfg.databaseUrl).PGDATABASE!, dump], {
      env: pgEnv(d.cfg.databaseUrl),
    });
    if (r.code !== 0) throw new ResticError(`Datenbank einspielen fehlgeschlagen: ${lastLine(r.stderr)}`);
    await restoreSnapshot(ctx, snap.id, d.cfg.filesDir, [], { overwrite: "always", deleteExtra: true, sub: d.cfg.filesDir });
    // Geheimnis der App per `restic dump` – ein Zurückholen nach „/“ setzte Rechte von /srv, /srv/schulos (nicht erlaubt)
    const secretFile = path.join(d.cfg.configDir, "secret.env");
    writeFileSync(secretFile, await dumpFile(ctx, snap.id, secretFile), { mode: 0o600 });
    return { snapshot: snap.shortId, details: { datenbank: "eingespielt", dateien: "wie im Stand", geheimnis: "übernommen" } };
  } finally {
    rmSync(restoreDir, { recursive: true, force: true });
  }
}

/** Name der Wegwerf-Datenbank für Probelauf und Test-Restore mit App-Start (schulosctl legt sie an und löscht sie). */
export const PROBE_DATABASE = "schulos_probelauf";

/**
 * Test-Restore mit App-Start (B-32, Ergänzung zu B-26): den Dump des neuesten Stands in die Wegwerf-Datenbank
 * einspielen – nur dorthin, nie in die echte. Dateien bleiben unberührt; schulosctl startet danach die App darauf.
 * SEC-06: Der neueste Stand kommt vom Backupserver und ist ungeprüft. Eingespielt wird darum nur mit der Wegwerf-Rolle
 * (ohne Superuser-Recht, Eigentümerin nur der Prüfdatenbank) aus SCHULOS_PROBE_DATABASE_URL – nie mit dem App-Zugang.
 */
export async function restoreDumpIntoProbe(d: AgentDeps, p: StoredPairing): Promise<{ snapshot: string; time: string }> {
  if (!d.cfg.databaseUrl) throw new ResticError("Keine PostgreSQL-Datenbank (DATABASE_URL).");
  if (!d.cfg.probeDatabaseUrl) throw new ResticError("Kein Zugang zur Prüfdatenbank (SCHULOS_PROBE_DATABASE_URL) – Test-Restore nur über schulosctl test-restore.");
  const probeEnv = pgEnv(d.cfg.probeDatabaseUrl);
  if (probeEnv.PGDATABASE !== PROBE_DATABASE) throw new ResticError(`Prüfdatenbank muss ${PROBE_DATABASE} heißen.`);
  if (!probeEnv.PGUSER || probeEnv.PGUSER === pgEnv(d.cfg.databaseUrl).PGUSER) throw new ResticError("Prüfdatenbank braucht eine eigene Rolle (nicht die der App).");
  mkdirSync(d.cfg.workDir, { recursive: true, mode: 0o700 });
  const caFile = p.caPem ? path.join(d.cfg.workDir, "backupserver-ca.pem") : null;
  if (caFile) writeFileSync(caFile, p.caPem!);
  const ctx = { exec: d.exec, bin: d.cfg.restic, pairing: p, caFile, sleep: d.sleep };
  const snap = await latestSnapshot(ctx);
  if (!snap) throw new ResticError("Im Repository gibt es keinen Stand.");
  const restoreDir = path.join(d.cfg.workDir, "test-restore");
  try {
    rmSync(restoreDir, { recursive: true, force: true });
    await restoreSnapshot(ctx, snap.id, restoreDir, [dumpPathIn(d.cfg.workDir)], { overwrite: "always" });
    const dump = path.join(restoreDir, dumpPathIn(d.cfg.workDir));
    const list = await checkedDumpList(d, dump, restoreDir);
    const r = await d.exec(
      d.cfg.pgRestore,
      ["--no-owner", "--no-privileges", "--single-transaction", "--use-list", list, "--dbname", PROBE_DATABASE, dump],
      { env: probeEnv },
    );
    if (r.code !== 0) throw new ResticError(`Einspielen in die Prüfdatenbank fehlgeschlagen: ${lastLine(r.stderr)}`);
    return { snapshot: snap.shortId, time: snap.time };
  } finally {
    rmSync(restoreDir, { recursive: true, force: true });
  }
}
