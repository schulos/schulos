// Backupserver-Seite der Agent-Schnittstelle (@schulos/server/agent-api): Plan ausliefern, Ergebnisse speichern, Läufe anfordern.
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { backupHealth, type AgentPlan, type AgentReport, type BackupHealth, type ImmutableCopy } from "@schulos/server/agent-api";
import { lastMaintenance } from "@/maintenance/service";
import { sha256Hex } from "@schulos/server/pairing";
import { audit } from "@/audit";
import { endPairingReplay } from "@/pairing/service";
import { openRestoreRequest } from "@/restore/service";
import type { Db } from "@/db/client";
import { backupRuns, instances, type Instance } from "@/db/schema";

/** Instanz zum Agent-Token (Authorization: Bearer …) oder null. Entkoppelte Instanzen haben keinen gültigen Token mehr. */
export async function authenticateAgent(db: Db, authorization: string | null): Promise<Instance | null> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
  if (!token) return null;
  const [inst] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.agentTokenHash, sha256Hex(token)), isNull(instances.removedAt)));
  return inst ?? null;
}

export async function agentPlan(db: Db, inst: Instance, now = new Date()): Promise<AgentPlan> {
  await db.update(instances).set({ lastSeenAt: now }).where(eq(instances.id, inst.id));
  await endPairingReplay(db, inst.id);
  return {
    instanceId: inst.id,
    instanceName: inst.name,
    schedule: inst.schedule,
    runRequestedAt: inst.runRequestedAt?.toISOString() ?? null,
    restore: await openRestoreRequest(db, inst.id),
    immutable: await immutableFor(db, inst.id),
  };
}

/** SEC-11: letzte Prüfung der unveränderlichen Kopie für den Plan; null = nicht eingerichtet (kein SCHULOS_OFFSITE_SNAPSHOTS) */
export async function immutableFor(db: Db, instanceId: string, env: Record<string, string | undefined> = process.env): Promise<ImmutableCopy | null> {
  if (!env.SCHULOS_OFFSITE?.trim() || !env.SCHULOS_OFFSITE_SNAPSHOTS?.trim()) return null;
  const last = await lastMaintenance(db, instanceId, "immutable");
  if (!last) return null;
  const d = (last.details ?? {}) as Record<string, unknown>;
  return {
    lastAt: typeof d.letzteKopie === "string" ? d.letzteKopie : null,
    checkedAt: (last.finishedAt ?? last.startedAt).toISOString(),
    ok: last.status === "ok",
    error: last.error ?? null,
  };
}

export class ReportRejected extends Error {}

const date = (v: unknown) => {
  const d = typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new ReportRejected("Zeitangabe ungültig");
  return d;
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Ergebnis speichern; eine erledigte Anforderung („Jetzt sichern“) wird gelöscht, eine neuere bleibt stehen. */
export async function recordReport(db: Db, inst: Instance, r: AgentReport, now = new Date()): Promise<void> {
  if (r.status !== "ok" && r.status !== "failed") throw new ReportRejected("Status ungültig");
  if (!["zeitplan", "angefordert", "vor-wiederherstellung"].includes(r.trigger)) throw new ReportRejected("Auslöser ungültig");
  await db.insert(backupRuns).values({
    id: crypto.randomUUID(),
    instanceId: inst.id,
    trigger: r.trigger,
    status: r.status,
    startedAt: date(r.startedAt),
    finishedAt: date(r.finishedAt),
    snapshotId: typeof r.snapshotId === "string" ? r.snapshotId.slice(0, 80) : null,
    bytesTotal: num(r.bytesTotal),
    bytesAdded: num(r.bytesAdded),
    error: typeof r.error === "string" ? r.error.slice(0, 500) : null,
    agentVersion: typeof r.agentVersion === "string" ? r.agentVersion.slice(0, 40) : null,
  });
  await db.update(instances).set({ lastSeenAt: now }).where(eq(instances.id, inst.id));
  if (r.requestedAt)
    await db
      .update(instances)
      .set({ runRequestedAt: null })
      .where(and(eq(instances.id, inst.id), lte(instances.runRequestedAt, date(r.requestedAt))));
}

/** „Jetzt sichern“ – aus der Web-UI (mit Person) oder vom Hauptsystem (Agent-Token). */
export async function requestRun(db: Db, instanceId: string, actorId: string | null, now = new Date()): Promise<void> {
  await db.update(instances).set({ runRequestedAt: now }).where(and(eq(instances.id, instanceId), isNull(instances.removedAt)));
  await audit(db, actorId, "sicherung.angefordert", instanceId);
}

export interface InstanceStatus {
  health: BackupHealth;
  lastRun: typeof backupRuns.$inferSelect | null;
  lastOkAt: Date | null;
}

export async function instanceStatus(db: Db, instanceId: string, now = new Date()): Promise<InstanceStatus> {
  const [lastRun] = await db.select().from(backupRuns).where(eq(backupRuns.instanceId, instanceId)).orderBy(desc(backupRuns.finishedAt)).limit(1);
  const [lastOk] = await db
    .select({ at: backupRuns.finishedAt })
    .from(backupRuns)
    .where(and(eq(backupRuns.instanceId, instanceId), eq(backupRuns.status, "ok")))
    .orderBy(desc(backupRuns.finishedAt))
    .limit(1);
  const lastOkAt = lastOk?.at ?? null;
  return { health: backupHealth(lastOkAt, lastRun ?? null, now), lastRun: lastRun ?? null, lastOkAt };
}

export async function recentRuns(db: Db, instanceId: string, limit = 20) {
  return db.select().from(backupRuns).where(eq(backupRuns.instanceId, instanceId)).orderBy(desc(backupRuns.finishedAt)).limit(limit);
}
