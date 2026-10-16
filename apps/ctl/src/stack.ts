// Docker-Seite von schulosctl update (B-32): echte Schritte für runUpdate() gegen den Compose-Stack im Installationsordner.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { exec } from "@schulos/server/exec";
import { HOST_FILES, loadSignedManifest, type HostFile, type ReleaseManifest } from "@schulos/server/release";
import { replaceCtl, stageCompose, type HostFileDeps, type StagedCompose } from "./host-files";
import { imageEnvFor, readEnvValue, setEnvValues, type ProbeResult, type UpdateDeps } from "./update";
import type { AppInfo } from "./core";
import { ADMIN_ROLE, APP_ROLE, ensureDbRole, parseRoleState, psqlSetLine, ROLE_STATE_SQL, scramVerifier, type DbRoleDeps, type PsqlResult } from "./db-role";

declare const CTL_PUBKEY: string;
/** öffentlicher Release-Schlüssel (release/cosign.pub, beim Bauen eingebacken); SCHULOS_RELEASE_KEY = Datei für eigene Builds/Tests */
export function releaseKey(env: Record<string, string | undefined> = process.env): string {
  if (env.SCHULOS_RELEASE_KEY) return readFileSync(env.SCHULOS_RELEASE_KEY, "utf8");
  if (typeof CTL_PUBKEY === "string") return CTL_PUBKEY;
  throw new Error("Kein Release-Schlüssel eingebacken – SCHULOS_RELEASE_KEY setzen");
}

export const PROBE_DB = "schulos_probelauf";
/** Wegwerf-Rolle des Test-Restores (SEC-06): ohne Superuser-Recht, Eigentümerin nur der Prüfdatenbank, je Lauf neues Passwort */
export const PROBE_ROLE = "schulos_probelauf";
export const PROBE_CONTAINER = "schulos-probelauf";
/** Repo der Releases (REPO-01: am Umschalt-Tag auf die Organisation umstellen – einzige Stelle im Code, docs/VEROEFFENTLICHUNG.md) */
export const RELEASE_REPO = "schulos/schulos";

export class Stack {
  /** files: zusätzliche bzw. andere Compose-Dateien (Vorschau: compose.vorschau.yaml), relativ zum Installationsordner */
  constructor(
    readonly dir: string,
    readonly files: string[] = [],
  ) {}

  base(): string[] {
    return ["compose", "--project-directory", this.dir, ...this.files.flatMap((f) => ["-f", path.join(this.dir, f)])];
  }

  compose(args: string[]) {
    return exec("docker", [...this.base(), ...args]);
  }

