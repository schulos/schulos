// Ein Durchlauf des Agenten (jede Minute): Plan holen, ggf. sichern, Ergebnis melden, Zustand schreiben.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  approvalProblem,
  dueSlot,
  emptyAgentState,
  RESTORE_APPROVAL_FILE,
  restoreRequestProblem,
  sanitizeImmutable,
  type AgentPlan,
  type AgentReport,
  type AgentState,
  type RunTrigger,
} from "@schulos/server/agent-api";
import { pairingTrust, type StoredPairing } from "@schulos/server/pairing-client";
import { requestJson } from "@schulos/server/pinned-request";
import { pgEnv, STATE_FILE, VERSION, type AgentConfig } from "./config";
import { lastLine, type Exec } from "@schulos/server/exec";
import { backup, ensureRepository, ResticError } from "./restic";
import { runRestore } from "./restore";

export const PAIRING_FILE = "backup-pairing.json";

export interface AgentDeps {
  cfg: AgentConfig;
  exec: Exec;
  request: typeof requestJson;
  now: () => Date;
  log: (msg: string) => void;
  /** Warten zwischen Wiederholungen (Tests: sofort) */
  sleep?: (ms: number) => Promise<void>;
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readState(cfg: AgentConfig, instanceId: string | null): AgentState {
  const s = readJson<AgentState>(path.join(cfg.configDir, STATE_FILE));
  return s && s.version === 1 && s.instanceId === instanceId ? s : emptyAgentState(instanceId);
}

function call<T>(d: AgentDeps, p: StoredPairing, pathname: string, body?: unknown) {
  return d.request<T>(`${p.backupUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    body,
    trust: pairingTrust(p),
    headers: { authorization: `Bearer ${p.agentToken}` },
  });
}

export async function sendReport(d: AgentDeps, p: StoredPairing, r: AgentReport): Promise<boolean> {
  try {
    const res = await call(d, p, "/api/agent/report", r);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Die eigentliche Sicherung: Repository prüfen/anlegen, Datenbank-Dump, ein Snapshot mit Dump + Dateien + Konfiguration. */
export async function runBackup(d: AgentDeps, p: StoredPairing, state: AgentState, trigger: RunTrigger): Promise<AgentReport> {
  const startedAt = d.now().toISOString();
  const work = d.cfg.workDir;
  const dumpDir = path.join(work, "datenbank");
  const caFile = p.caPem ? path.join(work, "backupserver-ca.pem") : null;
  const keyFile = path.join(work, "wiederherstellung.key");
  const base = { trigger, startedAt, agentVersion: VERSION };
  try {
    if (!d.cfg.databaseUrl) throw new ResticError("Keine PostgreSQL-Datenbank (DATABASE_URL) – der Agent sichert nur Produktivinstanzen mit PostgreSQL.");
    mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
    if (caFile) writeFileSync(caFile, p.caPem!);
    const ctx = { exec: d.exec, bin: d.cfg.restic, pairing: p, caFile, sleep: d.sleep };

    if (!state.repoInitializedAt) {
      if (p.recoveryKey) writeFileSync(keyFile, p.recoveryKey, { mode: 0o600 });
      const r = await ensureRepository(ctx, p.recoveryKey ? keyFile : null);
      state.repoInitializedAt = d.now().toISOString();
      d.log(r === "angelegt" ? "Repository angelegt, Wiederherstellungsschlüssel eingetragen" : "Repository vorhanden");
    }

    const dumpFile = path.join(dumpDir, "schulos.dump");
    // Zugang als libpq-Umgebung statt Argument, damit das Passwort nicht in der Prozessliste steht
    const dump = await d.exec(d.cfg.pgDump, ["--format=custom", "--no-owner", "--file", dumpFile], { env: pgEnv(d.cfg.databaseUrl) });
    if (dump.code !== 0) throw new ResticError(`pg_dump fehlgeschlagen: ${lastLine(dump.stderr)}`);

    const summary = await backup(ctx, [dumpDir, d.cfg.filesDir, d.cfg.configDir], ["schulos", `version:${VERSION}`], `schulos-${p.instanceId}`);
    return { ...base, status: "ok", finishedAt: d.now().toISOString(), ...summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, status: "failed", finishedAt: d.now().toISOString(), error: msg.slice(0, 500) };
  } finally {
    rmSync(dumpDir, { recursive: true, force: true });
    rmSync(keyFile, { force: true });
  }
}

/** Ein Takt. Gibt zurück, ob gesichert wurde (für Tests und das Log). */
export async function tick(
  d: AgentDeps,
): Promise<"ungekoppelt" | "keine-verbindung" | "nichts-faellig" | "laeuft" | "wiederherstellung" | "nicht-freigegeben" | RunTrigger> {
  const p = readJson<StoredPairing>(path.join(d.cfg.configDir, PAIRING_FILE));
  if (!p || p.version !== 1) return "ungekoppelt";
  const stateFile = path.join(d.cfg.configDir, STATE_FILE);
  const state = readState(d.cfg, p.instanceId);

  if (state.pendingReport && (await sendReport(d, p, state.pendingReport))) state.pendingReport = null;

  let plan: AgentPlan;
  try {
    const res = await call<AgentPlan>(d, p, "/api/agent/plan");
    if (res.status !== 200 || !res.body) throw new Error(res.status === 401 ? "Backupserver kennt diese Instanz nicht (entkoppelt?)" : `Antwort ${res.status}`);
    plan = res.body;
    state.lastContactAt = d.now().toISOString();
    state.lastContactError = null;
    // SEC-11: Stand der unveränderlichen Kopie für Verwaltung → System (vom Backupserver, daher geprüft übernommen)
    if ("immutable" in plan) state.immutable = sanitizeImmutable(plan.immutable);
  } catch (err) {
    state.lastContactError = err instanceof Error ? err.message : String(err);
    writeJson(stateFile, state);
    return "keine-verbindung";
  }

  // „sichern“ als eigener Prozess im Container (schulosctl backup now) läuft noch → nicht parallel starten und
  // dessen Zustand nicht überschreiben (der Prozess schreibt am Ende selbst)
  if (state.runningSince && d.now().getTime() - Date.parse(state.runningSince) < RUNNING_STALE_HOURS * 3600_000) return "laeuft";

  // Wiederherstellung: Auftrag für Verwaltung → Backup merken; bestätigt → vor allem anderen ausführen.
  // SEC-06: Der Auftrag kommt vom Backupserver – nur wohlgeformte Aufträge, und ausgeführt wird nur mit passender Freigabe
  // auf dem Hauptsystem (restore-approval.json, schreibt die App bei der Code-Eingabe). Ein übernommener Backupserver kann
  // „bestätigt“ selbst melden, die Freigabe aber nicht anlegen.
  const restoreProblem = plan.restore ? restoreRequestProblem(plan.restore) : null;
  if (restoreProblem) d.log(`Wiederherstellungsauftrag verworfen: ${restoreProblem}`);
  state.restoreRequest = plan.restore && !restoreProblem ? plan.restore : null;
  if (state.restoreRequest?.status === "bestaetigt") {
    const req = state.restoreRequest;
    const approvalFile = path.join(d.cfg.configDir, RESTORE_APPROVAL_FILE);
    let approval: unknown = null;
    try {
      approval = readJson<unknown>(approvalFile);
    } catch {
      approval = null;
    }
    const notApproved = approvalProblem(approval, req, d.now());
    if (notApproved) {
      d.log(`Wiederherstellung ${req.id} nicht ausgeführt: ${notApproved}`);
      writeJson(stateFile, state);
      return "nicht-freigegeben";
    }
    rmSync(approvalFile, { force: true }); // gilt genau einmal
    state.runningSince = d.now().toISOString();
    writeJson(stateFile, state);
    const report = await runRestore(
      {
        ...d,
        report: async (r) => (await call(d, p, "/api/agent/restore", { aktion: "melden", bericht: r }).catch(() => ({ status: 0 }))).status === 200,
        backupFirst: async () => {
          const b = await runBackup(d, p, state, "vor-wiederherstellung");
          if (b.status === "ok") state.lastOkAt = b.finishedAt;
          if (!(await sendReport(d, p, b))) state.pendingReport = b;
          return b;
        },
      },
      p,
      state,
      req,
    );
    d.log(report.status === "fertig" ? `Wiederherstellung fertig (${JSON.stringify(report.details)})` : `Wiederherstellung fehlgeschlagen: ${report.error}`);
    await call(d, p, "/api/agent/restore", { aktion: "melden", bericht: report }).catch(() => undefined);
    state.lastRestore = { id: req.id, scope: req.scope, snapshotShort: req.snapshotShort, status: report.status === "fertig" ? "fertig" : "fehlgeschlagen", finishedAt: d.now().toISOString(), error: report.error ?? null };
    state.runningSince = null;
    writeJson(stateFile, state);
    return "wiederherstellung";
  }

  const requested = plan.runRequestedAt && plan.runRequestedAt !== state.lastRequestHandled ? plan.runRequestedAt : null;
  const slot = requested ? null : dueSlot(plan.schedule, d.now(), state.lastSlot);
  const trigger: RunTrigger | null = requested ? "angefordert" : slot ? "zeitplan" : null;
  if (!trigger) {
    writeJson(stateFile, state);
    return "nichts-faellig";
  }

  state.runningSince = d.now().toISOString();
  writeJson(stateFile, state);
  d.log(`Sicherung startet (${trigger === "angefordert" ? "angefordert" : `Termin ${slot}`})`);
  const report = await runBackup(d, p, state, trigger);
  report.requestedAt = requested;
  d.log(report.status === "ok" ? `Sicherung fertig: Snapshot ${report.snapshotId}` : `Sicherung fehlgeschlagen: ${report.error}`);

  // Ein fehlgeschlagener Termin wird nicht jede Minute wiederholt – er ist gemeldet, der nächste Termin versucht es erneut.
  if (slot) state.lastSlot = slot;
  if (requested) state.lastRequestHandled = requested;
  recordRun(state, trigger, report);
  if (!(await sendReport(d, p, report))) state.pendingReport = report;
  writeJson(stateFile, state);
  return trigger;
}

function recordRun(state: AgentState, trigger: RunTrigger, report: AgentReport) {
  state.lastRun = {
    trigger,
    status: report.status,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    snapshotId: report.snapshotId ?? null,
    bytesTotal: report.bytesTotal ?? null,
    bytesAdded: report.bytesAdded ?? null,
    error: report.error ?? null,
  };
  if (report.status === "ok") state.lastOkAt = report.finishedAt;
  state.runningSince = null;
}

/** Läuft eine Sicherung/Wiederherstellung noch? Ältere Marken (Prozess abgestürzt) zählen nicht. */
export const RUNNING_STALE_HOURS = 6;

/**
 * Beim Start des Agenten (Hauptprozess des Containers) kann nichts mehr laufen – ein Neustart beendet auch
 * Einmal-Befehle im Container. Eine liegengebliebene Marke würde sonst Sicherungen bis zu 6 h blockieren.
 */
export function clearRunningMark(cfg: AgentConfig): void {
  const p = readJson<StoredPairing>(path.join(cfg.configDir, PAIRING_FILE));
  if (!p) return;
  const state = readState(cfg, p.instanceId);
  if (!state.runningSince) return;
  state.runningSince = null;
  writeJson(path.join(cfg.configDir, STATE_FILE), state);
}

/**
 * Sofort sichern (`agent.mjs sichern`, schulosctl backup now): wie ein angeforderter Lauf, aber ohne Plan.
 * Verweigert, wenn gerade ein Lauf im Gange ist; Ergebnis landet im Zustand (Verwaltung → Backup, schulosctl status).
 */
export async function backupNow(d: AgentDeps, p: StoredPairing): Promise<AgentReport> {
  const stateFile = path.join(d.cfg.configDir, STATE_FILE);
  const state = readState(d.cfg, p.instanceId);
  if (state.runningSince && d.now().getTime() - Date.parse(state.runningSince) < RUNNING_STALE_HOURS * 3600_000)
    throw new Error(`Es läuft bereits eine Sicherung oder Wiederherstellung (seit ${state.runningSince}).`);
  state.runningSince = d.now().toISOString();
  writeJson(stateFile, state);
  const report = await runBackup(d, p, state, "angefordert");
  recordRun(state, "angefordert", report);
  if (!(await sendReport(d, p, report))) state.pendingReport = report;
  writeJson(stateFile, state);
  return report;
}
