"use server";

import { revalidatePath } from "next/cache";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { ValidationError } from "@/modules/verwaltung/users";
import { createFolder, deleteNode, renameNode } from "./service";

const { requireUser } = moduleActions("dateien");

type Result = { ok: true } | { error: string };

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Fehler" };
    throw err;
  }
  revalidatePath("/dateien");
  return { ok: true };
}

export async function createFolderAction(space: string, parent: string | null, name: string): Promise<Result> {
  const { perms } = await requireUser();
  return run(async () => createFolder(await getDb(), perms, space, parent, name));
}

export async function renameAction(space: string, id: string, name: string): Promise<Result> {
  const { perms } = await requireUser();
  return run(async () => renameNode(await getDb(), perms, space, id, name));
}

export async function deleteAction(space: string, id: string): Promise<Result> {
  const { perms } = await requireUser();
  return run(async () => deleteNode(await getDb(), getStorage(), perms, space, id));
}