  /** Ausgabe durchreichen (Pull/Up dauern) */
  composeStream(args: string[]): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn("docker", [...this.base(), ...args], { stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
  }

  /** compose-Befehl mit Eingabe auf stdin (z. B. Datei in einen Container schreiben, SQL mit Passwörtern) */
  composeInput(args: string[], input: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("docker", [...this.base(), ...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin!.end(input);
    });
  }

  async must(args: string[], what: string): Promise<string> {
    const r = await this.compose(args);
    if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? r.code}`);
    return r.stdout;
  }

  envFile() {
    return path.join(this.dir, ".env");
  }

  env(): string {
    return existsSync(this.envFile()) ? readFileSync(this.envFile(), "utf8") : "";
  }

  async appInfo(): Promise<AppInfo | null> {
    const r = await this.compose(["exec", "-T", "app", "node", "cli.mjs", "info"]);
    try {
      return r.code === 0 ? (JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as AppInfo) : null;
    } catch {
      return null;
    }
  }

  async project(): Promise<string> {
    const cfg = JSON.parse(await this.must(["config", "--format", "json"], "compose config")) as { name: string };
    return cfg.name;
  }

  private admin: string | null = null;

  /**
   * Wartungsrolle für Rollen, Datenbanken und Erweiterungen (SEC-07): „postgres“; vor der Umstellung einer alten
   * Installation (ensureDbRole) ist es noch „schulos“ selbst. Lokal über den Socket, ohne Passwort.
   */
  async adminRole(): Promise<string> {
    if (this.admin) return this.admin;
    const r = await this.psqlAs(APP_ROLE, "postgres", ROLE_STATE_SQL);
    const rows = r.code === 0 ? parseRoleState(r.stdout) : [];
    const admin = rows.some((x) => x.name === ADMIN_ROLE && x.superuser) ? ADMIN_ROLE : APP_ROLE;
    if (r.code === 0) this.admin = admin;
    return admin;
  }

  /** nach einer Umstellung neu ermitteln */
  forgetAdminRole() {
    this.admin = null;
  }

  /** SQL als Wartungsrolle */
  async psql(db: string, sqlText: string) {
    return this.psqlAs(await this.adminRole(), db, sqlText);
  }

  psqlAs(user: string, db: string, sqlText: string) {
    return this.compose(["exec", "-T", ...guardEnv(user), "postgres", "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-tAc", sqlText]);
  }

  /** SQL über stdin (Passwörter nie als Argument); single = eine Transaktion */
  psqlScript(user: string, db: string, sqlText: string, single = false): Promise<PsqlResult> {
    return this.composeInput(
      ["exec", "-T", ...guardEnv(user), "postgres", "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-tA", ...(single ? ["-1"] : []), "-f", "-"],
      sqlText,
    );
  }
}

/**
 * GATE-031 (S-04): Die App-Rolle ist Eigentümerin der Datenbank „schulos“ und könnte dort per `ALTER DATABASE … SET
 * search_path` eigene Funktionen vor die eingebauten schieben – eine Superuser-Sitzung führte sie dann aus. Sitzungen jeder
 * anderen Rolle (Wartungsrolle, Hilfsrolle) bekommen darum einen festen search_path; Verbindungsoptionen gehen vor.
 */
export const ADMIN_PGOPTIONS = "-c search_path=pg_catalog,pg_temp";
export function guardEnv(user: string): string[] {
  return user === APP_ROLE ? [] : ["-e", `PGOPTIONS=${ADMIN_PGOPTIONS}`];
}

/** Programm mit stdout in eine Datei bzw. stdin aus einer Datei (binärsicher – pg_dump -Fc). */
function pipeFile(cmd: string, args: string[], file: { out?: string; in?: string }): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [file.in ? "pipe" : "ignore", file.out ? "pipe" : "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    if (file.out) child.stdout!.pipe(createWriteStream(file.out, { mode: 0o600 }));
    if (file.in) createReadStream(file.in).pipe(child.stdin!);
    child.on("error", (e) => resolve({ code: 127, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Dump der App-Datenbank als App-Rolle ohne pg_stat_statements (SEC-07): die Erweiterung gehört der Wartungsrolle, und
 * pg_restore als App-Rolle könnte sie weder löschen (--clean) noch anlegen.
 */
export const PG_DUMP_APP = ["pg_dump", "-U", APP_ROLE, "--exclude-extension=pg_stat_statements", "-Fc", APP_ROLE];

/** Schritte für ensureDbRole() gegen den Stack. */
export function dbRoleDeps(s: Stack, timeoutMs: number): DbRoleDeps {
  return {
    psql: (user, db, sqlText, single) => s.psqlScript(user, db, sqlText, single),
    readEnv: () => s.env(),
    writeEnv: (text) => writeFileSync(s.envFile(), text, { mode: 0o600 }),
    stopApp: async () => void (await s.must(["stop", "app", "backup-agent"], "App anhalten")),
    startStack: async () => {
      s.forgetAdminRole();
      if ((await s.composeStream(["up", "-d", "--wait", "--wait-timeout", String(Math.round(timeoutMs / 1000))])) !== 0)
        throw new Error("Stack startet nach der Umstellung der Datenbankrolle nicht");
    },
    secret: () => randomBytes(24).toString("hex"),
  };
}

// ---------- Release-Quellen ----------

/** Woher die Host-Dateien eines Manifests kommen (GATE-031 C-01) – gleiche Quelle wie das Manifest selbst. */
const hostFileSources = new WeakMap<ReleaseManifest, (name: HostFile) => Promise<Uint8Array | null>>();

/** Host-Datei eines Releases (ungeprüft – prüfen mit verifyHostFile); null = gibt es dort nicht. */
export function fetchHostFile(m: ReleaseManifest, name: HostFile): Promise<Uint8Array | null> {
  return hostFileSources.get(m)?.(name) ?? Promise.resolve(null);
}

/** Ordner mit je einem Unterordner pro Release (release.json + release.json.sig) – so legt `gh release download` sie ab. */
export function releasesFromDir(dir: string, key: string): ReleaseManifest[] {
  const out: ReleaseManifest[] = [];
  const dirs = [dir, ...readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))];
  for (const d of dirs) {
    const json = path.join(d, "release.json");
    if (!existsSync(json)) continue;
    const m = loadSignedManifest(readFileSync(json), readFileSync(`${json}.sig`, "utf8"), key);
    hostFileSources.set(m, async (name) => {
      const f = path.join(d, name);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    });
    out.push(m);
  }
  return out;
}

/** Anhang eines GitHub-Releases (Ausschnitt der API-Antwort) */
export interface ReleaseAsset {
  name: string;
  /** API-Adresse – mit Token auch für private Repos, zählt aber gegen das API-Limit (ohne Token 60/h je Adresse) */
  url: string;
  /** öffentlicher Download-Link (github.com/…/releases/download/…) – nur für öffentliche Repos, zählt nicht gegen das API-Limit */
  browser_download_url?: string;
}

/**
 * REPO-02: Woher ein Anhang geladen wird. Mit Token über die API (privates Repo), ohne Token über den öffentlichen
 * Download-Link – sonst kostete jede Update-Prüfung zwei API-Aufrufe je Release und stieße bei einem öffentlichen Repo
 * nach einigen Dutzend Releases an das Limit von 60 Aufrufen je Stunde. Die Bytes sind in beiden Fällen dieselben und
 * werden über das signierte Manifest geprüft.
 */
export function assetDownloadUrl(asset: ReleaseAsset, token: string | undefined): string {
  return !token && asset.browser_download_url ? asset.browser_download_url : asset.url;
}

/** GitHub-Releases (privates Repo: Token aus SCHULOS_GITHUB_TOKEN bzw. GITHUB_TOKEN). Releases ohne Manifest werden übersprungen. */
export async function releasesFromGitHub(key: string, env: Record<string, string | undefined> = process.env): Promise<ReleaseManifest[]> {
  const token = env.SCHULOS_GITHUB_TOKEN || env.GITHUB_TOKEN;
  const headers: Record<string, string> = { "user-agent": "schulosctl", accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=50`, { headers });
  if (!res.ok) throw new Error(`GitHub-Releases nicht abrufbar (${res.status})${token ? "" : " – privates Repo: SCHULOS_GITHUB_TOKEN setzen"}`);
  const list = (await res.json()) as { tag_name: string; draft: boolean; assets: ReleaseAsset[] }[];
  const out: ReleaseManifest[] = [];
  for (const r of list.filter((x) => !x.draft)) {
    const asset = (n: string) => r.assets.find((a) => a.name === n);
    const json = asset("release.json");
    const sig = asset("release.json.sig");
    if (!json || !sig) continue;
    const get = async (ra: ReleaseAsset) => {
      const a = await fetch(assetDownloadUrl(ra, token), { headers: { ...headers, accept: "application/octet-stream" } });
      if (!a.ok) throw new Error(`${r.tag_name}: Download ${a.status}`);
      return new Uint8Array(await a.arrayBuffer());
    };
    const m = loadSignedManifest(await get(json), Buffer.from(await get(sig)).toString("utf8"), key);
    hostFileSources.set(m, async (name) => {
      const a = asset(name);
      return a ? get(a) : null;
    });
    out.push(m);
  }
  return out;
}

