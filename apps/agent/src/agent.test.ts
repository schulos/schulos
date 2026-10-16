import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAINTENANCE_FILE, RESTORE_APPROVAL_FILE, restoreApproval, type AgentPlan, type AgentReport, type AgentState, type RestoreReport, type RestoreRequest } from "@schulos/server/agent-api";
import type { StoredPairing } from "@schulos/server/pairing-client";
import type { requestJson } from "@schulos/server/pinned-request";
import { backupNow, clearRunningMark, PAIRING_FILE, tick, type AgentDeps } from "./agent";
import { agentConfig, pgEnv, STATE_FILE } from "./config";
import type { Exec } from "@schulos/server/exec";
import { dumpFile, parseBackupSummary, repositoryUrl, resticErrors } from "./restic";

const PAIRING: StoredPairing = {
  version: 1,
  backupUrl: "https://backup.test",
  serverName: "Backup",
  caPem: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n",
  instanceId: "inst-1",
  instanceName: "Lindenhof",
  repoUrl: "https://backup.test/restic/i-ab12/",
  restUser: "i-ab12",
  restPassword: "p@ss/wort",
  agentToken: "tok",
  repoPassword: "repo-geheim",
  recoveryKey: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF",
  recoveryConfirmedAt: null,
  pairedAt: "2026-10-05T00:00:00Z",
};

// Inhaltsverzeichnis eines Dumps (pg_restore --list), wie es SchulOS erzeugt
const TOC = "7; 2615 1 SCHEMA - drizzle schulos\n255; 1259 2 TABLE public users schulos\n4473; 0 2 TABLE DATA public users schulos\n";
const SNAP_ID = "abc123de".padEnd(64, "f");
const SUMMARY = JSON.stringify({ message_type: "summary", snapshot_id: "snap123", total_bytes_processed: 5000, data_added: 700 });

interface Call {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

describe("Backup-Agent", () => {
  let dir: string;
  let calls: Call[];
  let reports: AgentReport[];
  let plan: AgentPlan;
  let repoExists: boolean;
  let failDump: boolean;
  let serverDown: boolean;
  let now: Date;
  let recoveryKeySeen: string | null;
  let unauthorizedLeft: number;
  let restoreReports: RestoreReport[];
  let maintenanceDuringRestore: boolean[];

  function deps(): AgentDeps {
    const cfg = { ...agentConfig({ SCHULOS_CONFIG_DIR: path.join(dir, "config"), FILES_DIR: path.join(dir, "files"), DATABASE_URL: "postgres://schulos:pw%21@db:5432/schulos" }), workDir: path.join(dir, "work") };
    const exec: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      if (cmd === "pg_dump") {
        if (failDump) return { code: 1, stdout: "", stderr: "pg_dump: error: connection to server failed\n" };
        writeFileSync(args[args.indexOf("--file") + 1]!, "DUMP");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "cat" && unauthorizedLeft > 0) {
        unauthorizedLeft--;
        return { code: 1, stdout: "", stderr: "Fatal: unable to open config file: unexpected HTTP response (401): 401 Unauthorized" };
      }
      if (args[0] === "cat") return repoExists ? { code: 0, stdout: "{}", stderr: "" } : { code: 10, stdout: "", stderr: "Fatal: repository does not exist" };
      if (args[0] === "init") {
        repoExists = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "key") {
        recoveryKeySeen = readFileSync(args[args.indexOf("--new-password-file") + 1]!, "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "backup") return { code: 0, stdout: `{"message_type":"status"}\n${SUMMARY}\n`, stderr: "" };
      if (args[0] === "restore") {
        // Zustand der Wartungsdatei zum Zeitpunkt des Zurückholens festhalten
        maintenanceDuringRestore.push(existsSync(path.join(dir, "config", MAINTENANCE_FILE)));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "pg_restore") return { code: 0, stdout: args[0] === "--list" ? TOC : "", stderr: "" };
      return { code: 99, stdout: "", stderr: "?" };
    };
    const request = (async (url: string, opts: { body?: unknown; headers?: Record<string, string> }) => {
      if (serverDown) throw new Error("ECONNREFUSED");
      expect(opts.headers?.authorization).toBe("Bearer tok");
      if (url.endsWith("/api/agent/plan")) return { status: 200, body: plan };
      if (url.endsWith("/api/agent/restore")) {
        restoreReports.push((opts.body as { bericht: RestoreReport }).bericht);
        return { status: 200, body: { ok: true } };
      }
      reports.push(opts.body as AgentReport);
      return { status: 200, body: { ok: true } };
    }) as unknown as typeof requestJson;
    return { cfg, exec, request, now: () => now, log: () => {}, sleep: async () => {} };
  }
  const state = () => JSON.parse(readFileSync(path.join(dir, "config", STATE_FILE), "utf8")) as AgentState;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "schulos-agent-"));
    mkdirSync(path.join(dir, "config"));
    mkdirSync(path.join(dir, "files"));
    calls = [];
    reports = [];
    plan = { instanceId: "inst-1", instanceName: "Lindenhof", schedule: ["01:30"], runRequestedAt: null };
    repoExists = false;
    failDump = false;
    serverDown = false;
    now = new Date("2026-10-04T23:31:00Z"); // 01:31 Berlin
    recoveryKeySeen = null;
    unauthorizedLeft = 0;
    restoreReports = [];
    maintenanceDuringRestore = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("SEC-11: Stand der unveränderlichen Kopie aus dem Plan – geprüft übernommen, Unsinn verworfen", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    now = new Date("2026-10-05T10:00:00Z"); // kein Termin fällig
    plan.immutable = { lastAt: "2026-10-05T01:00:00Z", checkedAt: "2026-10-05T16:00:00Z", ok: true, error: null };
    await tick(deps());
    expect(state().immutable).toEqual({ lastAt: "2026-10-05T01:00:00.000Z", checkedAt: "2026-10-05T16:00:00.000Z", ok: true, error: null });
    plan.immutable = { lastAt: "<script>", checkedAt: "kaputt", ok: true, error: null } as unknown as AgentPlan["immutable"];
    await tick(deps());
    expect(state().immutable).toBeNull();
  });

