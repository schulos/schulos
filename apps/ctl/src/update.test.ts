import { describe, expect, it } from "vitest";
import { buildManifest, type ReleaseManifest } from "@schulos/server/release";
import { formatProtocolLine, imageEnvFor, lockFromBeforeBoot, readEnvValue, runUpdate, setEnvValues, type ProtocolEntry, type UpdateDeps } from "./update";

const d64 = (c: string) => "sha256:" + c.repeat(64);
const published = new Date("2026-09-01T00:00:00Z");
function rel(version: string, upstream?: Record<string, string>): ReleaseManifest {
  return buildManifest({
    version,
    notes: { changes: [{ kind: "behoben", text: "Kleinigkeiten" }] },
    images: { app: `ghcr.io/x/schulos@${d64("a")}`, backup: `ghcr.io/x/schulos-backup@${d64("b")}`, agent: `ghcr.io/x/schulos-agent@${d64("c")}` },
    commit: "abc1234",
    publishedAt: published,
    upstream,
  });
}

function fake(over: Partial<UpdateDeps> & { version?: string; list?: ReleaseManifest[] } = {}) {
  const calls: string[] = [];
  const log: ProtocolEntry[] = [];
  let version = over.version ?? "1.4.0";
  const deps: UpdateDeps = {
    now: () => new Date("2026-10-05T02:00:00Z"),
    log: (e) => log.push(e),
    currentVersion: async () => version,
    releases: async () => over.list ?? [rel("1.4.0"), rel("1.4.1"), rel("1.5.0")],
    backup: async () => void calls.push("backup"),
    probe: async (m) => {
      calls.push(`probe ${m.version}`);
      return { ok: true, details: { tabellen: 64 }, deleted: { database: true, container: true, at: "2026-10-05T02:01:00Z" } };
    },
    dump: async (label) => (calls.push(`dump ${label}`), `/opt/schulos/updates/${label}.dump`),
    apply: async (m) => {
      calls.push(`apply ${m.version}`);
      version = m.version;
      return { previousEnv: "ALT" };
    },
    healthy: async (v) => (calls.push(`healthy ${v}`), true),
    rollback: async (env) => void calls.push(`rollback ${env}`),
    removeDump: async (f) => void calls.push(`rm ${f.split("/").at(-1)}`),
    ...over,
  };
  return { deps, calls, log, setVersion: (v: string) => (version = v) };
}

