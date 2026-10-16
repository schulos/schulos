// Einstellungen des Agenten aus der Umgebung. Der Container teilt sich Konfiguration und Dateien mit der App
// (Volumes config + files) und erreicht die Datenbank über das interne Netz.
import path from "node:path";

export type Env = Record<string, string | undefined>;

declare const AGENT_VERSION: string;
export const VERSION = typeof AGENT_VERSION === "string" ? AGENT_VERSION : "dev";

export interface AgentConfig {
  configDir: string;
  filesDir: string;
  /** postgres://… der App-Datenbank – Pflicht, PGlite-Instanzen (Demo) sichert der Agent nicht */
  databaseUrl: string | null;
  /**
   * Test-Restore (SEC-06): Zugang zur Wegwerf-Datenbank mit eigener Rolle ohne Superuser-Recht – legt schulosctl je Lauf an
   * und gibt ihn per `docker compose exec -e` mit. Ohne diesen Zugang spielt der Agent keinen Dump zur Probe ein.
   */
  probeDatabaseUrl: string | null;
  /** Arbeitsordner für den Datenbank-Dump und die CA-Datei */
  workDir: string;
  restic: string;
  /** rclone (Offsite-Wiederherstellung) */
  rclone: string;
  pgDump: string;
  pgRestore: string;
  /** Abstand der Planabfrage */
  intervalMs: number;
}

export function agentConfig(env: Env = process.env): AgentConfig {
  return {
    configDir: env.SCHULOS_CONFIG_DIR ?? "/srv/schulos/config",
    filesDir: env.FILES_DIR ?? "/srv/schulos/files",
    databaseUrl: env.DATABASE_URL?.startsWith("postgres") ? env.DATABASE_URL : null,
    probeDatabaseUrl: env.SCHULOS_PROBE_DATABASE_URL?.startsWith("postgres") ? env.SCHULOS_PROBE_DATABASE_URL : null,
    workDir: env.AGENT_WORK_DIR ?? path.join("/tmp", "schulos-agent"),
    restic: env.RESTIC_BIN ?? "restic",
    rclone: env.RCLONE_BIN ?? "rclone",
    pgDump: env.PG_DUMP_BIN ?? "pg_dump",
    pgRestore: env.PG_RESTORE_BIN ?? "pg_restore",
    intervalMs: Number(env.AGENT_INTERVAL_SECONDS ?? 60) * 1000,
  };
}

export const STATE_FILE = "backup-agent-state.json";

/** postgres://user:pass@host:port/db?sslmode=… → libpq-Umgebung für pg_dump (Passwort nie als Argument). */
export function pgEnv(databaseUrl: string): Record<string, string> {
  const u = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
  };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}
