"use server";

import { revalidatePath } from "next/cache";
import { requestRun } from "@/agent/service";
import { appSecret } from "@/auth/auth";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db/client";
import { createPairingCode, PairingRejected, renameInstance, revokeCode, unpairInstance } from "@/pairing/service";
import { restDir } from "@/settings";

export interface CodeState {
  code?: string;
  expiresAt?: string;
}

export async function createCodeAction(): Promise<CodeState> {
  const user = await requireUser();
  const { code, expiresAt } = await createPairingCode(await getDb(), user.id, appSecret());
  revalidatePath("/instanzen");
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function revokeCodeAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await revokeCode(await getDb(), user.id, String(form.get("id") ?? ""));
  revalidatePath("/instanzen");
}

export interface RenameState {
  error?: string;
  ok?: boolean;
}

export async function renameAction(_prev: RenameState, form: FormData): Promise<RenameState> {
  const user = await requireUser();
  try {
    await renameInstance(await getDb(), user.id, String(form.get("id") ?? ""), String(form.get("name") ?? ""));
  } catch (err) {
    if (err instanceof PairingRejected) return { error: err.message };
    throw err;
  }
  revalidatePath("/instanzen");
  return { ok: true };
}

export async function requestRunAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await requestRun(await getDb(), String(form.get("id") ?? ""), user.id);
  revalidatePath("/instanzen");
}

export async function unpairAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await unpairInstance(await getDb(), user.id, String(form.get("id") ?? ""), restDir());
  revalidatePath("/instanzen");
  revalidatePath("/");
}