// ---------- Schritte ----------

export interface StackDepsOptions {
  source?: string;
  log: UpdateDeps["log"];
  /** Wartezeiten (Tests verkürzen sie) */
  healthTimeoutMs?: number;
  /** so lange müssen alle Dienste nach dem Update ohne Neustart laufen */
  stableMs?: number;
}

/**
 * Alle Dienste laufen (mit Healthcheck: gesund) und keiner startet im Prüffenster neu. Fängt z. B. einen Backup-Agenten ab,
 * der sofort abstürzt – `compose up --wait` erwischt ihn sonst zwischen zwei Neustarts als „läuft“ (Update-Test B-39).
 */
export async function stackStable(s: Stack, windowMs: number): Promise<boolean> {
  const sample = async () => {
    const ids = (await s.compose(["ps", "-q"])).stdout.split(/\s+/).filter(Boolean);
    if (!ids.length) return null;
    const r = await exec("docker", ["inspect", "-f", "{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} {{.RestartCount}}", ...ids]);
    if (r.code !== 0) return null;
    return r.stdout.trim().split("\n").map((l) => {
      const [name, status, health, restarts] = l.trim().split(" ");
      return { name: name ?? "", ok: status === "running" && (health === "-" || health === "healthy"), restarts: Number(restarts) };
    });
  };
  const a = await sample();
  await sleep(windowMs);
  const b = await sample();
  if (!a || !b) return false;
  return b.every((x) => x.ok && x.restarts === (a.find((y) => y.name === x.name)?.restarts ?? x.restarts));
}

