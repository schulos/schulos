"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { appSecret } from "@/auth/auth";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db/client";
import { instances } from "@/db/schema";
import { restoreTestContext } from "@/maintenance/restore-test";
import { runCheck, runOffsiteFor, runPrune, runRestoreTestFor, updateRetention, updateSchedule } from "@/maintenance/service";
import { offsiteConfig } from "@/maintenance/offsite";
import { localRestic } from "@/restic/local";
import { parseRetention, parseSchedule } from "@schulos/server/backup-retention";
import { createRestoreJob, rejectRestore, RestoreRejected } from "@/restore/service";
import { createPairingCode } from "@/pairing/service";
import type { RestoreScope } from "@schulos/server/agent-api";

export interface FormResult {
  error?: string;
  errors?: Record<string, string>;
  ok?: string;
}

export async function scheduleAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await requireUser();
  const id = String(form.get("id") ?? "");
  const r = parseSchedule(String(form.get("schedule") ?? ""));
  if (!r.ok) return { error: r.error };
  await updateSchedule(await getDb(), user.id, id, r.schedule);
  revalidatePath(`/instanzen/${id}`);
  return { ok: `Gespeichert: täglich ${r.schedule.join(", ")} Uhr. Der Agent übernimmt das mit dem nächsten Plan.` };
}

export async function retentionAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await requireUser();
  const id = String(form.get("id") ?? "");
  const r = parseRetention({
    daily: String(form.get("daily") ?? ""),
    weekly: String(form.get("weekly") ?? ""),
    monthly: String(form.get("monthly") ?? ""),
    reason: String(form.get("reason") ?? ""),
  });
  if (!r.ok) return { errors: r.errors };
  await updateRetention(await getDb(), user.id, id, r.retention, r.reason);
  revalidatePath(`/instanzen/${id}`);
  return { ok: "Gespeichert – gilt ab dem nächsten Aufräumen." };
}

export async function pruneNowAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const [inst] = await db.select().from(instances).where(eq(instances.id, String(form.get("id") ?? "")));
  if (!inst) return;
  await runPrune(db, inst, localRestic(), appSecret(), user.id);
  revalidatePath(`/instanzen/${inst.id}`);
}

export async function checkNowAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const [inst] = await db.select().from(instances).where(eq(instances.id, String(form.get("id") ?? "")));
  if (!inst) return;
  await runCheck(db, inst, localRestic(), appSecret(), user.id);
  revalidatePath(`/instanzen/${inst.id}`);
}

export async function restoreTestNowAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const [inst] = await db.select().from(instances).where(eq(instances.id, String(form.get("id") ?? "")));
  if (!inst) return;
  await runRestoreTestFor(db, inst, restoreTestContext(localRestic()), appSecret(), user.id);
  revalidatePath(`/instanzen/${inst.id}`);
}

export async function offsiteNowAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const cfg = offsiteConfig();
  if (!cfg) return;
  const db = await getDb();
  const [inst] = await db.select().from(instances).where(eq(instances.id, String(form.get("id") ?? "")));
  if (!inst) return;
  await runOffsiteFor(db, inst, localRestic(), cfg, appSecret(), user.id);
  revalidatePath(`/instanzen/${inst.id}`);
}

export interface RestoreFormState {
  error?: string;
  code?: string;
  scope?: string;
  snapshot?: string;
}

export async function createRestoreAction(_prev: RestoreFormState, form: FormData): Promise<RestoreFormState> {
  const user = await requireUser();
  const db = await getDb();
  const [inst] = await db.select().from(instances).where(eq(instances.id, String(form.get("id") ?? "")));
  if (!inst) return { error: "Instanz unbekannt." };
  const [snapshotId, snapshotShort, time] = String(form.get("snapshot") ?? "").split("|");
  const scope = String(form.get("scope") ?? "") as RestoreScope;
  if (!snapshotId || !snapshotShort || !time) return { error: "Bitte einen Stand wählen." };
  try {
    const { code } = await createRestoreJob(db, user.id, inst, { snapshotId, snapshotShort, snapshotTime: new Date(time), scope });
    revalidatePath(`/instanzen/${inst.id}`);
    return { code, scope, snapshot: snapshotShort };
  } catch (err) {
    if (err instanceof RestoreRejected) return { error: err.message };
    throw err;
  }
}

export async function cancelRestoreAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const [inst] = await db.select().from(instances).where(eq(instances.id, String(form.get("id") ?? "")));
  if (!inst) return;
  await rejectRestore(db, inst, String(form.get("job") ?? ""), user.id, "auf dem Backupserver abgebrochen").catch((err: unknown) => {
    if (!(err instanceof RestoreRejected)) throw err;
  });
  revalidatePath(`/instanzen/${inst.id}`);
}

export interface ReplacementCodeState {
  code?: string;
  expiresAt?: string;
}

/** Ersatz-Kopplungscode für neue Hardware: das neue Hauptsystem übernimmt diese Instanz und ihr Repository. */
export async function replacementCodeAction(_prev: ReplacementCodeState, form: FormData): Promise<ReplacementCodeState> {
  const user = await requireUser();
  const id = String(form.get("id") ?? "");
  const { code, expiresAt } = await createPairingCode(await getDb(), user.id, appSecret(), new Date(), id);
  revalidatePath("/instanzen");
  return { code, expiresAt: expiresAt.toISOString() };
}
