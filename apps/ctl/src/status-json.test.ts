import { createServer } from "node:https";
import { describe, expect, it } from "vitest";
import { emptyAgentState } from "@schulos/server/agent-api";
import { healthExitCode, overallLevel } from "@schulos/server/system";
import { parseArgs, statusReport, type StatusInput } from "./core";
import { parseValidTo, probeTlsExpiry, tlsTargetFromEnv } from "./tls-probe";
import { buildStatus } from "./system-sync";

const now = new Date("2026-10-05T10:00:00Z");
const services = ["app", "caddy", "db"].map((service) => ({ service, state: "running", health: service === "caddy" ? "" : "healthy" }));
const app = { version: "1.4.2", instance: "production", database: "postgres", migrations: 38, accounts: { admin: 1, lehrkraft: 20 } };
const backup = {
  ...emptyAgentState("i1"),
  lastOkAt: "2026-10-05T00:31:00Z",
  lastRun: { trigger: "zeitplan" as const, status: "ok" as const, startedAt: "x", finishedAt: "2026-10-05T00:31:00Z" },
};
const good: StatusInput = { services, app, backup, disk: { usedPercent: 41, freeBytes: 1e11 }, now, tls: { expiresAt: "2027-01-01T00:00:00Z" } };

describe("schulosctl status --json (BM-03)", () => {
  it("--json wird erkannt, ohne bleibt der Text", () => {
    expect(parseArgs(["status", "--json"]).command).toEqual({ name: "status", json: true });
    expect(parseArgs(["--json", "status", "--dir", "/x"])).toEqual({ dir: "/x", command: { name: "status", json: true } });
    expect(parseArgs(["status"]).command).toEqual({ name: "status", json: false });
  });

  it("alles in Ordnung → Stufe ok, Exit-Code 0", () => {
    const r = statusReport(good);
    expect(r).toMatchObject({ version: 1, level: "ok", exitCode: 0, problems: [], app: { version: "1.4.2", accounts: 21 }, disk: { usedPercent: 41 }, tls: { daysLeft: 87 }, exposure: null });
    expect(r.services).toHaveLength(3);
    expect(r.backup).toMatchObject({ paired: true, health: "ok", lastOkAt: "2026-10-05T00:31:00Z" });
  });

  it("Warnung (Backup nicht gekoppelt, Platte 92 %, Zertifikat in 10 Tagen) → Exit-Code 1", () => {
    const r = statusReport({ ...good, backup: null, disk: { usedPercent: 92, freeBytes: 1e9 }, tls: { expiresAt: "2026-10-15T10:00:00Z" } });
    expect(r.exitCode).toBe(1);
    expect(r.level).toBe("warn");
    expect(r.problems.map((p) => `${p.level}:${p.key}`)).toEqual(["warn:backup:fehlt", "warn:platz", "warn:zertifikat"]);
    expect(r.backup).toBeNull();
  });

  it("Fehler (Dienst down, App antwortet nicht, Backup überfällig, Zertifikat abgelaufen) → Exit-Code 2", () => {
    const down = [...services.slice(0, 2), { service: "db", state: "exited", health: "" }];
    expect(statusReport({ ...good, services: down }).exitCode).toBe(2);
    expect(statusReport({ ...good, app: null }).exitCode).toBe(2);
    expect(statusReport({ ...good, services: [] }).problems[0]).toMatchObject({ level: "error", key: "dienste" });
    const old = { ...backup, lastOkAt: "2026-10-01T00:31:00Z" };
    expect(statusReport({ ...good, backup: old }).problems).toEqual([{ level: "error", key: "backup", text: "Backup überfällig" }]);
    expect(statusReport({ ...good, tls: { expiresAt: "2026-10-01T00:00:00Z" } }).exitCode).toBe(2);
    expect(statusReport({ ...good, disk: { usedPercent: 99, freeBytes: 1 } }).exitCode).toBe(2);
  });

  it("Text-Status kennt dieselben Befunde (Exit 0/1 wie bisher) und zeigt das Zertifikat", async () => {
    const { formatStatus } = await import("./core");
    const r = formatStatus({ ...good, tls: { expiresAt: "2026-10-12T00:00:00Z" } });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("Zertifikat: ✗ gültig bis");
    expect(r.lines[0]).toBe("Zustand: ACHTUNG – Zertifikat läuft in 6 Tagen ab");
  });

  it("Stufen und Exit-Codes", () => {
    expect(overallLevel([])).toBe("ok");
    expect(overallLevel([{ level: "warn" }])).toBe("warn");
    expect(overallLevel([{ level: "warn" }, { level: "error" }])).toBe("error");
    expect([healthExitCode("ok"), healthExitCode("warn"), healthExitCode("error")]).toEqual([0, 1, 2]);
  });

  it("Ausgabe enthält keine Geheimnisse: Fehlertext des Backupservers wird geschwärzt", () => {
    const r = statusReport({ ...good, backup: { ...backup, lastContactError: "Verbindung zu admin@schule.de abgelehnt" } });
    expect(JSON.stringify(r)).not.toContain("admin@schule.de");
  });
});

describe("Zertifikatsablauf (BM-04)", () => {
  it("Ziel aus der .env, Vorgaben localhost:443", () => {
    expect(tlsTargetFromEnv({})).toEqual({ host: "127.0.0.1", port: 443, servername: "localhost" });
    expect(tlsTargetFromEnv({ SCHULOS_DOMAIN: "schulos.schule.local", SCHULOS_HTTPS_PORT: "8443" })).toEqual({ host: "127.0.0.1", port: 8443, servername: "schulos.schule.local" });
    expect(tlsTargetFromEnv({ SCHULOS_HTTPS_PORT: "abc" }).port).toBe(443);
  });

  it("valid_to → ISO; Unsinn → null", () => {
    expect(parseValidTo("Jan  1 00:00:00 2027 GMT")).toBe("2027-01-01T00:00:00.000Z");
    expect(parseValidTo("kaputt")).toBeNull();
    expect(parseValidTo(undefined)).toBeNull();
  });

  it("nicht erreichbar → null (kein Fehler)", async () => {
    expect(await probeTlsExpiry({ host: "127.0.0.1", port: 1, servername: "localhost" }, false, 500)).toBeNull();
  });

  it("liest das Ablaufdatum eines echten Handshakes", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const key = "../../../packages/server/test-fixtures";
    const dir = new URL(`${key}/`, import.meta.url);
    const files = ["localhost.key", "localhost.pem"].map((f) => new URL(f, dir));
    expect(files.every((f) => existsSync(f))).toBe(true);
    const srv = createServer({ key: readFileSync(files[0]!), cert: readFileSync(files[1]!) }, (_q, res) => res.end("ok"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      const r = await probeTlsExpiry({ host: "127.0.0.1", port, servername: "localhost" }, true, 3000);
      expect(r?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // CA-08: Ausstellung, Modus und Vertrauen (Testzertifikat → nicht öffentlich vertrauenswürdig)
      expect(r?.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r).toMatchObject({ acme: true, trusted: false });
    } finally {
      srv.close();
    }
  });

  it("Systemstatus des Hosts trägt das Zertifikat (fehlend → null)", () => {
    const base = { now, current: "1.4.2", channel: "stabil" as const, plan: null, approved: null, protocol: [], os: null };
    expect(buildStatus({ ...base, tls: { expiresAt: "2027-01-01T00:00:00.000Z" } }).tls).toEqual({ expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(buildStatus(base).tls).toBeNull();
  });
});