export function stackDeps(s: Stack, o: StackDepsOptions): UpdateDeps {
  const key = releaseKey();
  const updatesDir = path.join(s.dir, "updates");
  mkdirSync(updatesDir, { recursive: true });
  const timeout = o.healthTimeoutMs ?? 300_000;
  // GATE-031 (C-01): Host-Dateien aus dem Release – Manifeste merken (bekannte compose.yaml-Prüfsummen), ersetzte
  // compose.yaml des laufenden Schritts für den Rückweg
  let manifests: ReleaseManifest[] = [];
  let staged: StagedCompose | null = null;
  let current = "";
  const composeFile = path.join(s.dir, "compose.yaml");
  const files = hostFileDeps();

  return {
    now: () => new Date(),
    log: o.log,
    currentVersion: async () => {
      const info = await s.appInfo();
      if (!info) throw new Error("App antwortet nicht – erst `schulosctl status` prüfen");
      current = info.version;
      return info.version;
    },
    releases: async () => (manifests = o.source ? releasesFromDir(o.source, key) : await releasesFromGitHub(key)),
    backup: async () => {
      const r = await s.compose(["exec", "-T", "backup-agent", "node", "/opt/schulos-agent/agent.mjs", "sichern"]);
      if (r.code !== 0) {
        const last = (r.stdout + r.stderr).trim().split("\n").at(-1) ?? "";
        // „[agent] 2026-… sichern fehlgeschlagen: Nicht gekoppelt …“ → nur der Grund
        throw new Error(last.replace(/^\[agent\] \S+ sichern fehlgeschlagen: /, "").replace(/\.$/, "") || "Sicherung fehlgeschlagen");
      }
    },
    probe: (m) => probe(s, m),
    dump: async (label) => {
      const file = path.join(updatesDir, `${label}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.dump`);
      const r = await pipeFile("docker", [...s.base(), "exec", "-T", "postgres", ...PG_DUMP_APP], { out: file });
      if (r.code !== 0) throw new Error(`pg_dump: ${r.stderr.trim()}`);
      return file;
    },
    apply: async (m) => {
      const previousEnv = s.env();
      writeFileSync(s.envFile(), setEnvValues(previousEnv, imageEnvFor(m, previousEnv)), { mode: 0o600 });
      staged = null;
      const undo = () => {
        staged?.restore();
        staged = null;
        writeFileSync(s.envFile(), previousEnv, { mode: 0o600 });
      };
      try {
        const known = new Set(manifests.map((x) => x.files?.["compose.yaml"]).filter((h): h is string => !!h));
        staged = await stageCompose(files, {
          file: composeFile,
          m,
          from: current || "vorher",
          known,
          validate: async () => {
            const r = await s.compose(["config", "--quiet"]);
            return r.code === 0 ? null : (r.stderr || r.stdout).trim().split("\n").at(-1) || `Exit ${r.code}`;
          },
        });
        if (staged) o.log({ at: new Date().toISOString(), step: "compose", ok: true, to: m.version, detail: staged.note });
        // nur fehlende Images laden – nach `bundle import` liegen sie schon da (offline)
        if ((await s.composeStream(["pull", "--quiet", "--policy", "missing", "app", "backup-agent", "caddy", "postgres"])) !== 0)
          throw new Error("Images laden fehlgeschlagen");
      } catch (e) {
        // noch nichts gestartet → .env und compose.yaml wie vorher
        undo();
        throw e;
      }
      // Startet der Stack nicht, trotzdem den Rückweg ermöglichen (vorher: Abbruch ohne Rückweg, .env und – seit C-01 –
      // compose.yaml blieben auf dem neuen Stand). R-04: `started: false` → runUpdate wartet nicht noch einmal den
      // Healthcheck-Timeout ab, sondern geht sofort zurück
      const started = (await s.composeStream(["up", "-d", "--wait", "--wait-timeout", String(Math.round(timeout / 1000))])) === 0;
      return { previousEnv, started };
    },
    healthy: async (version) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const info = await s.appInfo();
        if (info?.version === version) return stackStable(s, o.stableMs ?? 20_000);
        await sleep(3000);
      }
      return false;
    },
    rollback: (previousEnv, dump) => {
      const wait = ["--wait", "--wait-timeout", String(Math.round(timeout / 1000))];
      return rollbackStack({
        restoreFiles: () => {
          writeFileSync(s.envFile(), previousEnv, { mode: 0o600 });
          staged?.restore();
          staged = null;
        },
        stopApp: async () => void (await s.compose(["stop", "app", "backup-agent"])),
        upPostgres: async () => (await s.composeStream(["up", "-d", ...wait, "postgres"])) === 0,
        restoreDump: async () => {
          const r = await pipeFile(
            "docker",
            [...s.base(), "exec", "-T", "postgres", "pg_restore", "-U", "schulos", "-d", "schulos", "--clean", "--if-exists", "--single-transaction", "--no-owner", "--no-privileges"],
            { in: dump },
          );
          return r.code === 0 ? null : r.stderr.trim().split("\n").at(-1) || `Exit ${r.code}`;
        },
        upAll: async () => (await s.composeStream(["up", "-d", ...wait])) === 0,
      });
    },
    removeDump: async (file) => rmSync(file, { force: true }),
    prepare: async () => {
      const r = await ensureDbRole(dbRoleDeps(s, timeout));
      s.forgetAdminRole();
      return r.changed ? r.detail : null;
    },
    afterStep: async (m) => {
      staged = null;
      current = m.version;
      const note = await replaceCtl(files, {
        file: path.join(s.dir, CTL_FILE),
        m,
        smoke: smokeCtl,
      });
      // das neue schulosctl stellt nach dem Update selbst um (main.ts: afterSelfUpdate)
      if (note) writeFileSync(path.join(updatesDir, CTL_RENEWED), `${m.version}\n`, { mode: 0o600 });
      return note;
    },
  };
}

