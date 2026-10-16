"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { confirmResponsibility, revokeConfirmation, setTopicStatus, SETUP_STATUSES, type SetupStatus } from "./einrichtung";

// DS-12: Datenschutz-Einrichtung – jede Action prüft `verwaltung.privacy` selbst (Rechte serverseitig).
const PAGE = "/verwaltung/datenschutz/einrichtung";

function fail(err: unknown): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
  throw err;
}

export async function confirmSetupAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.privacy");
  try {
    await confirmResponsibility(await getDb(), user.id, form.get("confirm") === "on");
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function revokeSetupAction(): Promise<void> {
  const { user } = await requirePermission("verwaltung.privacy");
  await revokeConfirmation(await getDb(), user.id);
  revalidatePath("/", "layout");
}

export async function setTopicAction(topicId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.privacy");
  const raw = String(form.get("status") ?? "");
  const status: SetupStatus | null = raw === "offen" ? null : raw in SETUP_STATUSES ? (raw as SetupStatus) : null;
  try {
    if (raw !== "offen" && !status) throw new ValidationError({ status: "Status wählen" });
    await setTopicStatus(await getDb(), user.id, topicId, status, String(form.get("note") ?? ""));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PAGE);
  revalidatePath("/");
  return { ok: true };
}
