import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupFeatures, groups } from "@/core/db/schema";
import { GROUP_FOLDER_FEATURE } from "./service";

/** Gruppenordner für Klassen, Kurse, AGs und Fachschaften. */
export async function seedDateien(db: Db) {
  const gs = await db.select({ id: groups.id }).from(groups).where(inArray(groups.kind, ["klasse", "kurs", "ag", "fachschaft"]));
  await db.insert(groupFeatures).values(gs.map((g) => ({ groupId: g.id, feature: GROUP_FOLDER_FEATURE })));
}
