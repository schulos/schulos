"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { confirmRecoveryKey, pairNow, PairingError, unpairLocal } from "@/core/backup/pairing";
import { BackupRequestError, confirmRestoreOnServer, rejectRestoreOnServer, requestBackupNow } from "@/core/backup/status";
import { getDb } from "@/core/db/client";

export interface PairFormState {
  error?: string;
  values?: { backupUrl: string; instanceName: string };
}

export async function pairAction(_prev: PairFormState, form: FormData): Promise<PairFormState> {
  const { user } = await requirePermission("verwaltung.system");
  const values = { backupUrl: String(form.get("backupUrl") ?? ""), instanceName: String(form.get("instanceName") ?? "") };
  try {
    await pairNow(
      await getDb(),
      user.id,
      { ...values, code: String(form.get("code") ?? ""), mainUrl: process.env.BETTER_AUTH_URL ?? "" },
      // http nur in der Entwicklung (SCHULOS_BACKUP_ALLOW_HTTP=1), im Betrieb immer https mit geprüftem Zertifikat
      { allowHttp: process.env.SCHULOS_BACKUP_ALLOW_HTTP === "1" },
    );
  } catch (err) {
    if (err instanceof PairingError) return { error: err.message, values };
    throw err;
  }
  revalidatePath("/verwaltung/backup");
  return {};
}

export async function confirmRecoveryAction(form: FormData): Promise<void> {
  const { user } = await requirePermission("verwaltung.system");
  if (form.get("verwahrt") !== "1") return;
  await confirmRecoveryKey(await getDb(), user.id);
  revalidatePath("/verwaltung/backup");
}

export async function unpairAction(): Promise<void> {
  const { user } = await requirePermission("verwaltung.system");
  await unpairLocal(await getDb(), user.id);
  revalidatePath("/verwaltung/backup");
}

export interface RunNowState {
  ok?: boolean;
  error?: string;
}

export async function runNowAction(): Promise<RunNowState> {
  const { user } = await requirePermission("verwaltung.system");
  try {
    await requestBackupNow(await getDb(), user.id);
  } catch (err) {
    if (err instanceof BackupRequestError) return { error: err.message };
    throw err;
  }
  return { ok: true };
}

export interface RestoreConfirmState {
  error?: string;
  ok?: string;
}

export async function restoreDecisionAction(_prev: RestoreConfirmState, form: FormData): Promise<RestoreConfirmState> {
  const { user } = await requirePermission("verwaltung.system");
  const id = String(form.get("id") ?? "");
  const db = await getDb();
  try {
    if (form.get("entscheidung") === "ablehnen") {
      await rejectRestoreOnServer(db, user.id, id);
      revalidatePath("/verwaltung/backup");
      return { ok: "Abgelehnt – es wird nichts zurückgespielt." };
    }
    const r = await confirmRestoreOnServer(db, user.id, id, String(form.get("code") ?? ""));
    if (r === "falsch") return { error: "Der Code stimmt nicht. Er steht auf dem Backupserver beim Auftrag (6 Ziffern)." };
    if (r === "verworfen") return { error: "Zu viele falsche Codes – der Auftrag ist verworfen. Auf dem Backupserver neu anfordern." };
    revalidatePath("/verwaltung/backup");
    return { ok: "Bestätigt – der Backup-Agent beginnt innerhalb einer Minute." };
  } catch (err) {
    if (err instanceof BackupRequestError) return { error: err.message };
    throw err;
  }
}