describe("schulosctl update", () => {
  it("aktuell → nichts tun", async () => {
    const f = fake({ version: "1.5.0" });
    expect(await runUpdate(f.deps, { channel: "stabil", approved: false })).toEqual({ status: "aktuell", version: "1.5.0" });
    expect(f.calls).toEqual([]);
  });

  it("Minor ohne Freigabe → nichts tun, Weg nennen", async () => {
    const f = fake();
    expect(await runUpdate(f.deps, { channel: "stabil", approved: false })).toEqual({
      status: "freigabe-noetig",
      version: "1.4.0",
      steps: ["1.5.0"],
      kind: "minor",
    });
    expect(f.calls).toEqual([]);
  });

  it("Patch ohne Freigabe: Backup, Probelauf, Dump, Update, Healthcheck, Dump weg – alles im Protokoll", async () => {
    const f = fake({ list: [rel("1.4.0"), rel("1.4.1")] });
    const r = await runUpdate(f.deps, { channel: "stabil", approved: false });
    expect(r).toEqual({ status: "fertig", from: "1.4.0", version: "1.4.1", steps: ["1.4.1"] });
    expect(f.calls).toEqual(["backup", "probe 1.4.1", "dump vor-1.4.1", "apply 1.4.1", "healthy 1.4.1", "rm vor-1.4.1.dump"]);
    expect(f.log.map((e) => `${e.step}:${e.ok}`)).toEqual([
      "plan:true",
      "backup:true",
      "probelauf:true",
      "loeschnachweis:true",
      "dump:true",
      "update:true",
      "healthcheck:true",
      "fertig:true",
    ]);
    expect(f.log[2]!.data).toEqual({ tabellen: 64 });
  });

  it("Zwischenversionen werden einzeln durchlaufen", async () => {
    const f = fake({ version: "1.3.2", list: [rel("1.4.0"), rel("1.4.1"), rel("1.5.0")] });
    const r = await runUpdate(f.deps, { channel: "stabil", approved: true });
    expect(r).toMatchObject({ status: "fertig", version: "1.5.0", steps: ["1.4.1", "1.5.0"] });
    expect(f.calls.filter((c) => c.startsWith("apply"))).toEqual(["apply 1.4.1", "apply 1.5.0"]);
    expect(f.calls.filter((c) => c === "backup")).toHaveLength(2);
  });

  it("Probelauf rot → keine Änderung an der echten Instanz, Löschnachweis trotzdem", async () => {
    const f = fake({
      probe: async () => ({ ok: false, details: {}, error: "Migration 0039 fehlgeschlagen", deleted: { database: true, container: true, at: "x" } }),
    });
    const r = await runUpdate(f.deps, { channel: "stabil", approved: true });
    expect(r).toMatchObject({ status: "fehlgeschlagen", failedAt: "probelauf", error: "Migration 0039 fehlgeschlagen", version: "1.4.0" });
    expect(f.calls).toEqual(["backup"]);
    expect(f.log.find((e) => e.step === "loeschnachweis")?.ok).toBe(true);
  });

  it("Backup schlägt fehl → Abbruch vor allem anderen", async () => {
    const f = fake({
      backup: async () => {
        throw new Error("Backupserver nicht erreichbar");
      },
    });
    expect(await runUpdate(f.deps, { channel: "stabil", approved: true })).toMatchObject({ status: "fehlgeschlagen", failedAt: "backup" });
    expect(f.log.at(-1)).toMatchObject({ step: "abbruch", ok: false });
  });

  it("neue Version nicht gesund → Rückweg mit alten Images und Dump", async () => {
    const f = fake({ list: [rel("1.4.1")] });
    f.deps.healthy = async (v) => (f.calls.push(`healthy ${v}`), v === "1.4.0");
    f.deps.rollback = async (env, dump) => {
      f.calls.push(`rollback ${env} ${dump.split("/").at(-1)}`);
      f.setVersion("1.4.0");
    };
    const r = await runUpdate(f.deps, { channel: "stabil", approved: false });
    expect(r).toMatchObject({ status: "fehlgeschlagen", failedAt: "update", rolledBack: true, version: "1.4.0" });
    expect(f.calls.slice(3)).toEqual(["apply 1.4.1", "healthy 1.4.1", "rollback ALT vor-1.4.1.dump", "healthy 1.4.0", "rm vor-1.4.1.dump"]);
    expect(f.log.find((e) => e.step === "rueckweg")).toMatchObject({ ok: true, from: "1.4.1", to: "1.4.0" });
  });

  it("GATE-031 R-04: Stack startet nicht → sofort Rückweg, kein zweites Warten auf die neue Version", async () => {
    const f = fake({ list: [rel("1.4.1")] });
    f.deps.apply = async (m) => (f.calls.push(`apply ${m.version}`), { previousEnv: "ALT", started: false });
    f.deps.healthy = async (v) => (f.calls.push(`healthy ${v}`), v === "1.4.0");
    const r = await runUpdate(f.deps, { channel: "stabil", approved: false });
    expect(r).toMatchObject({ status: "fehlgeschlagen", failedAt: "update", rolledBack: true });
    expect(f.calls.slice(3)).toEqual(["apply 1.4.1", "rollback ALT", "healthy 1.4.0", "rm vor-1.4.1.dump"]);
    expect(f.log.find((e) => e.step === "update")).toMatchObject({ ok: false });
    expect(f.log.find((e) => e.step === "healthcheck")).toMatchObject({ ok: false, detail: expect.stringContaining("startet nicht") });
  });

  it("misslungener Rückweg: Dump bleibt liegen", async () => {
    const f = fake({ list: [rel("1.4.1")], healthy: async () => false });
    const r = await runUpdate(f.deps, { channel: "stabil", approved: false });
    expect(r).toMatchObject({ status: "fehlgeschlagen", rolledBack: false });
    expect(f.calls.some((c) => c.startsWith("rm "))).toBe(false);
  });

  it("ohne Backup (Demo/Test) und blockierter Weg", async () => {
    const f = fake({ list: [rel("1.4.1")] });
    await runUpdate(f.deps, { channel: "stabil", approved: false, skipBackup: true });
    expect(f.calls[0]).toBe("probe 1.4.1");
    const g = fake({ version: "1.2.0", list: [rel("1.4.0")] });
    expect(await runUpdate(g.deps, { channel: "stabil", approved: true })).toMatchObject({ status: "blockiert" });
  });

  it("SEC-07: Umstellung der Datenbankrolle vor allem anderen, auch ohne neue Version; nur Änderungen ins Protokoll", async () => {
    const f = fake({ version: "1.5.0", prepare: async () => (f.calls.push("db-rolle"), "Wartungsrolle postgres") });
    expect(await runUpdate(f.deps, { channel: "stabil", approved: false })).toEqual({ status: "aktuell", version: "1.5.0" });
    expect(f.calls).toEqual(["db-rolle"]);
    expect(f.log).toMatchObject([{ step: "db-rolle", ok: true, detail: "Wartungsrolle postgres" }]);

    const g = fake({ prepare: async () => (g.calls.push("db-rolle"), null) });
    await runUpdate(g.deps, { channel: "stabil", approved: true });
    expect(g.calls[0]).toBe("db-rolle");
    expect(g.calls[1]).toBe("backup");
    expect(g.log.some((e) => e.step === "db-rolle")).toBe(false);
  });

  it("SEC-07: Umstellung scheitert → Update blockiert, nichts weiter", async () => {
    const f = fake({
      prepare: async () => {
        throw new Error("Rolle postgres existiert schon");
      },
    });
    expect(await runUpdate(f.deps, { channel: "stabil", approved: true })).toEqual({
      status: "blockiert",
      version: "1.4.0",
      reason: "Datenbankrolle umstellen (SEC-07): Rolle postgres existiert schon",
    });
    expect(f.calls).toEqual([]);
    expect(f.log).toMatchObject([{ step: "db-rolle", ok: false }]);
  });

  it("GATE-031 C-01: nach jedem gelungenen Schritt Host-Dateien übernehmen; Fehler nur ins Protokoll", async () => {
    const f = fake({ afterStep: async (m) => (f.calls.push(`schulosctl ${m.version}`), m.version === "1.5.0" ? "schulosctl aus 1.5.0 übernommen" : null) });
    expect(await runUpdate(f.deps, { channel: "stabil", approved: true })).toMatchObject({ status: "fertig", version: "1.5.0" });
    expect(f.calls.filter((c) => c.startsWith("schulosctl") || c.startsWith("healthy"))).toEqual(["healthy 1.5.0", "schulosctl 1.5.0"]);
    expect(f.log.filter((e) => e.step === "schulosctl")).toMatchObject([{ ok: true, to: "1.5.0", detail: "schulosctl aus 1.5.0 übernommen" }]);

    const g = fake({
      list: [rel("1.4.0"), rel("1.4.1")],
      afterStep: async () => {
        throw new Error("Prüfsumme passt nicht");
      },
    });
    expect(await runUpdate(g.deps, { channel: "stabil", approved: false })).toMatchObject({ status: "fertig", version: "1.4.1" });
    expect(g.log.at(-1)).toMatchObject({ step: "schulosctl", ok: false, detail: "Prüfsumme passt nicht" });

    // misslungenes Update → keine Host-Dateien
    const h = fake({ list: [rel("1.4.0"), rel("1.4.1")], healthy: async () => false, afterStep: async () => (h.calls.push("schulosctl"), null) });
    await runUpdate(h.deps, { channel: "stabil", approved: false });
    expect(h.calls).not.toContain("schulosctl");
  });
});

