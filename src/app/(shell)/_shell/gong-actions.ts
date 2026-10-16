"use server";

import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { listNotifications, markRead, type GongItem } from "@/core/notifications";

export async function listGongAction(): Promise<GongItem[]> {
  const { user } = await requireUser();
  return listNotifications(await getDb(), user.id, 20);
}

export async function markGongReadAction(ids?: string[]): Promise<number> {
  const { user } = await requireUser();
  return markRead(await getDb(), user.id, ids);
}
