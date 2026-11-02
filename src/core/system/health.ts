// BM-01: Betriebsstatus des Hauptsystems als Kennzahlen ohne Personenbezug (docs/BETRIEBSMONITORING.md): Datenbank, Mail-Ausgang,
// Hintergrundjobs, Sicherung, Speicherplatz, Zertifikat, Updates. Bündelt vorhandene Quellen – nichts davon wird neu erhoben.
// Fehlertexte laufen durch `scrubError`; keine Namen, Konten, Adressen, Tokens.
import { sql } from "drizzle-orm";
import { immutableHealth } from "@schulos/server/agent-api";
import { DISK_WARN_PERCENT } from "@schulos/server/mail";
import { daysUntil, hostProblems, overallLevel, rebootPendingDays, REBOOT_RED_DAYS, type HealthProblem, type HealthReport, type SystemStatus } from "@schulos/server/system";
import type { BackupStatus } from "@/core/backup/status";
import type { Db } from "@/core/db/client";
import { systemJobs } from "@/core/db/schema";
import { mailAvailable, outboxStats, scrubError, type OutboxStats } from "@/core/mail";
import { DEFAULT_HEALTH_SETTINGS, type HealthSettings } from "./health-settings";
import { statusIsStale } from "./status";

export interface HealthInput {
  system: SystemStatus | null;
  backup: BackupStatus;
  settings?: HealthSettings;
  now?: Date;
  version?: string;
  mailConfigured?: boolean;
  /** für Tests: Mail-Kennzahlen vorgeben statt aus der Datenbank */
  outbox?: OutboxStats;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Datenbank erreichbar? Antwortzeit in ms; bei Fehler `ok: false` (der Text geht nur ins Serverlog, nicht in den Bericht). */
async function databaseProbe(db: Db): Promise<HealthReport["database"]> {
  const t0 = performance.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch (err) {
    console.error("[health]", scrubError(err));
    return { ok: false, latencyMs: null };
  }
}

export async function collectHealth(db: Db, input: HealthInput): Promise<HealthReport> {
  const now = input.now ?? new Date();
  const settings = input.settings ?? DEFAULT_HEALTH_SETTINGS;
  const problems: HealthProblem[] = [];
  const add = (level: "warn" | "error", key: string, text: string) => problems.push({ level, key, text });

  const database = await databaseProbe(db);
  if (!database.ok) add("error", "datenbank", "Datenbank antwortet nicht");

  let ob: OutboxStats = input.outbox ?? { pending: 0, sent: 0, failed: 0, oldestPending: null };
  let jobs: HealthReport["jobs"] = [];
  if (database.ok) {
    if (!input.outbox) ob = await outboxStats(db);
    jobs = (await db.select().from(systemJobs).orderBy(systemJobs.name)).map((j) => ({
      name: j.name,
      lastStartedAt: iso(j.lastStartedAt),
      lastFinishedAt: iso(j.lastFinishedAt),
      status: j.lastStatus === "ok" || j.lastStatus === "failed" ? j.lastStatus : null,
      error: j.lastError ? scrubError(j.lastError) : null,
    }));
  }
  const oldestMin = ob.oldestPending ? Math.max(0, Math.floor((now.getTime() - ob.oldestPending.getTime()) / 60_000)) : null;
  if (oldestMin !== null && oldestMin >= settings.mailBacklogMinutes) add("warn", "mail:stau", `Mail-Stau: ${ob.pending} Mails warten, die älteste seit ${oldestMin} Minuten`);
  if (ob.failed > 0) add("warn", "mail:fehlgeschlagen", `${ob.failed} Mails endgültig fehlgeschlagen`);
  for (const j of jobs) if (j.status === "failed") add("warn", `job:${j.name}`, `Job ${j.name}: letzter Lauf fehlgeschlagen`);

  const b = input.backup;
  const ageHours = b.lastOkAt ? Math.round(((now.getTime() - b.lastOkAt.getTime()) / 3_600_000) * 10) / 10 : null;
  if (!b.paired) add("warn", "backup:fehlt", "Keine Sicherung eingerichtet");
  else if (b.health === "failed") add("error", "backup", "Letzte Sicherung fehlgeschlagen");
  else if (b.health === "overdue") add("error", "backup", "Sicherung überfällig");
  else if (b.health === "ok" && ageHours !== null && ageHours > settings.backupMaxHours) add("warn", "backup:alt", `Letzte gute Sicherung ist ${ageHours} Stunden alt`);
  const offsite = b.paired ? immutableHealth(b.immutable ?? null, now) : "aus";
  if (offsite === "veraltet" || offsite === "fehlt") add("warn", "unveraenderlich", `Unveränderliche Kopie ${offsite}`);

  const s = input.system;
  const tls = s?.tls ? { expiresAt: s.tls.expiresAt, daysLeft: daysUntil(s.tls.expiresAt, now) } : null;
  problems.push(...hostProblems({ disk: s?.disk, tls: s?.tls, diskWarnPercent: DISK_WARN_PERCENT, now }));
  let host: HealthReport["host"] = null;
  if (s) {
    const stale = statusIsStale(s, now);
    if (stale) add("warn", "abgleich", "Abgleich mit dem Host läuft nicht");
    const days = s.reboot ? rebootPendingDays(s.reboot, now) : null;
    if (s.reboot) add(days !== null && days >= REBOOT_RED_DAYS ? "error" : "warn", "neustart", "Neustart ausstehend (Passphrase nötig)");
    const lastDone = s.protocol.find((e) => e.step === "fertig" || e.step === "abbruch");
    if (lastDone?.step === "abbruch" && now.getTime() - Date.parse(lastDone.at) < 48 * 3_600_000) add("warn", "update", "Letztes Update fehlgeschlagen");
    host = { checkedAt: s.checkedAt, stale, update: s.update?.status ?? null, rebootPending: Boolean(s.reboot), rebootDays: days };
  }

  return {
    version: 1,
    checkedAt: now.toISOString(),
    level: overallLevel(problems),
    problems,
    app: { version: input.version ?? process.env.SCHULOS_VERSION ?? "dev", channel: s?.channel ?? null },
    database,
    mail: { configured: input.mailConfigured ?? mailAvailable(), pending: ob.pending, failed: ob.failed, oldestPendingMinutes: oldestMin },
    jobs,
    backup: { paired: b.paired, health: b.health, lastOkAt: iso(b.lastOkAt), ageHours, offsite, offsiteLastAt: b.immutable?.lastAt ?? null },
    disk: s?.disk ?? null,
    tls,
    host,
  };
}
