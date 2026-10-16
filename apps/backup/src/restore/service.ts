// Wiederherstellung auf das Hauptsystem, Seite Backupserver (INSTALLATION.md §4.4). Ein Auftrag wartet, bis das Hauptsystem ihn mit dem
// Code bestätigt. Ausführen tut der Agent – und zwar nur, wenn auf dem Hauptsystem eine passende Freigabe liegt (SEC-06,
// restore-approval.json, schreibt die App bei der Code-Eingabe). Der Status hier allein reicht also nicht: Ein übernommener
// Backupserver kann ohne die Admin des Hauptsystems nichts zurückspielen.
import { randomInt } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { normalizeRestoreCode, SNAPSHOT_ID, type RestoreReport, type RestoreRequest, type RestoreScope } from "@schulos/server/agent-api";
import { sha256Hex } from "@schulos/server/pairing";
import { audit } from "@/audit";
import type { Db } from "@/db/client";
import { restoreJobs, users, type Instance } from "@/db/schema";

export class RestoreRejected extends Error {}

/** Nach so vielen falschen Codes wird der Auftrag verworfen. */
export const MAX_CODE_ATTEMPTS = 5;

const codeHash = (id: string, code: string) => sha256Hex(`schulos-restore:${id}:${code}`);

export interface NewRestore {
  snapshotId: string;
  snapshotShort: string;
  snapshotTime: Date;
  scope: RestoreScope;
}

/** Neuer Auftrag; ein offener (noch nicht laufender) Auftrag derselben Instanz wird ersetzt. Gibt den Code genau einmal zurück. */
export async function createRestoreJob(db: Db, actorId: string, inst: Instance, r: NewRestore): Promise<{ id: string; code: string }> {
  if (r.scope !== "komplett" && r.scope !== "dateien") throw new RestoreRejected("Umfang unbekannt");
  if (!SNAPSHOT_ID.test(r.snapshotId) || !r.snapshotId.startsWith(r.snapshotShort) || r.snapshotShort.length < 8) throw new RestoreRejected("Stand unbekannt");
  const [running] = await db.select({ id: restoreJobs.id }).from(restoreJobs).where(and(eq(restoreJobs.instanceId, inst.id), eq(restoreJobs.status, "laeuft")));
  if (running) throw new RestoreRejected("Es läuft schon eine Wiederherstellung.");
  const id = crypto.randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.transaction(async (tx) => {
    await tx
      .update(restoreJobs)
      .set({ status: "abgelehnt", error: "durch neuen Auftrag ersetzt", finishedAt: new Date() })
      .where(and(eq(restoreJobs.instanceId, inst.id), inArray(restoreJobs.status, ["wartet", "bestaetigt"])));
    await tx.insert(restoreJobs).values({
      id,
      instanceId: inst.id,
      snapshotId: r.snapshotId,
      snapshotShort: r.snapshotShort,
      snapshotTime: r.snapshotTime,
      scope: r.scope,
      status: "wartet",
      codeHash: codeHash(id, code),
      createdBy: actorId,
    });
  });
  await audit(db, actorId, "wiederherstellung.angefordert", inst.id, { stand: r.snapshotShort, umfang: r.scope });
  return { id, code };
}

/** Offener Auftrag für den Plan des Agenten (wartet bzw. bestätigt). */
export async function openRestoreRequest(db: Db, instanceId: string): Promise<RestoreRequest | null> {
  const [j] = await db
    .select({ job: restoreJobs, by: users.name })
    .from(restoreJobs)
    .leftJoin(users, eq(users.id, restoreJobs.createdBy))
    .where(and(eq(restoreJobs.instanceId, instanceId), inArray(restoreJobs.status, ["wartet", "bestaetigt"])))
    .orderBy(desc(restoreJobs.createdAt))
    .limit(1);
  if (!j) return null;
  return {
    id: j.job.id,
    snapshotId: j.job.snapshotId,
    snapshotShort: j.job.snapshotShort,
    snapshotTime: j.job.snapshotTime.toISOString(),
    scope: j.job.scope as RestoreScope,
    requestedBy: j.by,
    createdAt: j.job.createdAt.toISOString(),
    status: j.job.status as "wartet" | "bestaetigt",
  };
}

