// Stammdaten Ferien und unterrichtsfreie Tage (Feiertage berechnet der Schulkalender selbst).
import { eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { CLOSURE_KINDS, schoolClosures, type ClosureKind } from "@/core/db/schema";
import { rememberDeletedImport } from "./ferien-abruf";
import { ValidationError } from "./users";

export interface ClosureInput {
  /** leer = neuer Eintrag (Schlüssel „new“ in den Feldfehlern) */
  id?: string;
  kind: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => ISO_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
/** Länger als zehn Wochen ist kein Ferienblock – vermutlich ein Tippfehler im Jahr */
const MAX_DAYS = 70;

/** Prüft alle Einträge zusammen: Pflichtfelder, Zeitraum, keine überlappenden Ferien. */
export function checkClosures(rows: readonly ClosureInput[]): Record<string, string> {
  const fe: Record<string, string> = {};
  const key = (r: ClosureInput) => r.id ?? "new";
  for (const r of rows) {
    const k = key(r);
    if (!(CLOSURE_KINDS as readonly string[]).includes(r.kind)) fe[`kind-${k}`] = "Art wählen";
    if (!r.name.trim()) fe[`name-${k}`] = "Bezeichnung angeben";
    if (!isDate(r.startsOn)) fe[`start-${k}`] = "Datum angeben";
    if (!isDate(r.endsOn)) fe[`end-${k}`] = "Datum angeben";
    else if (isDate(r.startsOn)) {
      const days = (Date.parse(r.endsOn) - Date.parse(r.startsOn)) / 86_400_000;
      if (days < 0) fe[`end-${k}`] = "Ende vor dem Beginn";
      else if (days > MAX_DAYS) fe[`end-${k}`] = "Mehr als zehn Wochen – Jahr prüfen";
    }
  }
  const ferien = rows.filter((r) => r.kind === "ferien" && isDate(r.startsOn) && isDate(r.endsOn)).toSorted((a, b) => a.startsOn.localeCompare(b.startsOn));
  for (let i = 1; i < ferien.length; i++) {
    if (ferien[i]!.startsOn <= ferien[i - 1]!.endsOn) fe[`start-${key(ferien[i]!)}`] ??= `Überschneidet sich mit „${ferien[i - 1]!.name.trim()}“`;
  }
  return fe;
}

/** Speichert alle Einträge und hängt optional einen neuen an. */
export async function saveClosures(db: Db, actorId: string, rows: ClosureInput[], added?: ClosureInput): Promise<void> {
  const all = added ? [...rows, { ...added, id: undefined }] : rows;
  const fe = checkClosures(all);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const before = new Map((await db.select().from(schoolClosures)).map((c) => [c.id, c]));
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const old = before.get(r.id!);
      const changed = !old || old.kind !== r.kind || old.name !== r.name.trim() || old.startsOn !== r.startsOn || old.endsOn !== r.endsOn;
      if (!changed) continue;
      // von Hand geändert → gilt ab jetzt als Handpflege, der automatische Abruf fasst den Eintrag nicht mehr an
      await tx
        .update(schoolClosures)
        .set({ kind: r.kind as ClosureKind, name: r.name.trim(), startsOn: r.startsOn, endsOn: r.endsOn, source: null })
        .where(eq(schoolClosures.id, r.id!));
    }
    if (added) await tx.insert(schoolClosures).values({ kind: added.kind as ClosureKind, name: added.name.trim(), startsOn: added.startsOn, endsOn: added.endsOn });
  });
  await audit(db, actorId, "verwaltung.stammdaten.closures", null, { count: rows.length, added: added?.name.trim() ?? null });
}

export async function deleteClosure(db: Db, actorId: string, id: string): Promise<void> {
  const [row] = await db.delete(schoolClosures).where(eq(schoolClosures.id, id)).returning({ name: schoolClosures.name, externalId: schoolClosures.externalId });
  if (row?.externalId) await rememberDeletedImport(db, row.externalId);
  if (row) await audit(db, actorId, "verwaltung.stammdaten.closure_delete", id, { name: row.name });
}
