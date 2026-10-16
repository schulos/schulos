// schulosctl update (B-32, INSTALLATION.md §5a.2/§5a.3): Ablauf als reine Steuerung mit austauschbaren Schritten.
// Je Release-Schritt (Zwischenversionen über planUpdate): Backup → Probelauf auf einer Kopie (Migrationen, Healthcheck,
// Rauchtest mit technischem Konto, Löschnachweis) → Datenbank-Dump für den Rückweg → Update → Healthcheck →
// bei Fehler zurück (alte Images + Datenbankstand von vor dem Update) → Dump löschen. Jeder Schritt landet im Protokoll.
import { planUpdate, profileImageEnv, updateKind, type Channel, type ReleaseManifest, type UpdateKind } from "@schulos/server/release";
import type { ProtocolEntry } from "@schulos/server/system";

export type { ProtocolEntry };

export interface ProbeResult {
  ok: boolean;
  /** Kennzahlen des Rauchtests (Tabellen, Migrationen, geprüfte Seiten …) */
  details: Record<string, unknown>;
  error?: string;
  /** Löschnachweis: Kopie (Datenbank + Container) nach dem Probelauf entfernt */
  deleted: { database: boolean; container: boolean; at: string };
}

export interface UpdateDeps {
  now(): Date;
  log(entry: ProtocolEntry): void;
  currentVersion(): Promise<string>;
  /** signaturgeprüfte Manifeste */
  releases(): Promise<ReleaseManifest[]>;
  backup(): Promise<void>;
  probe(m: ReleaseManifest): Promise<ProbeResult>;
  /** Dump der laufenden Datenbank für den Rückweg; Rückgabe: Ort */
  dump(label: string): Promise<string>;
  /** started: false = `up --wait` schlug fehl (GATE-031 R-04: dann kein zweites Warten auf den Healthcheck) */
  apply(m: ReleaseManifest): Promise<{ previousEnv: string; started?: boolean }>;
  /** wartet, bis die App mit genau dieser Version gesund ist */
  healthy(version: string): Promise<boolean>;
  rollback(previousEnv: string, dump: string): Promise<void>;
  removeDump(dump: string): Promise<void>;
  /**
   * Einmalige Umstellungen am laufenden Stack vor dem Plan (SEC-07: App-Datenbankrolle ohne Superuser), idempotent.
   * Rückgabe: Protokolltext, wenn sich etwas geändert hat, sonst null; Fehler → Update blockiert.
   */
  prepare?(): Promise<string | null>;
  /**
   * Nach einem gelungenen Schritt (GATE-031 C-01): Host-Dateien des Releases übernehmen (schulosctl selbst). Rückgabe:
   * Protokolltext bzw. null; ein Fehler macht das Update nicht rückgängig (die neue Version läuft schon), steht aber im Protokoll.
   */
  afterStep?(m: ReleaseManifest): Promise<string | null>;
}

export interface UpdateOptions {
  channel: Channel;
  /** Freigabe für Minor/Major (Admin hat zugestimmt); Patches brauchen keine */
  approved: boolean;
  /** nur zum Testen bzw. Demo: ohne Sicherung vorher */
  skipBackup?: boolean;
}