  it("ohne Kopplung passiert nichts", async () => {
    expect(await tick(deps())).toBe("ungekoppelt");
    expect(calls).toEqual([]);
  });

  it("erster Termin: Repository anlegen, Wiederherstellungsschlüssel eintragen, Dump + Dateien + Konfiguration in einem Snapshot", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    expect(await tick(deps())).toBe("zeitplan");

    expect(calls.map((c) => [c.cmd, c.args[0]])).toEqual([
      ["restic", "cat"],
      ["restic", "init"],
      ["restic", "key"],
      ["pg_dump", "--format=custom"],
      ["restic", "backup"],
    ]);
    expect(recoveryKeySeen).toBe(PAIRING.recoveryKey);
    const restic = calls.find((c) => c.args[0] === "backup")!;
    expect(restic.env).toMatchObject({ RESTIC_PASSWORD: "repo-geheim", RESTIC_CACERT: path.join(dir, "work", "backupserver-ca.pem") });
    expect(restic.env!.RESTIC_REPOSITORY).toBe("rest:https://i-ab12:p%40ss%2Fwort@backup.test/restic/i-ab12/");
    expect(restic.args.join(" ")).not.toContain("repo-geheim"); // Geheimnisse nur in der Umgebung
    expect(restic.args.slice(-3)).toEqual([path.join(dir, "work", "datenbank"), path.join(dir, "files"), path.join(dir, "config")]);
    expect(calls.find((c) => c.cmd === "pg_dump")!.env).toMatchObject({ PGHOST: "db", PGUSER: "schulos", PGPASSWORD: "pw!", PGDATABASE: "schulos" });
    // Dump und Schlüsseldatei sind wieder weg
    expect(existsSync(path.join(dir, "work", "datenbank"))).toBe(false);
    expect(existsSync(path.join(dir, "work", "wiederherstellung.key"))).toBe(false);

    expect(reports).toEqual([
      expect.objectContaining({ trigger: "zeitplan", status: "ok", snapshotId: "snap123", bytesTotal: 5000, bytesAdded: 700, requestedAt: null }),
    ]);
    expect(state()).toMatchObject({ lastSlot: "2026-10-05 01:30", lastOkAt: "2026-10-04T23:31:00.000Z", runningSince: null, pendingReport: null });
    expect(state().repoInitializedAt).toBeTruthy();

    // nächster Takt: nichts fällig, kein zweites init
    calls = [];
    now = new Date("2026-10-04T23:32:00Z");
    expect(await tick(deps())).toBe("nichts-faellig");
    expect(calls).toEqual([]);
  });

  it("„Jetzt sichern“ läuft einmal; Fehler werden gemeldet, nicht jede Minute wiederholt; Meldung wird nachgereicht", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    repoExists = true;
    now = new Date("2026-10-05T12:00:00Z"); // 14:00 Berlin – der Termin 01:30 liegt außerhalb des Nachholfensters
    plan.runRequestedAt = "2026-10-05T11:59:00.000Z";
    failDump = true;
    expect(await tick(deps())).toBe("angefordert");
    expect(reports.at(-1)).toMatchObject({ trigger: "angefordert", status: "failed", requestedAt: "2026-10-05T11:59:00.000Z" });
    expect(reports.at(-1)!.error).toBe("pg_dump fehlgeschlagen: pg_dump: error: connection to server failed");
    expect(calls.some((c) => c.args[0] === "init")).toBe(false);

    // dieselbe Anforderung steht noch im Plan (Server hat sie noch nicht gelöscht) → nicht nochmal
    expect(await tick(deps())).toBe("nichts-faellig");

    // Server nicht erreichbar → keine Sicherung, Zustand vermerkt
    serverDown = true;
    expect(await tick(deps())).toBe("keine-verbindung");
    expect(state().lastContactError).toBe("ECONNREFUSED");
    expect(state().lastRun).toMatchObject({ status: "failed" });
  });

  it("direkt nach der Kopplung: 401, bis der rest-server den Zugang kennt – dann geht es weiter; dauerhaft 401 bricht ab", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    unauthorizedLeft = 2;
    expect(await tick(deps())).toBe("zeitplan");
    expect(reports.at(-1)).toMatchObject({ status: "ok" });
    expect(calls.filter((c) => c.args[0] === "cat")).toHaveLength(3);

    rmSync(path.join(dir, "config", STATE_FILE));
    unauthorizedLeft = 99;
    now = new Date("2026-10-05T10:00:00Z");
    plan.runRequestedAt = "2026-10-05T09:59:00.000Z";
    expect(await tick(deps())).toBe("angefordert");
    expect(reports.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("401") });
  });

  const restoreReq = (scope: "komplett" | "dateien", status: "wartet" | "bestaetigt"): RestoreRequest => ({
    id: "job-1",
    snapshotId: "7da39b69".padEnd(64, "e"),
    snapshotShort: "7da39b69",
    snapshotTime: "2026-10-04T23:30:00Z",
    scope,
    requestedBy: "Ina Tech",
    createdAt: "2026-10-05T08:00:00Z",
    status,
  });

  const approve = (req: RestoreRequest, at = now) =>
    writeFileSync(path.join(dir, "config", RESTORE_APPROVAL_FILE), JSON.stringify(restoreApproval(req, at)));

  it("SEC-06: „bestätigt“ vom Backupserver allein reicht nicht – nur mit passender, gültiger Freigabe auf dem Hauptsystem", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    repoExists = true;
    now = new Date("2026-10-05T12:00:00Z");
    const req = restoreReq("komplett", "bestaetigt");
    plan.restore = req;
    expect(await tick(deps())).toBe("nicht-freigegeben");
    // Freigabe für einen anderen Stand bzw. Umfang, abgelaufene Freigabe
    approve({ ...req, snapshotId: "f".repeat(64) });
    expect(await tick(deps())).toBe("nicht-freigegeben");
    approve({ ...req, scope: "dateien" });
    expect(await tick(deps())).toBe("nicht-freigegeben");
    approve(req, new Date(now.getTime() - 31 * 60_000));
    expect(await tick(deps())).toBe("nicht-freigegeben");
    expect(calls).toEqual([]);
    expect(restoreReports).toEqual([]);
    expect(state().restoreRequest).toMatchObject({ id: "job-1", status: "bestaetigt" });
  });

  it("SEC-06: Auftrag mit einer „Snapshot-ID“, die restic als Option läse, wird verworfen – auch mit Freigabe", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    repoExists = true;
    now = new Date("2026-10-05T12:00:00Z");
    const evil = { ...restoreReq("komplett", "bestaetigt"), snapshotId: "--password-command=sh -c id", snapshotShort: "--passwo" };
    plan.restore = evil;
    approve(evil);
    expect(await tick(deps())).toBe("nichts-faellig");
    expect(calls).toEqual([]);
    expect(state().restoreRequest).toBeNull();
    const { restoreSnapshot } = await import("./restic");
    await expect(restoreSnapshot({ exec: deps().exec, bin: "restic", pairing: PAIRING, caFile: null }, "--x", "/", [], { overwrite: "never" })).rejects.toThrow(
      /Ungültige Snapshot-ID/,
    );
    const ok = "a".repeat(64);
    await expect(
      restoreSnapshot({ exec: deps().exec, bin: "restic", pairing: PAIRING, caFile: null }, ok, "/x", [], { overwrite: "never", sub: "relativ" }),
    ).rejects.toThrow(/Ungültiger Ordner/);
    await expect(dumpFile({ exec: deps().exec, bin: "restic", pairing: PAIRING, caFile: null }, "--x", "/x")).rejects.toThrow(/Ungültige Snapshot-ID/);
  });

  it("GATE-4e: Fehlermeldung von restic nennt die eigentlichen Fehler, nicht nur „There were 2 errors“", () => {
    const stderr = "ignoring error for /: chmod /: operation not permitted\nignoring error for /srv: utimes /srv: operation not permitted\nThere were 2 errors\n";
    expect(resticErrors(stderr)).toBe(
      "ignoring error for /: chmod /: operation not permitted · ignoring error for /srv: utimes /srv: operation not permitted · There were 2 errors",
    );
    expect(resticErrors("Fatal: repository does not exist\n")).toBe("Fatal: repository does not exist");
    expect(resticErrors("")).toBe("unbekannter Fehler");
  });

  it("Wiederherstellung: wartet → nur merken; bestätigt (komplett) → Sicherung vorher, Wartung, Datenbank, Dateien genau wie im Stand, Neustart", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    repoExists = true;
    now = new Date("2026-10-05T12:00:00Z");
    plan.restore = restoreReq("komplett", "wartet");
    expect(await tick(deps())).toBe("nichts-faellig");
    expect(state().restoreRequest).toMatchObject({ id: "job-1", status: "wartet" });
    expect(calls).toEqual([]);

    plan.restore = restoreReq("komplett", "bestaetigt");
    approve(plan.restore);
    expect(await tick(deps())).toBe("wiederherstellung");
    expect(existsSync(path.join(dir, "config", RESTORE_APPROVAL_FILE))).toBe(false); // Freigabe gilt genau einmal
    expect(calls.map((c) => c.args[0] === "backup" || c.args[0] === "restore" ? `restic ${c.args[0]}` : c.cmd)).toEqual([
      "restic", // Repository prüfen (frischer Zustand)
      "pg_dump",
      "restic backup",
      "restic restore",
      "pg_restore", // Inhaltsverzeichnis prüfen
      "pg_restore",
      "restic restore",
    ]);
    expect(reports.at(-1)).toMatchObject({ trigger: "vor-wiederherstellung", status: "ok" });
    const [dumpRestore, pgList, pgRestore, filesRestore] = calls.slice(3);
    expect(dumpRestore!.args).toEqual(expect.arrayContaining(["--verify", "--overwrite", "always"]));
    expect(dumpRestore!.args.slice(-2)).toEqual(["--", "7da39b69".padEnd(64, "e")]); // SEC-06: ID nach „--“
    expect(pgList!.args[0]).toBe("--list");
    expect(pgRestore!.args).toEqual(expect.arrayContaining(["--clean", "--if-exists", "--single-transaction", "--use-list", "--dbname", "schulos"]));
    expect(pgRestore!.env).toMatchObject({ PGPASSWORD: "pw!" });
    // GATE-4e: nur der Inhalt des Ordners (`<id>:<ordner>`) direkt ins Ziel – nie „/“ (Rechte von /srv darf der Agent nicht setzen)
    expect(filesRestore!.args).toEqual(expect.arrayContaining(["--target", path.join(dir, "files"), "--overwrite", "always", "--delete"]));
    expect(filesRestore!.args.at(-1)).toBe(`${"7da39b69".padEnd(64, "e")}:${path.join(dir, "files")}`);
    expect(filesRestore!.args).not.toContain("/");
    expect(maintenanceDuringRestore).toEqual([true, true]);
    expect(JSON.parse(readFileSync(path.join(dir, "config", MAINTENANCE_FILE), "utf8"))).toMatchObject({ phase: "neustart" });
    expect(restoreReports.map((r) => r.status)).toEqual(["laeuft", "fertig"]);
    expect(state()).toMatchObject({ restoreRequest: null, lastRestore: { id: "job-1", status: "fertig", scope: "komplett" } });
  });

  it("Wiederherstellung „nur Dateien“: keine Wartung, nur fehlende Dateien (vorhandene bleiben)", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    repoExists = true;
    now = new Date("2026-10-05T12:00:00Z");
    plan.restore = restoreReq("dateien", "bestaetigt");
    approve(plan.restore);
    expect(await tick(deps())).toBe("wiederherstellung");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["restore", "--overwrite", "never", "--target", path.join(dir, "files")]));
    expect(calls[0]!.args).not.toContain("--delete");
    expect(existsSync(path.join(dir, "config", MAINTENANCE_FILE))).toBe(false);
    expect(restoreReports.map((r) => r.status)).toEqual(["laeuft", "fertig"]);
  });

  it("sofort sichern (schulosctl backup now): Zustand aktualisiert, kein Doppellauf; Takt wartet; Start räumt alte Marke weg", async () => {
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    repoExists = true;
    const r = await backupNow(deps(), PAIRING as StoredPairing);
    expect(r.status).toBe("ok");
    expect(state()).toMatchObject({ runningSince: null, lastOkAt: r.finishedAt, lastRun: { trigger: "angefordert", status: "ok" } });
    expect(reports).toHaveLength(1);

    writeFileSync(path.join(dir, "config", STATE_FILE), JSON.stringify({ ...state(), runningSince: now.toISOString() }));
    await expect(backupNow(deps(), PAIRING as StoredPairing)).rejects.toThrow("Es läuft bereits eine Sicherung");
    expect(await tick(deps())).toBe("laeuft");
    clearRunningMark(deps().cfg);
    expect(state().runningSince).toBeNull();
    expect(await tick(deps())).toBe("zeitplan");
  });

  it("neue Kopplung beginnt mit frischem Zustand (neues Repository)", async () => {
    writeFileSync(path.join(dir, "config", STATE_FILE), JSON.stringify({ version: 1, instanceId: "alt", repoInitializedAt: "x", lastSlot: "2026-10-05 01:30" }));
    writeFileSync(path.join(dir, "config", PAIRING_FILE), JSON.stringify(PAIRING));
    expect(await tick(deps())).toBe("zeitplan");
    expect(calls[0]!.args[0]).toBe("cat");
    expect(state().instanceId).toBe("inst-1");
  });

  it("Hilfen: Repository-Adresse, restic-Zusammenfassung, libpq-Umgebung", () => {
    expect(repositoryUrl(PAIRING)).toBe("rest:https://i-ab12:p%40ss%2Fwort@backup.test/restic/i-ab12/");
    expect(parseBackupSummary(`x\n${SUMMARY}`)).toEqual({ snapshotId: "snap123", bytesTotal: 5000, bytesAdded: 700 });
    expect(parseBackupSummary("kaputt")).toBeNull();
    expect(pgEnv("postgres://u@h/d?sslmode=require")).toEqual({ PGHOST: "h", PGPORT: "5432", PGDATABASE: "d", PGUSER: "u", PGSSLMODE: "require" });
  });
});