/** Probestart eines neuen schulosctl (C-01): muss mit demselben Node `version` beantworten */
export async function smokeCtl(file: string): Promise<boolean> {
  const r = await exec(process.execPath, [file, "version"]);
  return r.code === 0 && r.stdout.startsWith("schulosctl ");
}

/** Schritte des Rückwegs (stackDeps.rollback), einzeln austauschbar für Tests */
export interface RollbackSteps {
  /** .env und compose.yaml der alten Fassung zurücklegen */
  restoreFiles(): void;
  stopApp(): Promise<void>;
  /** nur Postgres mit der alten Fassung starten und abwarten; false = startet nicht */
  upPostgres(): Promise<boolean>;
  /** Dump einspielen; Fehlertext oder null */
  restoreDump(): Promise<string | null>;
  /** ganzen Stack starten und abwarten; false = startet nicht */
  upAll(): Promise<boolean>;
}

/**
 * GATE-031 R-02: Rückweg nach einem misslungenen Update. Seit C-01 kann das Update die Definition von Postgres ändern –
 * kommt Postgres mit der neuen Fassung nicht hoch, scheiterte `exec postgres pg_restore`, und der alte Stack wurde nie
 * gestartet. Deshalb: Dateien zurück, Postgres zuerst mit der alten Fassung starten, dann einspielen, und den ganzen Stack
 * **immer** starten – auch wenn Postgres oder das Einspielen scheitert. Alle Fehler zusammen melden.
 */