async function jobOf(db: Db, inst: Instance, id: string) {
  const [j] = await db.select().from(restoreJobs).where(and(eq(restoreJobs.id, id), eq(restoreJobs.instanceId, inst.id)));
  return j ?? null;
}

/** Bestätigung vom Hauptsystem (Agent-Token): richtiger Code → „bestätigt“; nach 5 falschen Codes verworfen. */
export async function confirmRestore(db: Db, inst: Instance, id: string, code: string, now = new Date()): Promise<"bestaetigt" | "falsch" | "verworfen"> {
  const j = await jobOf(db, inst, id);
  if (!j || j.status !== "wartet") throw new RestoreRejected("Kein wartender Auftrag.");
  const c = normalizeRestoreCode(code);
  if (c && codeHash(id, c) === j.codeHash) {
    await db.update(restoreJobs).set({ status: "bestaetigt", confirmedAt: now }).where(eq(restoreJobs.id, id));
    await audit(db, null, "wiederherstellung.bestaetigt", inst.id, { stand: j.snapshotShort });
    return "bestaetigt";
  }
  const attempts = j.failedAttempts + 1;
  const discard = attempts >= MAX_CODE_ATTEMPTS;
  await db
    .update(restoreJobs)
    .set({ failedAttempts: attempts, ...(discard ? { status: "abgelehnt", error: "zu viele falsche Codes", finishedAt: now } : {}) })
    .where(eq(restoreJobs.id, id));
  if (discard) await audit(db, null, "wiederherstellung.verworfen", inst.id, { grund: "zu viele falsche Codes" });
  return discard ? "verworfen" : "falsch";
}

/** Ablehnung (vom Hauptsystem) bzw. Abbruch (auf dem Backupserver) – nur solange der Auftrag noch nicht läuft. */
export async function rejectRestore(db: Db, inst: Instance, id: string, actorId: string | null, reason: string, now = new Date()): Promise<void> {
  const j = await jobOf(db, inst, id);
  if (!j || (j.status !== "wartet" && j.status !== "bestaetigt")) throw new RestoreRejected("Der Auftrag ist nicht mehr offen.");
  await db.update(restoreJobs).set({ status: "abgelehnt", error: reason, finishedAt: now }).where(eq(restoreJobs.id, id));
  await audit(db, actorId, "wiederherstellung.abgelehnt", inst.id, { stand: j.snapshotShort, grund: reason });
}

/** Fortschritt/Ergebnis vom Agenten. Nur bestätigte Aufträge dürfen laufen. */
export async function recordRestoreReport(db: Db, inst: Instance, r: RestoreReport, now = new Date()): Promise<void> {
  // nur die drei Meldungen des Agenten – nie zurück auf „wartet“/„bestätigt“ (B-55)
  if (r.status !== "laeuft" && r.status !== "fertig" && r.status !== "fehlgeschlagen") throw new RestoreRejected("Unbekannter Status.");
  const j = await jobOf(db, inst, r.id);
  if (!j) throw new RestoreRejected("Auftrag unbekannt.");
  const allowed = r.status === "laeuft" ? j.status === "bestaetigt" : j.status === "laeuft" || j.status === "bestaetigt";
  if (!allowed) throw new RestoreRejected(`Statuswechsel ${j.status} → ${r.status} nicht erlaubt.`);
  await db
    .update(restoreJobs)
    .set({
      status: r.status,
      details: r.details ?? j.details,
      error: typeof r.error === "string" ? r.error.slice(0, 500) : null,
      finishedAt: r.status === "laeuft" ? null : now,
    })
    .where(eq(restoreJobs.id, r.id));
  if (r.status !== "laeuft") await audit(db, null, r.status === "fertig" ? "wiederherstellung.fertig" : "wiederherstellung.fehlgeschlagen", inst.id, { stand: j.snapshotShort });
}

export async function listRestoreJobs(db: Db, instanceId: string, limit = 10) {
  return db.select().from(restoreJobs).where(eq(restoreJobs.instanceId, instanceId)).orderBy(desc(restoreJobs.createdAt)).limit(limit);
}

