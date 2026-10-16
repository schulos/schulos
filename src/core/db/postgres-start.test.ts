import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// B-51: das Startskript für Postgres steht als `configs: postgres-start` in compose.yaml ($$ = $ für Compose)
function startScript(name = "postgres-start"): string {
  const lines = readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8").split("\n");
  const at = lines.findIndex((l) => l === `  ${name}:`);
  if (at < 0 || lines[at + 1] !== "    content: |") throw new Error(`configs.${name} fehlt in compose.yaml`);
  const body: string[] = [];
  for (const l of lines.slice(at + 2)) {
    if (l !== "" && !l.startsWith("      ")) break;
    body.push(l.slice(6));
  }
  return body.join("\n").replaceAll("$$", "$");
}

const sh = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
const hasSh = sh.status === 0 && sh.stdout.trim() === "ok";

function args(env: Record<string, string>): Record<string, string> {
  const r = spawnSync("sh", ["-c", startScript()], { encoding: "utf8", env: { ...process.env, SCHULOS_PG_DRY_RUN: "1", ...env } });
  expect(r.status, r.stderr).toBe(0);
  const out = r.stdout.trim().split(/\s+/);
  expect(out[0]).toBe("postgres");
  return Object.fromEntries(out.filter((_, i) => out[i - 1] === "-c").map((kv) => kv.split("=") as [string, string]));
}

describe.skipIf(!hasSh)("Postgres-Startskript (compose.yaml)", () => {
  it("richtet die Speicher-Einstellungen nach dem RAM aus", () => {
    expect(args({ SCHULOS_PG_MEMTOTAL_KB: String(4 * 1024 * 1024) })).toMatchObject({
      shared_buffers: "819MB",
      effective_cache_size: "2048MB",
      work_mem: "16MB",
      maintenance_work_mem: "256MB",
      shared_preload_libraries: "pg_stat_statements",
    });
    expect(args({ SCHULOS_PG_MEMTOTAL_KB: String(64 * 1024 * 1024) })).toMatchObject({
      shared_buffers: "4096MB",
      effective_cache_size: "32768MB",
      work_mem: "32MB",
      maintenance_work_mem: "1024MB",
    });
    expect(args({ SCHULOS_PG_MEMTOTAL_KB: String(1024 * 1024) })).toMatchObject({
      shared_buffers: "204MB",
      effective_cache_size: "512MB",
      work_mem: "4MB",
      maintenance_work_mem: "64MB",
    });
  });

  it("nimmt feste Werte aus der Umgebung, leere Werte zählen nicht", () => {
    const a = args({ SCHULOS_PG_MEMTOTAL_KB: String(8 * 1024 * 1024), SCHULOS_PG_SHARED_BUFFERS: "2GB", SCHULOS_PG_WORK_MEM: "" });
    expect(a.shared_buffers).toBe("2GB");
    expect(a.work_mem).toBe("32MB");
  });
});

// SEC-07: Init-Skript (configs: postgres-init) – mit einem Ersatz-psql ausgeführt, das Argumente und stdin mitschreibt
describe.skipIf(!hasSh)("Postgres-Init-Skript (compose.yaml, SEC-07)", () => {
  it("legt schulos ohne Superuser-Recht als Eigentümerin an und richtet pg_stat_statements als Wartungsrolle ein", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sec07-"));
    try {
      writeFileSync(path.join(dir, "psql"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir.replaceAll("\\", "/")}/args"\ncat > "${dir.replaceAll("\\", "/")}/sql"\n`, { mode: 0o755 });
      const r = spawnSync("sh", ["-c", `PATH="$(cd '${dir.replaceAll("\\", "/")}' && pwd):$PATH"; ${startScript("postgres-init")}`], {
        encoding: "utf8",
        env: { ...process.env, POSTGRES_USER: "postgres", POSTGRES_DB: "schulos", SCHULOS_DB_PASSWORD: "app-pw'x" },
      });
      expect(r.status, r.stderr).toBe(0);
      const args = readFileSync(path.join(dir, "args"), "utf8").trim().split("\n");
      // GATE-031 S-03: Passwort nicht in der Argumentliste, psql liest es per \getenv; Statistik beim CREATE ROLE aus
      expect(args).toEqual(["-v", "ON_ERROR_STOP=1", "--username", "postgres", "--dbname", "schulos"]);
      expect(args.join(" ")).not.toContain("app-pw");
      const sql = readFileSync(path.join(dir, "sql"), "utf8");
      expect(sql).toContain("create role schulos login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'app_pw';");
      expect(sql).toContain("alter database schulos owner to schulos;");
      expect(sql).toContain("create extension if not exists pg_stat_statements;");
      const lines = sql.split("\n");
      expect(lines.indexOf("set pg_stat_statements.track = 'none';")).toBeLessThan(lines.findIndex((l) => l.startsWith("create role")));
      expect(lines.indexOf("\\getenv app_pw SCHULOS_DB_PASSWORD")).toBeLessThan(lines.findIndex((l) => l.startsWith("create role")));
      // Passwort nur als psql-Variable (:'app_pw' quotet sicher), nie im SQL-Text
      expect(sql).not.toContain("app-pw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Compose: Wartungsrolle als POSTGRES_USER, App-Passwort getrennt, Healthcheck über TCP", () => {
    const compose = readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8");
    expect(compose).toContain("      POSTGRES_USER: postgres\n");
    expect(compose).toContain("      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD:-}\n");
    expect(compose).toContain("      SCHULOS_DB_PASSWORD: ${POSTGRES_PASSWORD:?");
    expect(compose).toContain("target: /docker-entrypoint-initdb.d/10-schulos-rolle.sh");
    expect(compose).toContain('"pg_isready -h 127.0.0.1 -U schulos -d schulos"');
    // App und Agent melden sich als schulos an, nie als Wartungsrolle
    expect(compose.match(/DATABASE_URL: postgres:\/\/[^:]+:/g)).toEqual(["DATABASE_URL: postgres://schulos:", "DATABASE_URL: postgres://schulos:"]);
  });
});
