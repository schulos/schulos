"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/core/db/client";
import { appUrl } from "@/core/mail";
import { moduleActions } from "@/core/modules/guard";
import { ValidationError } from "@/modules/verwaltung/users";
import { createFeed, revokeFeed } from "./abo";

const { requireUser } = moduleActions("kalender");
const PAGE = "/kalender/abo";

export interface FeedFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  /** einmalig angezeigter Abo-Link (der Token wird nicht gespeichert) */
  url?: string;
}

/** Q5-15: neuen Abo-Link für einen eigenen, lesbaren Kalender anlegen. */
export async function createFeedAction(_prev: FeedFormState, form: FormData): Promise<FeedFormState> {
  const { perms } = await requireUser();
  try {
    const { token } = await createFeed(await getDb(), perms, { calendar: String(form.get("calendar") ?? ""), label: String(form.get("label") ?? "") });
    revalidatePath(PAGE);
    return { url: appUrl(`/api/kalender/abo/${token}`) };
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
}

/** Q5-15: eigenen Abo-Link widerrufen – die Kalender-App bekommt danach nichts mehr. */
export async function revokeFeedAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await revokeFeed(await getDb(), perms, id);
  revalidatePath(PAGE);
}
