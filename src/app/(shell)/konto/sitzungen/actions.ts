"use server";

// P4-71: eigene Sitzungen beenden – ein anderes Gerät oder überall (gilt als echtes Abmelden, auch für den Notenbuch-Offline-Anteil).
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuth } from "@/core/auth/auth";
import { requireUser } from "@/core/auth/session";
import { endAllOwnSessions, endOwnSession } from "@/core/auth/sitzungen";
import { getDb } from "@/core/db/client";

async function currentSession() {
  const { user } = await requireUser();
  const h = await headers();
  const session = await (await getAuth()).api.getSession({ headers: h });
  if (!session || session.user.id !== user.id) redirect("/login");
  return { userId: user.id, sessionId: session.session.id, h };
}

export async function endSessionAction(sessionId: string): Promise<{ error?: string }> {
  const { userId, sessionId: current } = await currentSession();
  if (!(await endOwnSession(await getDb(), userId, sessionId, current))) return { error: "Diese Sitzung gibt es nicht mehr." };
  revalidatePath("/konto/sitzungen");
  return {};
}

/** Überall abmelden – auch auf diesem Gerät (danach zur Anmeldung). */
export async function endAllSessionsAction(): Promise<void> {
  const { userId, sessionId, h } = await currentSession();
  await endAllOwnSessions(await getDb(), userId, sessionId);
  await (await getAuth()).api.signOut({ headers: h }).catch(() => undefined);
  redirect("/login");
}