export async function rollbackStack(st: RollbackSteps): Promise<void> {
  st.restoreFiles();
  const problems: string[] = [];
  await st.stopApp();
  if (!(await st.upPostgres())) problems.push("Postgres startet mit der alten Fassung nicht – Dump nicht eingespielt");
  else {
    const err = await st.restoreDump();
    if (err) problems.push(`pg_restore: ${err}`);
  }
  if (!(await st.upAll())) problems.push("alter Stack startet nicht");
  if (problems.length) throw new Error(problems.join("; "));
}

/** schulosctl im Installationsordner (Installer: /opt/schulos/schulosctl.mjs) */
export const CTL_FILE = "schulosctl.mjs";
/** Markierung in updates/: schulosctl wurde ersetzt, das neue soll seine Umstellungen machen */
export const CTL_RENEWED = "schulosctl-erneuert";

function hostFileDeps(): HostFileDeps {
  return {
    read: (f) => (existsSync(f) ? new Uint8Array(readFileSync(f)) : null),
    write: (f, data, mode) => writeFileSync(f, data, { mode }),
    rename: (a, b) => renameSync(a, b),
    remove: (f) => rmSync(f, { force: true }),
    fetch: fetchHostFile,
  };
}

export { HOST_FILES };

/** Image per Digest bereitstellen: vorhanden (z. B. aus dem Offline-Bundle) oder laden. */
export async function ensureImage(ref: string): Promise<void> {
  if ((await exec("docker", ["image", "inspect", "--format", "{{.Id}}", ref])).code === 0) return;
  const pull = await exec("docker", ["pull", "--quiet", ref]);
  if (pull.code !== 0) throw new Error(`Image ${ref} nicht ladbar: ${pull.stderr.trim()}`);
}

/** Probelauf mit der neuen Version auf einer Kopie der laufenden Datenbank (INSTALLATION.md §5a.3). */
export async function probe(s: Stack, m: ReleaseManifest, healthTimeoutMs = 240_000): Promise<ProbeResult> {
  await ensureImage(m.images.app);
  return runProbe(s, {
    image: m.images.app,
    version: m.version,
    healthTimeoutMs,
    // eigene, laufende Datenbank kopieren – vertrauenswürdig, darum mit dem App-Zugang (ohne Superuser-Recht, SEC-07)
    restricted: false,
    fill: async () => {
      const copy = await s.compose(["exec", "-T", "postgres", "sh", "-c", `${PG_DUMP_APP.join(" ")} | pg_restore -U ${APP_ROLE} --no-owner -d ${PROBE_DB}`]);
      if (copy.code !== 0) throw new Error(`Datenbank kopieren: ${copy.stderr.trim().split("\n").at(-1)}`);
      return {};
    },
  });
}

/**
 * Test-Restore mit App-Start (B-32, Ergänzung zu B-26): neuesten Stand vom Backupserver in die Wegwerf-Datenbank
 * (der Agent holt nur den Dump), die laufende Version darauf starten, Rauchtest, alles wieder löschen.
 * SEC-06: Der Dump kommt vom Backupserver und ist ungeprüft – Einspielen und App-Start nur mit der Wegwerf-Rolle
 * (PROBE_ROLE, ohne Superuser-Recht), nie mit dem App-Zugang.
 */
