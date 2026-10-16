// Wartung auf dem Backupserver: Zeitplan und Aufbewahrung je Instanz, Aufräumen (forget + prune) täglich bzw. auf Knopfdruck.
import { and, desc, eq, isNull } from "drizzle-orm";
import { berlinStamp } from "@schulos/server/agent-api";
import { audit } from "@/audit";
import type { Db } from "@/db/client";
import { instances, maintenanceRuns, type Instance } from "@/db/schema";
import { repoPassword } from "@/pairing/service";
import { check, forgetAndPrune, type LocalRestic } from "@/restic/local";
import { runRestoreTest, type RestoreTestContext } from "./restore-test";
import { offsiteCopy, type OffsiteConfig } from "./offsite";
import { checkImmutable, type SnapshotConfig } from "./immutable";
import type { Retention } from "@schulos/server/backup-retention";

export type MaintenanceKind = "prune" | "check" | "restore_test" | "offsite" | "immutable";

/** Uhrzeit des täglichen Aufräumens (Europe/Berlin) – weit weg vom Sicherungstermin (Vorgabe 01:30). */
export function pruneTime(env: Record<string, string | undefined> = process.env): string {
  const t = env.SCHULOS_PRUNE_TIME ?? "14:00";
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : "14:00";
}

export async function updateSchedule(db: Db, actorId: string, id: string, schedule: string[]): Promise<void> {
  await db.update(instances).set({ schedule }).where(eq(instances.id, id));
  await audit(db, actorId, "instanz.zeitplan", id, { uhrzeiten: schedule });
}

export async function updateRetention(db: Db, actorId: string, id: string, retention: Retention, reason: string | null): Promise<void> {
  await db.update(instances).set({ retention, retentionReason: reason }).where(eq(instances.id, id));
  await audit(db, actorId, "instanz.aufbewahrung", id, { ...retention, begruendung: reason });
}

async function record(db: Db, inst: Instance, kind: MaintenanceKind, startedAt: Date, finishedAt: Date, res: { details?: Record<string, unknown>; error?: string }, actorId: string | null) {
  await db.insert(maintenanceRuns).values({
    id: crypto.randomUUID(),
    instanceId: inst.id,
    kind,
    status: res.error ? "failed" : "ok",
    startedAt,
    finishedAt,
    details: res.details ?? null,
    error: res.error?.slice(0, 500) ?? null,
    triggeredBy: actorId,
  });
}

/** Aufräumen einer Instanz; das Ergebnis steht in maintenance_runs (auch Fehler). */
export async function runPrune(db: Db, inst: Instance, ctx: LocalRestic, appSecret: string, actorId: string | null, now = () => new Date()) {
  const startedAt = now();
  try {
    const r = await forgetAndPrune(ctx, inst.restUser, repoPassword(inst, appSecret), inst.retention);
    await record(db, inst, "prune", startedAt, now(), { details: { behalten: r.kept, entfernt: r.removed } }, actorId);
    if (actorId) await audit(db, actorId, "instanz.aufgeraeumt", inst.id, { entfernt: r.removed });
    return { ok: true as const, ...r };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await record(db, inst, "prune", startedAt, now(), { error }, actorId);
    return { ok: false as const, error };
  }
}

/** G4E-O08: Lauf als fehlgeschlagen buchen, ohne ihn auszuführen (z. B. ungültige Einstellung) – löst den Alarm aus */
export async function recordFailure(db: Db, inst: Instance, kind: MaintenanceKind, error: string, now = () => new Date()) {
  const at = now();
  await record(db, inst, kind, at, at, { error }, null);
}

/** letzter erfolgreicher Lauf einer Art */
async function lastOk(db: Db, instanceId: string, kind: MaintenanceKind) {
  const [row] = await db
    .select()
    .from(maintenanceRuns)
    .where(and(eq(maintenanceRuns.instanceId, instanceId), eq(maintenanceRuns.kind, kind), eq(maintenanceRuns.status, "ok")))
    .orderBy(desc(maintenanceRuns.startedAt))
    .limit(1);
  return row ?? null;
}

export async function lastMaintenance(db: Db, instanceId: string, kind: MaintenanceKind) {
  const [row] = await db
    .select()
    .from(maintenanceRuns)
    .where(and(eq(maintenanceRuns.instanceId, instanceId), eq(maintenanceRuns.kind, kind)))
    .orderBy(desc(maintenanceRuns.startedAt))
    .limit(1);
  return row ?? null;
}

export async function recentMaintenance(db: Db, instanceId: string, limit = 10) {
  return db.select().from(maintenanceRuns).where(eq(maintenanceRuns.instanceId, instanceId)).orderBy(desc(maintenanceRuns.startedAt)).limit(limit);
}

