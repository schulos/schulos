"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { Role } from "@/core/db/schema";
import { getModule, MODULES } from "@/modules";
import type { FormState } from "./actions";
import { addGroupGrant, removeGrant, setModuleSetting, setRoleGrant, toggleModule } from "./rights";
import { ValidationError } from "./users";

const PERM = "verwaltung.rights";
const PATH = "/verwaltung/rechte";

export async function setRoleGrantAction(role: Role, permission: string, granted: boolean): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await setRoleGrant(await getDb(), MODULES, user.id, role, permission, granted);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] };
    throw err;
  }
  revalidatePath(PATH, "layout");
  return { ok: true };
}

export async function addGroupGrantAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await addGroupGrant(await getDb(), MODULES, user.id, String(form.get("groupId") ?? ""), String(form.get("permission") ?? ""));
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] };
    throw err;
  }
  revalidatePath(PATH, "layout");
  return { ok: true };
}

export async function removeGrantAction(id: string): Promise<void> {
  const { user } = await requirePermission(PERM);
  await removeGrant(await getDb(), user.id, id);
  revalidatePath(PATH, "layout");
}

export async function toggleModuleAction(moduleId: string, enabled: boolean): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  const m = getModule(moduleId);
  if (!m) return { error: "Unbekanntes Modul" };
  try {
    await toggleModule(await getDb(), user.id, m, enabled);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich" };
    return { error: err instanceof Error ? err.message : "Fehler" };
  }
  // Navigation der ganzen App ändert sich
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setModuleSettingAction(moduleId: string, key: string, value: string): Promise<FormState> {
  const { user, perms } = await requirePermission(PERM);
  const m = getModule(moduleId);
  if (!m) return { error: "Unbekanntes Modul" };
  try {
    await setModuleSetting(await getDb(), user.id, m, key, value, perms);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich" };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