export async function testRestore(s: Stack, healthTimeoutMs = 240_000): Promise<ProbeResult> {
  const info = await s.appInfo();
  if (!info) throw new Error("App antwortet nicht – erst `schulosctl status` prüfen");
  const id = (await s.must(["ps", "-q", "app"], "App-Container")).trim();
  const image = (await exec("docker", ["inspect", "-f", "{{.Image}}", id])).stdout.trim();
  if (!image) throw new Error("Image der laufenden App nicht ermittelbar");
  return runProbe(s, {
    image,
    version: info.version,
    healthTimeoutMs,
    restricted: true,
    fill: async (probeUrl) => {
      // S-06: `docker exec -e NAME` ohne Wert übernimmt ihn aus der eigenen Umgebung – nicht in der Argumentliste (ps)
      const agent = (await s.must(["ps", "-q", "backup-agent"], "Backup-Agent")).trim();
      if (!agent) throw new Error("Backup-Agent läuft nicht");
      const r = await exec("docker", ["exec", "-e", "SCHULOS_PROBE_DATABASE_URL", agent, "node", "/opt/schulos-agent/agent.mjs", "probe-einspielen"], {
        env: { SCHULOS_PROBE_DATABASE_URL: probeUrl },
      });
      const last = (r.stdout + r.stderr).trim().split("\n").at(-1) ?? "";
      if (r.code !== 0) throw new Error(last.replace(/^\[agent\] \S+ probe-einspielen fehlgeschlagen: /, "") || "Einspielen fehlgeschlagen");
      const m = /Stand (\S+) \(([^)]+)\)/.exec(last);
      return m ? { stand: m[1], gesichert: m[2] } : {};
    },
  });
}

/**
 * Wegwerf-Instanz (INSTALLATION.md §5a.3): Datenbank `schulos_probelauf` im selben Postgres anlegen und füllen, App als
 * Container nur im internen Datenbank-Netz (kein Weg nach außen, keine Volumes, keine Jobs) starten, Migrationen beim
 * Start, Healthcheck, gemeldete Version, Rauchtest mit technischem Konto (`cli.mjs probe`). Danach Container und
 * Datenbank löschen und das Löschen prüfen (Löschnachweis).
 */
