// CA-01: CA-Schlüssel (Caddy, Schul-CA) ins Backup und bei einer Wiederherstellung an die Dienste übergeben.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredPairing } from "@schulos/server/pairing-client";
import type { Exec } from "@schulos/server/exec";
import { caBackupPaths, caddyRootFiles, stageCaRestore, stepCaRoot } from "./ca";
import { agentConfig, type AgentConfig } from "./config";
import { runBackup } from "./agent";
import { emptyAgentState } from "@schulos/server/agent-api";

const SNAP_ID = "abc123de".padEnd(64, "f");
const ROOT_A = "-----BEGIN CERTIFICATE-----\nALT\n-----END CERTIFICATE-----\n";
const ROOT_B = "-----BEGIN CERTIFICATE-----\nNEU\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN EC PRIVATE KEY-----\nGEHEIM\n-----END EC PRIVATE KEY-----\n";

let dir: string;
let cfg: AgentConfig;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "schulos-agent-ca-"));
  cfg = {
    ...agentConfig({
      SCHULOS_CONFIG_DIR: path.join(dir, "config"),
      FILES_DIR: path.join(dir, "files"),
      DATABASE_URL: "postgres://u:p@db/schulos",
      SCHULOS_CADDY_DATA_DIR: path.join(dir, "caddy-data"),
      SCHULOS_STEP_CA_DIR: path.join(dir, "step-ca"),
      SCHULOS_CADDY_CA_RUECKSPIEL: path.join(dir, "rueckspiel-caddy"),
      SCHULOS_STEP_CA_RUECKSPIEL: path.join(dir, "rueckspiel-step-ca"),
    }),
    workDir: path.join(dir, "work"),
  };
  for (const d of ["config", "files", "caddy-data", "step-ca", "rueckspiel-caddy", "rueckspiel-step-ca"]) mkdirSync(path.join(dir, d), { recursive: true });
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function caddyCa(root = ROOT_A) {
  const { crt, key } = caddyRootFiles(cfg);
  mkdirSync(path.dirname(crt), { recursive: true });
  writeFileSync(crt, root);
  writeFileSync(key, KEY);
  return { crt, key };
}

function stepCa(root = ROOT_A) {
  mkdirSync(path.join(cfg.stepCaDir, "config"), { recursive: true });
  mkdirSync(path.join(cfg.stepCaDir, "certs"), { recursive: true });
  writeFileSync(path.join(cfg.stepCaDir, "config", "ca.json"), "{}");
  writeFileSync(stepCaRoot(cfg), root);
}

