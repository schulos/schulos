"use server";

import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { searchPeople } from "@/modules/adressbuch/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { directChatBlock } from "./policy";
import { markRead, openDirectRoom, sendMessage } from "./service";

const { requireUser } = moduleActions("messenger");

export async function sendMessageAction(roomId: string, body: string) {
  const { perms } = await requireUser();
  try {
    return { message: await sendMessage(await getDb(), perms, roomId, body) };
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Fehler" };
    throw err;
  }
}

export async function markReadAction(roomId: string) {
  const { perms } = await requireUser();
  await markRead(await getDb(), perms, roomId);
}

export async function findPeopleAction(q: string) {
  const { perms, user } = await requireUser();
  const db = await getDb();
  const hits = (await searchPeople(db, perms, q, 8)).filter((p) => p.id !== user.id);
  // nur Personen anbieten, mit denen ein Direktchat erlaubt ist (Moduleinstellungen, Q5-14)
  const allowed = await Promise.all(hits.map(async (p) => !(await directChatBlock(db, { id: user.id, role: perms.role }, p, { initiating: true }))));
  return hits.filter((_, i) => allowed[i]);
}

export async function openDirectAction(userId: string): Promise<{ error?: string }> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await openDirectRoom(await getDb(), perms, userId);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich" };
    throw err;
  }
  redirect(`/messenger/${id}`);
}