describe(".env und Images", () => {
  it("Werte lesen und setzen", () => {
    const env = "# Kommentar\nPOSTGRES_PASSWORD=geheim\nSCHULOS_IMAGE='schulos:dev'\n";
    expect(readEnvValue(env, "SCHULOS_IMAGE")).toBe("schulos:dev");
    expect(readEnvValue(env, "FEHLT")).toBeUndefined();
    expect(setEnvValues(env, { SCHULOS_IMAGE: "ghcr.io/x@sha256:1", SCHULOS_AGENT_IMAGE: "a" })).toBe(
      "# Kommentar\nPOSTGRES_PASSWORD=geheim\nSCHULOS_IMAGE=ghcr.io/x@sha256:1\nSCHULOS_AGENT_IMAGE=a\n",
    );
  });

  it("Images aus dem Manifest; PostgreSQL-Major-Wechsel abgelehnt", () => {
    const m = rel("1.4.1", { caddy: `caddy:2@${d64("d")}`, postgres: `postgres:18@${d64("e")}` });
    expect(imageEnvFor(m, "")).toEqual({
      SCHULOS_IMAGE: m.images.app,
      SCHULOS_AGENT_IMAGE: m.images.agent,
      SCHULOS_CADDY_IMAGE: `caddy:2@${d64("d")}`,
      SCHULOS_POSTGRES_IMAGE: `postgres:18@${d64("e")}`,
    });
    const m19 = rel("2.0.0", { postgres: `postgres:19@${d64("e")}` });
    expect(() => imageEnvFor(m19, `SCHULOS_POSTGRES_IMAGE=postgres:18@${d64("f")}`)).toThrow("PostgreSQL-Wechsel 18 → 19");
    expect(imageEnvFor(rel("1.4.1"), "")).toEqual({ SCHULOS_IMAGE: m.images.app, SCHULOS_AGENT_IMAGE: m.images.agent });
    // G4E-O10: Profil-Images (ClamAV, CrowdSec, step-ca) ebenfalls per Digest; ohne Digest bzw. Tag nicht übernommen
    const p = rel("1.4.2", {
      clamav: `clamav/clamav:1.5.4@${d64("1")}`,
      crowdsec: `crowdsecurity/crowdsec:v1.8.1@${d64("2")}`,
      "step-ca": `smallstep/step-ca:0.30.2@${d64("3")}`,
    });
    expect(imageEnvFor(p, "")).toMatchObject({
      SCHULOS_CLAMAV_IMAGE: `clamav/clamav:1.5.4@${d64("1")}`,
      SCHULOS_CROWDSEC_IMAGE: `crowdsecurity/crowdsec:v1.8.1@${d64("2")}`,
      SCHULOS_STEP_CA_IMAGE: `smallstep/step-ca:0.30.2@${d64("3")}`,
    });
  });

  it("Protokollzeile", () => {
    expect(formatProtocolLine({ at: "2026-10-05T02:00:00Z", step: "rueckweg", ok: true, from: "1.4.1", to: "1.4.0", detail: "alte Version läuft wieder" })).toBe(
      "2026-10-05T02:00:00Z ✓ rueckweg 1.4.1 → 1.4.0 – alte Version läuft wieder",
    );
  });
});

describe("Update-Sperre", () => {
  it("gilt als verwaist, wenn sie vor dem letzten Start angelegt wurde", () => {
    const now = Date.parse("2026-10-06T03:00:00Z");
    // läuft seit 10 min: Sperre von vor 20 min stammt aus dem alten Start (Neustart unter Sperre, Rückweg)
    expect(lockFromBeforeBoot(now - 20 * 60_000, now, 600)).toBe(true);
    // Sperre nach dem Start angelegt → gehalten
    expect(lockFromBeforeBoot(now - 5 * 60_000, now, 600)).toBe(false);
    // knapp um den Start herum (Uhrabweichung): lieber behalten
    expect(lockFromBeforeBoot(now - 10 * 60_000 - 30_000, now, 600)).toBe(false);
  });
});