async function runProbe(
  s: Stack,
  o: {
    image: string;
    version: string;
    healthTimeoutMs: number;
    /** true: Prüfdatenbank gehört der Wegwerf-Rolle PROBE_ROLE, App und Einspielen nutzen deren Zugang (fill bekommt ihn) */
    restricted: boolean;
    fill: (probeUrl: string) => Promise<Record<string, unknown>>;
  },
): Promise<ProbeResult> {
  const network = `${await s.project()}_db`;
  // aus .env, sonst aus der Umgebung (wie docker compose selbst)
  const password = readEnvValue(s.env(), "POSTGRES_PASSWORD") ?? process.env.POSTGRES_PASSWORD;
  if (!password) throw new Error("POSTGRES_PASSWORD fehlt in .env");
  let result: Omit<ProbeResult, "deleted"> = { ok: false, details: {} };
  let probePassword = "";
  try {
    await exec("docker", ["rm", "-f", "-v", PROBE_CONTAINER]);
    let r = await s.psql("postgres", `drop database if exists ${PROBE_DB}`);
    if (r.code === 0) r = await s.psql("postgres", `drop role if exists ${PROBE_ROLE}`);
    if (o.restricted) {
      // Passwort nur hex (kein Quoting-Problem), je Lauf neu; die Rolle verschwindet am Ende wieder
      probePassword = randomBytes(24).toString("hex");
      // S-06: Passwort nicht auf die Kommandozeile – über stdin, und auch dort nur als SCRAM-Verifier
      if (r.code === 0)
        r = await s.psqlScript(
          await s.adminRole(),
          "postgres",
          [psqlSetLine("probe_pw", scramVerifier(probePassword)), `create role ${PROBE_ROLE} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'probe_pw';`, ""].join("\n"),
        );
      if (r.code === 0) r = await s.psql("postgres", `create database ${PROBE_DB} owner ${PROBE_ROLE}`);
    } else if (r.code === 0) {
      r = await s.psql("postgres", `create database ${PROBE_DB} owner ${APP_ROLE}`);
    }
    if (r.code !== 0) throw new Error(`Prüfdatenbank anlegen: ${r.stderr.trim()}`);
    const probeUrl = o.restricted
      ? `postgres://${PROBE_ROLE}:${probePassword}@postgres:5432/${PROBE_DB}`
      : `postgres://schulos:${password}@postgres:5432/${PROBE_DB}`;
    const source = await o.fill(probeUrl);

    // S-06: Geheimnisse nur über die Umgebung von docker (`-e NAME` ohne Wert), nicht in der Argumentliste (ps)
    const run = await exec(
      "docker",
      ["run", "-d", "--name", PROBE_CONTAINER, "--network", network, "-e", "DATABASE_URL", "-e", "BETTER_AUTH_URL=http://127.0.0.1:3000", "-e", "BETTER_AUTH_SECRET", "-e", "SCHULOS_JOBS=0", o.image],
      { env: { DATABASE_URL: probeUrl, BETTER_AUTH_SECRET: randomBytes(32).toString("base64url") } },
    );
    if (run.code !== 0) throw new Error(`Prüf-Container: ${run.stderr.trim()}`);
    const until = Date.now() + o.healthTimeoutMs;
    let healthy = false;
    while (Date.now() < until && !healthy) {
      const st = await exec("docker", ["inspect", "-f", "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", PROBE_CONTAINER]);
      if (st.stdout.startsWith("false")) break;
      healthy = st.stdout.trim().endsWith("healthy") && !st.stdout.includes("unhealthy");
      if (!healthy) await sleep(3000);
    }
    if (!healthy) {
      const logs = await exec("docker", ["logs", "--tail", "15", PROBE_CONTAINER]);
      throw new Error(`App startet nicht (Migrationen/Healthcheck): ${(logs.stdout + logs.stderr).trim().split("\n").slice(-3).join(" | ")}`);
    }
    const info = await exec("docker", ["exec", PROBE_CONTAINER, "node", "cli.mjs", "info"]);
    const reported = (JSON.parse(info.stdout.trim().split("\n").at(-1) || "{}") as { version?: string }).version;
    if (reported !== o.version) throw new Error(`Image meldet Version ${reported ?? "?"} statt ${o.version}`);
    const smoke = await exec("docker", ["exec", PROBE_CONTAINER, "node", "cli.mjs", "probe"]);
    const parsed = JSON.parse(smoke.stdout.trim().split("\n").at(-1) || "{}") as { ok?: boolean; error?: string; details?: Record<string, unknown> };
    result = { ok: smoke.code === 0 && parsed.ok === true, details: { version: o.version, ...source, ...(parsed.details ?? {}) }, error: parsed.error };
  } catch (e) {
    result = { ok: false, details: { version: o.version }, error: e instanceof Error ? e.message : String(e) };
  }
  // Löschen und nachweisen
  await exec("docker", ["rm", "-f", "-v", PROBE_CONTAINER]);
  await s.psql("postgres", `drop database if exists ${PROBE_DB} with (force)`);
  await s.psql("postgres", `drop role if exists ${PROBE_ROLE}`);
  const left = await s.psql(
    "postgres",
    `select (select count(*) from pg_database where datname = '${PROBE_DB}') + (select count(*) from pg_roles where rolname = '${PROBE_ROLE}')`,
  );
  const container = await exec("docker", ["ps", "-a", "-q", "--filter", `name=^${PROBE_CONTAINER}$`]);
  return {
    ...result,
    deleted: { database: left.code === 0 && left.stdout.trim() === "0", container: container.code === 0 && container.stdout.trim() === "", at: new Date().toISOString() },
  };
}
