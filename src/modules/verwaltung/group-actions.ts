"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KINDS, type GroupKind } from "@/core/db/schema";
import { formValues } from "@/core/form-values";
import type { FormState } from "./actions";
import { MODULES } from "@/modules";
import {
  addMembers,
  availableGroupFeatures,
  createGroup,
  deleteGroup,
  getGroup,
  removeMember,
  searchCandidates,
  setGroupFeature,
  setMemberRole,
  updateGroup,
  type GroupInput,
} from "./groups";
import { ValidationError } from "./users";

const PERM = "verwaltung.groups";

function readGroupInput(form: FormData): GroupInput {
  const kind = String(form.get("kind") ?? "");
  const grade = String(form.get("gradeLevel") ?? "").trim();
  return {
    name: String(form.get("name") ?? ""),
    kind: (GROUP_KINDS as readonly string[]).includes(kind) ? (kind as GroupKind) : ("" as GroupKind),
    description: String(form.get("description") ?? ""),
    gradeLevel: grade ? Number(grade) : null,
    homeRoomId: String(form.get("homeRoomId") ?? "").trim() || null,
    level: String(form.get("level") ?? "") || null,
    subjectId: String(form.get("subjectId") ?? "") || null,
  };
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

export async function createGroupAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  let id: string;
  try {
    id = await createGroup(await getDb(), user.id, readGroupInput(form));
  } catch (err) {
    return fail(err, form);
  }
  redirect(`/verwaltung/gruppen/${id}`);
}

export async function updateGroupAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await updateGroup(await getDb(), user.id, id, readGroupInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/verwaltung/gruppen/${id}`);
  return { ok: true };
}

/** Gruppe löschen – mit Notenbüchern abgelehnt (G5A-C06): dann kommt der Hinweis zurück statt einer Fehlerseite. */
export async function deleteGroupAction(id: string): Promise<{ error?: string }> {
  const { user } = await requirePermission(PERM);
  try {
    await deleteGroup(await getDb(), user.id, id);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Löschen nicht möglich" };
    throw err;
  }
  redirect("/verwaltung/gruppen");
}

export async function searchCandidatesAction(groupId: string, q: string) {
  await requirePermission(PERM);
  return searchCandidates(await getDb(), groupId, q);
}

export async function addMemberAction(groupId: string, userId: string, role: "member" | "leader" = "member"): Promise<{ error?: string }> {
  const { user } = await requirePermission(PERM);
  try {
    await addMembers(await getDb(), user.id, groupId, [userId], role);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich." };
    throw err;
  }
  revalidatePath(`/verwaltung/gruppen/${groupId}`);
  return {};
}

export async function removeMemberAction(groupId: string, userId: string) {
  const { user } = await requirePermission(PERM);
  await removeMember(await getDb(), user.id, groupId, userId);
  revalidatePath(`/verwaltung/gruppen/${groupId}`);
}

export async function setMemberRoleAction(groupId: string, userId: string, role: "member" | "leader") {
  const { user } = await requirePermission(PERM);
  await setMemberRole(await getDb(), user.id, groupId, userId, role);
  revalidatePath(`/verwaltung/gruppen/${groupId}`);
}

export async function setGroupFeatureAction(groupId: string, feature: string, enabled: boolean) {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  // GT-01: nur Merkmale, die zur Gruppenart passen (Abschalten geht immer)
  const data = await getGroup(db, groupId);
  if (!data) throw new ValidationError({ feature: "Gruppe nicht gefunden" });
  if (enabled && !availableGroupFeatures(MODULES, { kind: data.group.kind }).some((f) => f.id === feature)) throw new ValidationError({ feature: "Diesen Bereich gibt es für diese Gruppenart nicht" });
  await setGroupFeature(db, user.id, groupId, feature, enabled);
  revalidatePath(`/verwaltung/gruppen/${groupId}`);
}
