"use server";

import { revalidatePath } from "next/cache";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { loadModuleStates } from "@/core/modules/registry";
import { setCourseFeature } from "./service";

const { requirePermission } = moduleActions("kurse");

/** P3-02: Bereich des Kurses an/aus – Leitung oder Gruppenverwaltung (Prüfung im Service). */
export async function setCourseFeatureAction(groupId: string, feature: string, enabled: boolean) {
  const { perms } = await requirePermission("kurse.view");
  const db = await getDb();
  await setCourseFeature(db, perms, groupId, feature, enabled, await loadModuleStates(db));
  revalidatePath(`/kurse/${groupId}`);
}