export type UpdateOutcome =
  | { status: "aktuell"; version: string }
  | { status: "freigabe-noetig"; version: string; steps: string[]; kind: UpdateKind }
  | { status: "blockiert"; version: string; reason: string }
  | { status: "fertig"; from: string; version: string; steps: string[] }
  | { status: "fehlgeschlagen"; from: string; version: string; failedAt: string; error: string; rolledBack: boolean };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runUpdate(d: UpdateDeps, opts: UpdateOptions): Promise<UpdateOutcome> {
  const at = () => d.now().toISOString();
  const start = await d.currentVersion();
  if (d.prepare) {
    try {
      const note = await d.prepare();
      if (note) d.log({ at: at(), step: "db-rolle", ok: true, detail: note });
    } catch (e) {
      d.log({ at: at(), step: "db-rolle", ok: false, detail: msg(e) });
      return { status: "blockiert", version: start, reason: `Datenbankrolle umstellen (SEC-07): ${msg(e)}` };
    }
  }
  const plan = planUpdate(start, await d.releases(), opts.channel, d.now());
  if (plan.status === "aktuell") return { status: "aktuell", version: start };
  if (plan.status === "blockiert") {
    d.log({ at: at(), step: "plan", ok: false, from: start, detail: plan.reason });
    return { status: "blockiert", version: start, reason: plan.reason };
  }
  const steps = plan.steps.map((s) => s.version);
  if (plan.kind !== "patch" && !opts.approved) return { status: "freigabe-noetig", version: start, steps, kind: plan.kind };
  d.log({ at: at(), step: "plan", ok: true, from: start, to: steps.at(-1), detail: `Weg: ${[start, ...steps].join(" → ")} (${plan.kind})` });

  let current = start;
  for (const m of plan.steps) {
    const fail = (failedAt: string, error: string, rolledBack = false): UpdateOutcome => {
      d.log({ at: at(), step: "abbruch", ok: false, from: current, to: m.version, detail: `${failedAt}: ${error}` });
      return { status: "fehlgeschlagen", from: start, version: current, failedAt, error, rolledBack };
    };
    const kind = updateKind(current, m.version);

    if (!opts.skipBackup) {
      try {
        await d.backup();
        d.log({ at: at(), step: "backup", ok: true, from: current, to: m.version });
      } catch (e) {
        d.log({ at: at(), step: "backup", ok: false, from: current, to: m.version, detail: msg(e) });
        return fail("backup", msg(e));
      }
    }

    let probe: ProbeResult;
    try {
      probe = await d.probe(m);
    } catch (e) {
      probe = { ok: false, details: {}, error: msg(e), deleted: { database: false, container: false, at: at() } };
    }
    d.log({ at: at(), step: "probelauf", ok: probe.ok, from: current, to: m.version, detail: probe.error, data: probe.details });
    const deletedOk = probe.deleted.database && probe.deleted.container;
    d.log({
      at: probe.deleted.at,
      step: "loeschnachweis",
      ok: deletedOk,
      to: m.version,
      detail: deletedOk ? "Kopie der Datenbank und Probelauf-Container entfernt" : "Kopie nicht vollständig entfernt – von Hand prüfen",
      data: probe.deleted,
    });
    if (!probe.ok) return fail("probelauf", probe.error ?? "Probelauf fehlgeschlagen");

    let dump: string;
    try {
      dump = await d.dump(`vor-${m.version}`);
      d.log({ at: at(), step: "dump", ok: true, from: current, to: m.version, detail: dump });
    } catch (e) {
      return fail("dump", msg(e));
    }

    let previousEnv: string | null = null;
    let ok = false;
    let error = "";
    try {
      const applied = await d.apply(m);
      previousEnv = applied.previousEnv;
      if (applied.started === false) {
        d.log({ at: at(), step: "update", ok: false, from: current, to: m.version, detail: `${kind} – Stack startet nicht, Rückweg folgt` });
        error = `SchulOS ${m.version} startet nicht (docker compose up)`;
      } else {
        d.log({ at: at(), step: "update", ok: true, from: current, to: m.version, detail: kind });
        ok = await d.healthy(m.version);
        if (!ok) error = `SchulOS ${m.version} läuft nicht stabil (App oder ein Dienst startet nicht)`;
      }
    } catch (e) {
      error = msg(e);
    }
    d.log({ at: at(), step: "healthcheck", ok, to: m.version, detail: ok ? undefined : error });

    if (!ok) {
      let rolledBack = false;
      if (previousEnv !== null) {
        try {
          await d.rollback(previousEnv, dump);
          rolledBack = await d.healthy(current);
          d.log({ at: at(), step: "rueckweg", ok: rolledBack, from: m.version, to: current, detail: rolledBack ? "alte Version läuft wieder" : "alte Version nicht gesund" });
        } catch (e) {
          d.log({ at: at(), step: "rueckweg", ok: false, from: m.version, to: current, detail: msg(e) });
        }
      }
      // Dump bleibt bei misslungenem Rückweg liegen (wird gebraucht), sonst weg
      if (rolledBack) await d.removeDump(dump).catch(() => undefined);
      return fail("update", error, rolledBack);
    }
    await d.removeDump(dump);
    d.log({ at: at(), step: "fertig", ok: true, from: current, to: m.version, detail: "Sicherungs-Dump gelöscht" });
    current = m.version;
    if (d.afterStep) {
      try {
        const note = await d.afterStep(m);
        if (note) d.log({ at: at(), step: "schulosctl", ok: true, to: m.version, detail: note });
      } catch (e) {
        d.log({ at: at(), step: "schulosctl", ok: false, to: m.version, detail: msg(e) });
      }
    }
  }
  return { status: "fertig", from: start, version: current, steps };
}

