"use server";

import { revalidatePath } from "next/cache";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { loadModuleStates } from "@/core/modules/registry";
import { ValidationError } from "@/modules/verwaltung/users";
import { setConferenceLink, setCourseFeature } from "./service";

const { requirePermission } = moduleActions("kurse");

/** P3-02: Bereich des Kurses an/aus – Leitung oder Gruppenverwaltung (Prüfung im Service). */
export async function setCourseFeatureAction(groupId: string, feature: string, enabled: boolean) {
  const { perms } = await requirePermission("kurse.view");
  const db = await getDb();
  await setCourseFeature(db, perms, groupId, feature, enabled, await loadModuleStates(db));
  revalidatePath(`/kurse/${groupId}`);
}

/** V-01: Konferenzlink der Gruppe setzen oder (leere Adresse) entfernen – Prüfung im Service. */
export async function setConferenceLinkAction(groupId: string, url: string, label: string): Promise<{ error?: string }> {
  const { perms } = await requirePermission("kurse.view");
  const db = await getDb();
  try {
    await setConferenceLink(db, perms, groupId, { url, label });
  } catch (e) {
    if (e instanceof ValidationError) return { error: Object.values(e.fieldErrors)[0] ?? "Ungültige Eingabe" };
    throw e;
  }
  revalidatePath(`/kurse/${groupId}`);
  return {};
}