/** Uhrzeit (Europe/Berlin) und Abstand in Tagen je Wartungsart – nacheinander am Nachmittag, weit weg vom Sicherungstermin. */
export function maintenancePlan(env: Record<string, string | undefined> = process.env): Record<MaintenanceKind, { at: string; everyDays: number }> {
  const time = (v: string | undefined, d: string) => (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  return {
    prune: { at: pruneTime(env), everyDays: 1 },
    check: { at: time(env.SCHULOS_CHECK_TIME, "15:00"), everyDays: 7 },
    restore_test: { at: time(env.SCHULOS_RESTORE_TEST_TIME, "16:00"), everyDays: 30 },
    // nur mit SCHULOS_OFFSITE (B-37); nach den anderen Läufen, damit offsite der aufgeräumte und geprüfte Stand ankommt
    offsite: { at: time(env.SCHULOS_OFFSITE_TIME, "17:00"), everyDays: 1 },
    // SEC-11: nur mit SCHULOS_OFFSITE_SNAPSHOTS – Schnappschüsse des Offsite-Ziels prüfen (nach der Offsite-Kopie)
    immutable: { at: time(env.SCHULOS_OFFSITE_SNAPSHOT_TIME, "18:00"), everyDays: 1 },
  };
}

/**
 * Fällige Instanzen für eine Wartungsart: Uhrzeit heute vorbei (Berlin) und der letzte Lauf liegt mindestens `everyDays`
 * Kalendertage zurück (bzw. es gab noch keinen). Fehlgeschlagene Läufe zählen mit – sonst würde jede Minute erneut versucht.
 */
export async function dueFor(db: Db, kind: MaintenanceKind, now: Date, at: string, everyDays: number): Promise<Instance[]> {
  const stamp = berlinStamp(now);
  if (stamp.slice(11) < at) return [];
  const today = Date.parse(`${stamp.slice(0, 10)}T00:00:00Z`);
  const list = await db.select().from(instances).where(isNull(instances.removedAt));
  const due: Instance[] = [];
  for (const inst of list) {
    const last = await lastMaintenance(db, inst.id, kind);
    const lastDay = last ? Date.parse(`${berlinStamp(last.startedAt).slice(0, 10)}T00:00:00Z`) : null;
    if (lastDay === null || (today - lastDay) / 86_400_000 >= everyDays) due.push(inst);
  }
  return due;
}

/** Instanzen, deren tägliches Aufräumen fällig ist. */
export function duePrunes(db: Db, now: Date, at = pruneTime()): Promise<Instance[]> {
  return dueFor(db, "prune", now, at, 1);
}

async function runRecorded(
  db: Db,
  inst: Instance,
  kind: MaintenanceKind,
  actorId: string | null,
  now: () => Date,
  work: () => Promise<Record<string, unknown>>,
): Promise<{ ok: true; details: Record<string, unknown> } | { ok: false; error: string }> {
  const startedAt = now();
  try {
    const details = await work();
    await record(db, inst, kind, startedAt, now(), { details }, actorId);
    return { ok: true, details };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await record(db, inst, kind, startedAt, now(), { error }, actorId);
    return { ok: false, error };
  }
}

/** Wöchentliche Prüfung (restic check mit Datenstichprobe). */
export function runCheck(db: Db, inst: Instance, ctx: LocalRestic, appSecret: string, actorId: string | null, now = () => new Date()) {
  return runRecorded(db, inst, "check", actorId, now, async () => ({ stichprobe: (await check(ctx, inst.restUser, repoPassword(inst, appSecret))).readSubset }));
}

/** Monatlicher Test-Restore (Dump zurückholen und in den Test-Postgres einspielen). */
export function runRestoreTestFor(db: Db, inst: Instance, ctx: RestoreTestContext, appSecret: string, actorId: string | null, now = () => new Date()) {
  return runRecorded(db, inst, "restore_test", actorId, now, async () => {
    const r = await runRestoreTest(ctx, inst.restUser, repoPassword(inst, appSecret));
    return { stand: r.snapshot, dumpBytes: r.dumpBytes, eintraege: r.dumpEntries, tabellen: r.tables ?? null, migrationen: r.migrations ?? null, konten: r.accounts ?? null };
  });
}

/** Tägliche Offsite-Kopie (restic copy auf das rclone-Ziel, gleiche Aufbewahrung). */
export function runOffsiteFor(db: Db, inst: Instance, ctx: LocalRestic, cfg: OffsiteConfig, appSecret: string, actorId: string | null, now = () => new Date()) {
  return runRecorded(db, inst, "offsite", actorId, now, async () => ({ ...(await offsiteCopy(ctx, cfg, inst.restUser, repoPassword(inst, appSecret), inst.retention)) }));
}

/**
 * SEC-11: tägliche Prüfung „letzte unveränderliche Kopie“ – neuester Schnappschuss des Offsite-Ziels mit der Kopie dieser
 * Instanz. Zu alt → Lauf fehlgeschlagen (Alarm), der Stand bleibt in den Details sichtbar.
 */
export async function runImmutableFor(
  db: Db,
  inst: Instance,
  ctx: LocalRestic,
  offsite: OffsiteConfig,
  snaps: SnapshotConfig,
  actorId: string | null,
  now = () => new Date(),
  /** G4E-O07: mit Geheimnis der App zusätzlich den Inhalt prüfen (Stände entschlüsselbar, kein starker Schwund) */
  appSecret?: string,
) {
  const startedAt = now();
  try {
    // Vergleichswert: Pack-Größe der letzten guten Prüfung
    const prev = appSecret ? await lastOk(db, inst.id, "immutable") : null;
    const prevBytes = Number((prev?.details as { packBytes?: unknown } | null)?.packBytes);
    const verify = appSecret ? { password: repoPassword(inst, appSecret), previousBytes: Number.isFinite(prevBytes) && prevBytes > 0 ? prevBytes : null } : undefined;
    const r = await checkImmutable(ctx, offsite, snaps, inst.restUser, startedAt, verify);
    const details = { ...r };
    const error = r.alterStunden > snaps.maxHours ? `Letzte unveränderliche Kopie ist ${r.alterStunden} Stunden alt (Schnappschuss ${r.schnappschuss}) – Schnappschüsse beim Anbieter prüfen` : undefined;
    await record(db, inst, "immutable", startedAt, now(), { details, ...(error ? { error } : {}) }, actorId);
    return error ? { ok: false as const, error, details } : { ok: true as const, details };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await record(db, inst, "immutable", startedAt, now(), { error }, actorId);
    return { ok: false as const, error };
  }
}
