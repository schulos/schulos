"use server";

import { revalidatePath } from "next/cache";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createScreen, deleteScreen, renewToken, revokeToken, updateScreen, type ScreenInput } from "./service";

const { requirePermission } = moduleActions("monitor");

const PERM = "monitor.manage";
const PAGE = "/verwaltung/monitore";

/** Ergebnis mit frisch erzeugtem Token – er wird nur einmal angezeigt */
export interface MonitorFormState extends FormState {
  issued?: { name: string; token: string };
}

function read(form: FormData): ScreenInput {
  return { name: String(form.get("name") ?? ""), location: String(form.get("location") ?? ""), profile: String(form.get("profile") ?? ""), boardId: String(form.get("boardId") ?? "") };
}

function fail(err: unknown, form: FormData): MonitorFormState {
  if (err instanceof ValidationError) {
    const values = Object.fromEntries([...form.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
    return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values };
  }
  throw err;
}

export async function createScreenAction(_prev: MonitorFormState, form: FormData): Promise<MonitorFormState> {
  const { user } = await requirePermission(PERM);
  try {
    const input = read(form);
    const { token } = await createScreen(await getDb(), user.id, input);
    revalidatePath(PAGE);
    return { ok: true, issued: { name: input.name.trim(), token } };
  } catch (err) {
    return fail(err, form);
  }
}

export async function updateScreenAction(id: string, _prev: MonitorFormState, form: FormData): Promise<MonitorFormState> {
  const { user } = await requirePermission(PERM);
  try {
    await updateScreen(await getDb(), user.id, id, read(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(PAGE);
  return { ok: true };
}

export async function renewTokenAction(id: string, name: string): Promise<MonitorFormState> {
  const { user } = await requirePermission(PERM);
  const token = await renewToken(await getDb(), user.id, id);
  revalidatePath(PAGE);
  return { ok: true, issued: { name, token } };
}

export async function revokeTokenAction(id: string): Promise<void> {
  const { user } = await requirePermission(PERM);
  await revokeToken(await getDb(), user.id, id);
  revalidatePath(PAGE);
}

export async function deleteScreenAction(id: string): Promise<void> {
  const { user } = await requirePermission(PERM);
  await deleteScreen(await getDb(), user.id, id);
  revalidatePath(PAGE);
}
