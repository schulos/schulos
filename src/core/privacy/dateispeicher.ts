// Dateispeicher aufräumen: Dateien, auf die kein Datensatz mehr verweist (nach Löschlauf bzw. Kontolöschung).
// SEC-05: Die Spalten mit Dateischlüsseln stehen ausdrücklich in STORAGE_KEY_COLUMNS – früher wurden nur Spalten namens
// `storage_key` erkannt und Elternbrief-Anhänge (`attachment_key`) nachts gelöscht. dateispeicher.test.ts prüft, dass
// jede Schlüssel-Spalte im Schema hier steht (oder in NOT_STORAGE_KEY_COLUMNS begründet ist).
import { sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import type { FileStorage } from "@/core/files/storage";

const id = (name: string) => sql.raw(`"${name.replace(/"/g, "")}"`);

/** Spalten, die auf eine Datei im Speicher verweisen. Neue Datei-Verweise gehören hier hinein. */
export const STORAGE_KEY_COLUMNS: readonly { table: string; column: string }[] = [
  { table: "file_nodes", column: "storage_key" },
  { table: "task_files", column: "storage_key" },
  { table: "profile_photos", column: "storage_key" },
  { table: "parent_letters", column: "attachment_key" },
  { table: "gebaeude_ticket_photos", column: "storage_key" },
  { table: "gebaeude_inspections", column: "report_key" },
  { table: "timetable_absence_materials", column: "file_key" },
  // RS-04: Raumfotos und ihre Vorschaubilder
  { table: "room_photos", column: "storage_key" },
  { table: "room_photos", column: "thumb_key" },
  // HB-05: Anhänge der Handbuchseiten
  { table: "hilfe_attachments", column: "storage_key" },
];

/** Spalten mit „key“ im Namen, die keine Dateischlüssel sind – mit Begründung. */
export const NOT_STORAGE_KEY_COLUMNS: Record<string, string> = {
  "chat_rooms.direct_key": "Kennung eines Direktchats (Personenpaar)",
  "notifications.bundle_key": "Bündel eines Gongs, z. B. „stundenplan:<datum>“ (Q5-03)",
  "rate_limits.key": "HMAC-Schlüssel eines Rate-Limit-Zählers (P4-31)",
  "auth_throttle.key": "Benutzername bzw. IP des Fehlversuchszählers",
  "passkeys.public_key": "öffentlicher Schlüssel eines Sicherheitsschlüssels (SEC-03), keine Datei",
  "gebaeude_inspection_types.template_key": "Schlüssel des Vorlage-Eintrags einer Prüfart (pruefarten.ts)",
  "buecherei_titles.keywords": "Schlagwörter eines Bücherei-Titels (Freitext), keine Datei",
  "app_settings.key": "Name einer Einstellung – Dateischlüssel in Werten (Schullogo) meldet src/core/school/logo.ts per registerStorageKeySource",
};

/**
 * Weitere Quellen für Dateischlüssel außerhalb von Tabellenspalten (Schullogo in app_settings, src/core/school/logo.ts).
 * Jede Quelle liefert die Schlüssel, die der Aufräumlauf nicht löschen darf.
 */
export type StorageKeySource = (db: Db) => Promise<string[]>;
// am globalThis: Server-Bundles (Jobs, Route Handler) teilen sich sonst keine Modulvariablen
const g = globalThis as unknown as { __schulosStorageKeySources?: StorageKeySource[] };
const extraSources = (g.__schulosStorageKeySources ??= []);

export function registerStorageKeySource(source: StorageKeySource): void {
  if (!extraSources.includes(source)) extraSources.push(source);
}

/** Alle Schlüssel, auf die etwas verweist. */
export async function referencedStorageKeys(db: Db): Promise<Set<string>> {
  const known = new Set<string>();
  for (const { table, column } of STORAGE_KEY_COLUMNS) {
    const res = await db.execute(sql`select ${id(column)} as k from ${id(table)} where ${id(column)} is not null`);
    for (const r of rowsOf<{ k: string }>(res)) known.add(r.k);
  }
  for (const source of extraSources) for (const k of await source(db)) known.add(k);
  return known;
}

/** Löscht Dateien ohne Datensatz. Frische Dateien (< 1 Stunde) bleiben – ein Upload kann gerade laufen. */
export async function sweepOrphanFiles(db: Db, storage: FileStorage, now: Date): Promise<number> {
  const known = await referencedStorageKeys(db);
  const limit = now.getTime() - 60 * 60 * 1000;
  let removed = 0;
  for (const f of await storage.list()) {
    if (known.has(f.key) || f.modifiedAt.getTime() > limit) continue;
    await storage.delete(f.key);
    removed++;
  }
  return removed;
}