describe("lastLine", () => {
  it("nimmt bei restic die Fatal-Zeile, sonst die letzte", async () => {
    const { lastLine } = await import("@schulos/server/exec");
    expect(lastLine("Stat failed: 401\nFatal: unable to open config file: 401\nrest:http://x:***@rest/\n")).toBe("Fatal: unable to open config file: 401");
    expect(lastLine("a\n\nb\n")).toBe("b");
    expect(lastLine("")).toBe("unbekannter Fehler");
  });
});

describe("Test-Restore mit App-Start (schulosctl test-restore)", () => {
  it("nur der Dump, nur in die Prüfdatenbank – die echte Datenbank bleibt unberührt", async () => {
    const { restoreDumpIntoProbe } = await import("./restore");
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-agent-probe-"));
    const calls: Call[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      if (args[0] === "snapshots") return { code: 0, stdout: JSON.stringify([{ id: SNAP_ID, short_id: "abc123de", time: "2026-10-05T00:00:00Z" }]), stderr: "" };
      return { code: 0, stdout: args[0] === "--list" ? TOC : "", stderr: "" };
    };
    const base = { SCHULOS_CONFIG_DIR: path.join(dir, "config"), FILES_DIR: path.join(dir, "files"), DATABASE_URL: "postgres://u:p@db/schulos" };
    const deps = (env: Record<string, string>) => ({
      cfg: { ...agentConfig({ ...base, ...env }), workDir: path.join(dir, "work") },
      exec,
      request: (() => {}) as never,
      now: () => new Date(),
      log: () => {},
    });
    // SEC-06: nie mit dem App-Zugang (Superuser) – nur mit der Wegwerf-Rolle für genau die Prüfdatenbank
    const pairing = { ...PAIRING, caPem: null };
    await expect(restoreDumpIntoProbe(deps({}), pairing)).rejects.toThrow(/SCHULOS_PROBE_DATABASE_URL/);
    await expect(restoreDumpIntoProbe(deps({ SCHULOS_PROBE_DATABASE_URL: "postgres://u:p@db/schulos_probelauf" }), pairing)).rejects.toThrow(/eigene Rolle/);
    await expect(restoreDumpIntoProbe(deps({ SCHULOS_PROBE_DATABASE_URL: "postgres://probe:x@db/schulos" }), pairing)).rejects.toThrow(/schulos_probelauf/);
    expect(calls).toEqual([]);
    const cfg = deps({ SCHULOS_PROBE_DATABASE_URL: "postgres://schulos_probelauf:einmal@db/schulos_probelauf" }).cfg;
    const r = await restoreDumpIntoProbe({ cfg, exec, request: (() => {}) as never, now: () => new Date(), log: () => {} }, { ...PAIRING, caPem: null });
    expect(r).toEqual({ snapshot: "abc123de", time: "2026-10-05T00:00:00Z" });
    expect(calls.map((c) => (c.cmd === "restic" ? `restic ${c.args[0]}` : c.cmd))).toEqual(["restic snapshots", "restic restore", "pg_restore", "pg_restore"]);
    const pg = calls[3]!;
    expect(pg.args).toEqual(expect.arrayContaining(["--dbname", "schulos_probelauf", "--use-list"]));
    expect(pg.args).not.toContain("--clean");
    expect(pg.env).toMatchObject({ PGDATABASE: "schulos_probelauf", PGUSER: "schulos_probelauf", PGPASSWORD: "einmal" });
    expect(existsSync(path.join(dir, "work", "test-restore"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Wiederherstellung auf neuer Hardware (Installer)", () => {
  it("neuester Stand: Datenbank, Dateien wie im Stand und secret.env – ohne App, ohne Plan", async () => {
    const { restoreFromScratch } = await import("./restore");
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-agent-neu-"));
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "snapshots") return { code: 0, stdout: JSON.stringify([{ id: SNAP_ID, short_id: "abc123de", time: "2026-10-05T00:00:00Z" }]), stderr: "" };
      if (args[0] === "dump") return { code: 0, stdout: "BETTER_AUTH_SECRET=alt\n", stderr: "" };
      return { code: 0, stdout: args[0] === "--list" ? TOC : "", stderr: "" };
    };
    const cfg = { ...agentConfig({ SCHULOS_CONFIG_DIR: path.join(dir, "config"), FILES_DIR: path.join(dir, "files"), DATABASE_URL: "postgres://u:p@db/schulos" }), workDir: path.join(dir, "work") };
    mkdirSync(path.join(dir, "config"), { recursive: true });
    const r = await restoreFromScratch({ cfg, exec, request: (() => {}) as never, now: () => new Date(), log: () => {} }, { ...PAIRING, caPem: null });
    expect(r).toEqual({ snapshot: "abc123de", details: { datenbank: "eingespielt", dateien: "wie im Stand", geheimnis: "übernommen" } });
    expect(calls.map((c) => (c.cmd === "restic" ? `restic ${c.args[0]}` : c.cmd))).toEqual(["restic snapshots", "restic restore", "pg_restore", "pg_restore", "restic restore", "restic dump"]);
    expect(calls[4]!.args).toEqual(expect.arrayContaining(["--target", path.join(dir, "files"), "--delete", `${SNAP_ID}:${path.join(dir, "files")}`]));
    expect(calls[5]!.args).toEqual(["dump", "--", SNAP_ID, path.join(dir, "config", "secret.env")]);
    expect(readFileSync(path.join(dir, "config", "secret.env"), "utf8")).toBe("BETTER_AUTH_SECRET=alt\n");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Wiederherstellung aus der Offsite-Kopie (beide Server verloren)", () => {
  const snapshots = JSON.stringify([{ id: SNAP_ID, short_id: "abc123de", time: "2026-10-05T00:00:00Z" }]);

  async function run(listing: string, base: string) {
    const { restoreFromOffsite } = await import("./restore");
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-agent-offsite-"));
    const calls: Call[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      if (cmd === "rclone") return { code: 0, stdout: listing, stderr: "" };
      if (args[0] === "snapshots") return { code: 0, stdout: snapshots, stderr: "" };
      return { code: 0, stdout: args[0] === "--list" ? TOC : "", stderr: "" };
    };
    const cfg = { ...agentConfig({ SCHULOS_CONFIG_DIR: path.join(dir, "config"), FILES_DIR: path.join(dir, "files"), DATABASE_URL: "postgres://u:p@db/schulos" }), workDir: path.join(dir, "work") };
    mkdirSync(path.join(dir, "config"), { recursive: true });
    try {
      const r = await restoreFromOffsite({ cfg, exec, request: (() => {}) as never, now: () => new Date(), log: () => {} }, base, "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF");
      return { r, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("Ordner mit genau einer Sicherung: deren Repository, geöffnet mit dem Wiederherstellungsschlüssel, alles wie bei neuer Hardware", async () => {
    const { r, calls } = await run("i-ab12/config\ni-ab12/keys/1234\nnotiz.txt\n", "offsite:schulos/");
    expect(r).toMatchObject({ snapshot: "abc123de", repository: "offsite:schulos/i-ab12", details: { datenbank: "eingespielt", geheimnis: "übernommen" } });
    expect(calls[0]).toMatchObject({ cmd: "rclone", args: ["lsf", "--files-only", "--max-depth", "2", "offsite:schulos"] });
    const restic = calls.filter((c) => c.cmd === "restic");
    expect(restic.map((c) => c.args[0])).toEqual(["snapshots", "restore", "restore", "dump"]);
    for (const c of restic) expect(c.env).toEqual({ RESTIC_REPOSITORY: "rclone:offsite:schulos/i-ab12", RESTIC_PASSWORD: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF" });
  });

  it("Pfad zeigt direkt auf das Repository; mehrere oder keine Sicherung → verständlicher Fehler", async () => {
    expect((await run("config\nkeys/1234\n", "offsite:schulos/i-ab12")).r.repository).toBe("offsite:schulos/i-ab12");
    await expect(run("i-ab12/config\ni-cd34/config\n", "offsite:schulos")).rejects.toThrow(/mehrere Sicherungen \(i-ab12, i-cd34\).*offsite:schulos\/i-ab12/);
    await expect(run("notiz.txt\n", "offsite:schulos")).rejects.toThrow(/keine Sicherung/);
  });
});