describe("CA-01: CA-Schlüssel im Backup", () => {
  it("ohne eingerichtete CAs (frische Volumes, Let's Encrypt, kein Profil „geraete“): nichts dazu, kein Fehler", () => {
    expect(caBackupPaths(cfg, (m) => logs.push(m))).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("Caddy: genau Wurzelzertifikat und -schlüssel (nicht die Zwischen-CA, nicht der ganze Datenordner); step-ca: der ganze Ordner", () => {
    const { crt, key } = caddyCa();
    writeFileSync(path.join(path.dirname(crt), "intermediate.key"), "x");
    stepCa();
    expect(caBackupPaths(cfg, (m) => logs.push(m))).toEqual([crt, key, cfg.stepCaDir]);
    expect(crt).toContain(path.join("caddy-data", "caddy", "pki", "authorities", "local", "root.crt"));
  });

  it("step-ca-Volume ohne eingerichtete CA (nur leere Ordner) zählt nicht", () => {
    mkdirSync(path.join(cfg.stepCaDir, "certs"), { recursive: true });
    expect(caBackupPaths(cfg, () => {})).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("nicht lesbarer Schlüssel (Caddy ohne Startskript): ausgelassen und gemeldet – die Sicherung läuft weiter", () => {
    const { key } = caddyCa();
    chmodSync(key, 0o600);
    chmodSync(path.dirname(key), 0o000);
    try {
      expect(caBackupPaths(cfg, (m) => logs.push(m))).toEqual([]);
      expect(logs.join(" ")).toMatch(/Caddy-CA nicht lesbar.*restart caddy/);
      // keine Schlüsselinhalte im Log
      expect(logs.join(" ")).not.toContain("GEHEIM");
    } finally {
      chmodSync(path.dirname(key), 0o700);
    }
  });

  it("runBackup: CA-Pfade im selben Snapshot wie Dump, Dateien und Konfiguration", async () => {
    const { crt, key } = caddyCa();
    stepCa();
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "pg_dump") {
        writeFileSync(args[args.indexOf("--file") + 1]!, "DUMP");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "backup") return { code: 0, stdout: JSON.stringify({ message_type: "summary", snapshot_id: "s1" }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const pairing = { version: 1, instanceId: "i", caPem: null, repoUrl: "https://b/r/", restUser: "u", restPassword: "p", repoPassword: "r" } as unknown as StoredPairing;
    const state = { ...emptyAgentState("i"), repoInitializedAt: "2026-11-01T00:00:00Z" };
    const r = await runBackup({ cfg, exec, request: (() => {}) as never, now: () => new Date(), log: () => {} }, pairing, state, "angefordert");
    expect(r.status).toBe("ok");
    const backup = calls.find((c) => c[1] === "backup")!;
    expect(backup.slice(backup.indexOf("--") + 1)).toEqual([path.join(cfg.workDir, "datenbank"), cfg.filesDir, cfg.configDir, crt, key, cfg.stepCaDir]);
  });
});

describe("CA-01: CA-Schlüssel zurückspielen", () => {
  function fakeRestic(files: Record<string, string>) {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(args);
      if (args[0] === "dump") {
        const f = args.at(-1)!;
        return f in files ? { code: 0, stdout: files[f]!, stderr: "" } : { code: 1, stdout: "", stderr: "Fatal: path not found" };
      }
      if (args[0] === "restore") {
        // restic restore <id>:<ordner> → Inhalt des Ordners ins Ziel
        const target = args[args.indexOf("--target") + 1]!;
        mkdirSync(path.join(target, "config"), { recursive: true });
        mkdirSync(path.join(target, "secrets"), { recursive: true });
        writeFileSync(path.join(target, "config", "ca.json"), "{}");
        writeFileSync(path.join(target, "secrets", "root_ca_key"), KEY, { mode: 0o600 });
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 99, stdout: "", stderr: "?" };
    };
    return { calls, ctx: { exec, bin: "restic", pairing: null, caFile: null, repoEnv: { RESTIC_REPOSITORY: "x", RESTIC_PASSWORD: "y" } } };
  }

  it("neue Hardware (leere Volumes): Caddy-Wurzel und Schul-CA in die Übergabeordner – Caddy/step-ca übernehmen beim Start", async () => {
    const { crt, key } = caddyRootFiles(cfg);
    const { calls, ctx } = fakeRestic({ [crt]: ROOT_A, [key]: KEY, [stepCaRoot(cfg)]: ROOT_A });
    const r = await stageCaRestore(cfg, ctx, SNAP_ID, ["/x", crt, key, cfg.stepCaDir]);
    expect(r).toEqual({ caddyCa: expect.stringContaining("bereitgelegt"), geraeteCa: expect.stringContaining("bereitgelegt") });
    expect(readFileSync(path.join(cfg.caddyCaRestoreDir, "root.crt"), "utf8")).toBe(ROOT_A);
    expect(readFileSync(path.join(cfg.caddyCaRestoreDir, "root.key"), "utf8")).toBe(KEY);
    if (process.platform !== "win32") expect(statSync(path.join(cfg.caddyCaRestoreDir, "root.key")).mode & 0o077).toBe(0o040);
    // step-ca: vollständig als „stand“, der Zwischenordner ist weg
    expect(existsSync(path.join(cfg.stepCaRestoreDir, "stand", "config", "ca.json"))).toBe(true);
    expect(existsSync(path.join(cfg.stepCaRestoreDir, "neu"))).toBe(false);
    const restore = calls.find((c) => c[0] === "restore")!;
    expect(restore.at(-1)).toBe(`${SNAP_ID}:${cfg.stepCaDir}`); // nur der Inhalt des Ordners (GATE-4e)
    expect(restore).toEqual(expect.arrayContaining(["--target", path.join(cfg.stepCaRestoreDir, "neu"), "--verify"]));
  });

  it("dieselbe Wurzel wie jetzt (Wiederherstellung auf demselben System): nichts übergeben, kein Schlüssel gelesen", async () => {
    const { crt, key } = caddyCa(ROOT_A);
    stepCa(ROOT_A);
    const { calls, ctx } = fakeRestic({ [crt]: ROOT_A, [key]: KEY, [stepCaRoot(cfg)]: ROOT_A });
    expect(await stageCaRestore(cfg, ctx, SNAP_ID, [crt, key, cfg.stepCaDir])).toEqual({ caddyCa: "unverändert", geraeteCa: "unverändert" });
    expect(calls.map((c) => c.at(-1))).toEqual([crt, stepCaRoot(cfg)]);
    expect(existsSync(path.join(cfg.caddyCaRestoreDir, "root.key"))).toBe(false);
  });

  it("andere Wurzel als jetzt: übergeben (gilt nach dem nächsten Start)", async () => {
    const { crt, key } = caddyCa(ROOT_B);
    const { ctx } = fakeRestic({ [crt]: ROOT_A, [key]: KEY });
    expect((await stageCaRestore(cfg, ctx, SNAP_ID, [crt, key])).caddyCa).toMatch(/bereitgelegt.*nächsten Start/);
    expect(readFileSync(path.join(cfg.caddyCaRestoreDir, "root.crt"), "utf8")).toBe(ROOT_A);
  });

  it("Stand von vor CA-01 oder ohne CA: „nicht im Stand“, restic wird nicht gefragt", async () => {
    const { calls, ctx } = fakeRestic({});
    expect(await stageCaRestore(cfg, ctx, SNAP_ID, ["/srv/schulos/files"])).toEqual({ caddyCa: "nicht im Stand", geraeteCa: "nicht im Stand" });
    expect(calls).toEqual([]);
  });

  it("Fehler (alte compose.yaml ohne Übergabeordner, kaputter Stand) brechen nicht ab, stehen aber im Ergebnis – ohne Schlüsselinhalt", async () => {
    const { crt, key } = caddyRootFiles(cfg);
    rmSync(cfg.caddyCaRestoreDir, { recursive: true });
    const { ctx } = fakeRestic({ [crt]: ROOT_A, [key]: KEY, [stepCaRoot(cfg)]: "kaputt" });
    const r = await stageCaRestore(cfg, { ...ctx, exec: async (c, a, o) => (a[0] === "restore" ? { code: 1, stdout: "", stderr: "Fatal: kaputt" } : ctx.exec(c, a, o)) }, SNAP_ID, [crt, key, cfg.stepCaDir]);
    expect(r.caddyCa).toMatch(/^nicht zurückgespielt: Übergabeordner .* fehlt/);
    expect(r.geraeteCa).toMatch(/^nicht zurückgespielt: Zurückholen fehlgeschlagen/);
    expect(JSON.stringify(r)).not.toContain("GEHEIM");
    expect(existsSync(path.join(cfg.stepCaRestoreDir, "stand"))).toBe(false);
  });
});
