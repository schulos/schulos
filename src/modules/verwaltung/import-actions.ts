"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { credentialsCsv, executeImport, parseStudentCsv, planImport, type ImportResult, type PlannedRow } from "./import";

const MAX_BYTES = 512 * 1024;

export interface PreviewResult {
  plan: PlannedRow[];
  parseErrors: { line: number; message: string }[];
  error?: string;
}

export async function previewImportAction(text: string): Promise<PreviewResult> {
  await requirePermission("verwaltung.users");
  if (text.length > MAX_BYTES) return { plan: [], parseErrors: [], error: "Datei zu groß (max. 512 KB)" };
  const { rows, errors } = parseStudentCsv(text);
  return { plan: await planImport(await getDb(), rows), parseErrors: errors };
}

/** Plant serverseitig NEU (der Vorschau aus dem Browser wird nicht vertraut) und importiert. */
export async function runImportAction(text: string): Promise<(ImportResult & { csv: string }) | { error: string }> {
  const { user } = await requirePermission("verwaltung.users");
  if (text.length > MAX_BYTES) return { error: "Datei zu groß (max. 512 KB)" };
  const db = await getDb();
  try {
    const res = await executeImport(db, user.id, await planImport(db, parseStudentCsv(text).rows));
    revalidatePath("/verwaltung", "layout");
    return { ...res, csv: credentialsCsv(res.created) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Import fehlgeschlagen" };
  }
}