// ---------- .env des Stacks ----------

/** Wert einer Variable aus einer .env-Datei (ohne Anführungszeichen), sonst undefined. */
export function readEnvValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m?.[1] === key) return m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

/** Setzt Variablen in einer .env-Datei: vorhandene Zeilen ersetzen, neue anhängen; Kommentare bleiben. */
export function setEnvValues(text: string, values: Record<string, string>): string {
  const rest = new Map(Object.entries(values));
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && rest.has(m[1]!)) {
      const v = rest.get(m[1]!)!;
      rest.delete(m[1]!);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of rest) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

const DEFAULT_POSTGRES = "postgres:18";

/** Image-Variablen für compose.yaml aus dem Manifest. Ein PostgreSQL-Major-Wechsel braucht pg_upgrade → abgelehnt. */
export function imageEnvFor(m: ReleaseManifest, currentEnv: string): Record<string, string> {
  const env: Record<string, string> = { SCHULOS_IMAGE: m.images.app, SCHULOS_AGENT_IMAGE: m.images.agent };
  if (m.upstream?.caddy) env.SCHULOS_CADDY_IMAGE = m.upstream.caddy;
  // G4E-O10: auch die Profil-Images (ClamAV, CrowdSec, step-ca) per Digest – wer ein Profil einschaltet, bekommt genau dieses Image
  Object.assign(env, profileImageEnv(m));
  if (m.upstream?.postgres) {
    const tag = (ref: string) => ref.split("@")[0]!.split(":")[1] ?? "latest";
    const major = (ref: string) => tag(ref).split(/[.-]/)[0];
    const now = readEnvValue(currentEnv, "SCHULOS_POSTGRES_IMAGE") ?? DEFAULT_POSTGRES;
    if (major(now) !== major(m.upstream.postgres))
      throw new Error(`PostgreSQL-Wechsel ${tag(now)} → ${tag(m.upstream.postgres)} braucht ein Datenbank-Upgrade – noch nicht unterstützt`);
    env.SCHULOS_POSTGRES_IMAGE = m.upstream.postgres;
  }
  return env;
}

export function formatProtocolLine(e: ProtocolEntry): string {
  const ver = e.from && e.to ? ` ${e.from} → ${e.to}` : e.to ? ` ${e.to}` : "";
  return `${e.at} ${e.ok ? "✓" : "✗"} ${e.step}${ver}${e.detail ? ` – ${e.detail}` : ""}`;
}

/** Update-Sperre älter als der laufende Start (mtime vor Startzeit = jetzt − uptime)? 60 s Spielraum für Uhrabweichungen. */
export function lockFromBeforeBoot(lockMtimeMs: number, nowMs: number, uptimeSec: number): boolean {
  return lockMtimeMs < nowMs - uptimeSec * 1000 - 60_000;
}
