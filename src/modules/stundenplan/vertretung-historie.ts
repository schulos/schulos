// VT-01 (F-10-13): Historie der Vertretungen – jeder Schreibvorgang an `timetable_substitutions` (Speichern, Aufheben, Stufe 2,
// Dauervertretung, Solver-Übernahme/-Rücknahme, Löschen einer Stunde) hinterlässt einen Eintrag mit Vorher/Nachher. Nur für die
// Planung (`stundenplan.substitute`); Grundlage für den Marker „neu/geändert seit …“ (VT-02). Bewusst ohne schwere Abhängigkeiten.
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableSubstitutionChanges, timetableSubstitutions } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import type { SubstitutionChangeAction, SubstitutionKind, SubstitutionReason, TimetableSubstitution } from "./schema";

/** Felder einer Vertretung in der Historie (JSON). Nur `substituteId` ist eine Personenkennung (Bereinigung bei Kontolöschung). */
export interface SubstitutionSnapshot {
  lessonId: string;
  kind: SubstitutionKind;
  substituteId: string | null;
  roomId: string | null;
  subjectId: string | null;
  targetPeriod: number | null;
  mergeLessonId: string | null;
  note: string | null;
  internalNote: string | null;
  reason: SubstitutionReason | null;
  supervisionOnly: boolean;
}

type SnapshotSource = Pick<TimetableSubstitution, "lessonId" | "kind" | "substituteId" | "roomId" | "subjectId" | "targetPeriod" | "mergeLessonId" | "note"> &
  Partial<Pick<TimetableSubstitution, "internalNote" | "reason" | "supervisionOnly">>;

/** Rein: Historien-Stand einer Vertretungszeile. */
export function snapshotOf(s: SnapshotSource): SubstitutionSnapshot {
  return {
    lessonId: s.lessonId,
    kind: s.kind,
    substituteId: s.substituteId,
    roomId: s.roomId,
    subjectId: s.subjectId,
    targetPeriod: s.targetPeriod,
    mergeLessonId: s.mergeLessonId,
    note: s.note,
    internalNote: s.internalNote ?? null,
    reason: s.reason ?? null,
    supervisionOnly: s.supervisionOnly ?? false,
  };
}

/** Rein: welche Felder unterscheiden sich (für die Anzeige „geändert: Vertretung, Raum“ in VT-02)? */
export function changedFields(before: SubstitutionSnapshot | null, after: SubstitutionSnapshot | null): (keyof SubstitutionSnapshot)[] {
  if (!before || !after) return [];
  return (Object.keys(after) as (keyof SubstitutionSnapshot)[]).filter((k) => before[k] !== after[k]);
}

export interface ChangeEntry {
  action: SubstitutionChangeAction;
  date: string;
  lessonId: string | null;
  substitutionId: string | null;
  before: SubstitutionSnapshot | null;
  after: SubstitutionSnapshot | null;
}

/**
 * Historien-Einträge schreiben (in der Transaktion des Schreibvorgangs). Ein „update“ ohne geänderte Felder (erneutes Speichern)
 * entfällt. Gibt die Zahl der geschriebenen Einträge zurück.
 */
export async function recordSubstitutionChanges(db: Db, actorId: string | null, entries: readonly ChangeEntry[]): Promise<number> {
  const rows = entries
    .filter((e) => !(e.before && e.after && changedFields(e.before, e.after).length === 0))
    .map((e) => ({ action: e.action, date: e.date, lessonId: e.lessonId, substitutionId: e.substitutionId, before: e.before, after: e.after, actorId }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(timetableSubstitutionChanges).values(rows.slice(i, i + 500));
  return rows.length;
}

/**
 * Löschungen bekannter Zeilen als Einträge (z. B. `.delete(…).returning()`). Die Zeile gibt es dann nicht mehr – `substitution_id`
 * bleibt leer (wie bei den älteren Einträgen derselben Vertretung, die der Fremdschlüssel leert); zugeordnet wird über Stunde und Tag.
 */
export function deletedEntries(rows: readonly TimetableSubstitution[], action: SubstitutionChangeAction = "delete"): ChangeEntry[] {
  return rows.map((r) => ({ action, date: r.date, lessonId: r.lessonId, substitutionId: null, before: snapshotOf(r), after: null }));
}

/**
 * Vertretungen an Stunden, die gleich gelöscht werden (Kaskade über `lesson_id`), vorher in die Historie schreiben – ab `fromYmd`
 * (leer = alle). Aufrufen in derselben Transaktion direkt vor dem Löschen der Stunden.
 */
export async function recordLessonCascade(db: Db, actorId: string | null, lessonIds: readonly string[], action: SubstitutionChangeAction, fromYmd?: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < lessonIds.length; i += 500) {
    const part = lessonIds.slice(i, i + 500);
    const where = fromYmd ? and(inArray(timetableSubstitutions.lessonId, part), gte(timetableSubstitutions.date, fromYmd)) : inArray(timetableSubstitutions.lessonId, part);
    const rows = await db.select().from(timetableSubstitutions).where(where);
    n += await recordSubstitutionChanges(db, actorId, deletedEntries(rows, action));
  }
  return n;
}

/** Historie mitnehmen, wenn Vertretungen ab `fromYmd` auf eine neue Stunde umgehängt werden (Periode, Solver-Teilung). */
export async function moveChangeHistory(db: Db, fromId: string, toId: string, fromYmd: string): Promise<void> {
  await db
    .update(timetableSubstitutionChanges)
    .set({ lessonId: toId })
    .where(and(eq(timetableSubstitutionChanges.lessonId, fromId), gte(timetableSubstitutionChanges.date, fromYmd)));
}

/** VT-02: Verlauf je Stunde (nur Planung) – was ist passiert? */
export const CHANGE_ACTION_LABEL: Record<SubstitutionChangeAction, string> = {
  create: "angelegt",
  update: "geändert",
  delete: "aufgehoben",
  plan_publish: "durch Planübernahme entfernt",
  plan_undo: "Planübernahme zurückgenommen",
};

/** VT-02: Feldnamen im Verlauf. */
export const CHANGE_FIELD_LABEL: Record<keyof SubstitutionSnapshot, string> = {
  lessonId: "Stunde",
  kind: "Art",
  substituteId: "Vertretung",
  roomId: "Raum",
  subjectId: "Fach",
  targetPeriod: "Zielstunde",
  mergeLessonId: "Zusammenlegung",
  note: "Hinweis",
  internalNote: "interne Notiz",
  reason: "Grund",
  supervisionOnly: "Betreuung",
};

/** Rein: Zeile im Verlauf – „geändert: Vertretung, Raum“, „angelegt“. */
export function describeChange(c: Pick<SubstitutionChangeView, "action" | "changed">): string {
  // feste Reihenfolge (jsonb ordnet die Schlüssel selbst)
  const order = Object.keys(CHANGE_FIELD_LABEL) as (keyof SubstitutionSnapshot)[];
  const fields = c.action === "update" ? order.filter((f) => c.changed.includes(f)).map((f) => CHANGE_FIELD_LABEL[f]) : [];
  return fields.length ? `${CHANGE_ACTION_LABEL[c.action]}: ${fields.join(", ")}` : CHANGE_ACTION_LABEL[c.action];
}

/** VT-02: Felder, die nur intern sind – eine Änderung nur daran löst keinen öffentlichen Marker aus. */
const INTERNAL_FIELDS: ReadonlySet<keyof SubstitutionSnapshot> = new Set(["internalNote"]);

/** Rein: ist der Eintrag für den öffentlichen Marker „geändert“ relevant (nicht gelöscht, nicht nur interne Felder)? */
export function publicChange(before: SubstitutionSnapshot | null, after: SubstitutionSnapshot | null): boolean {
  if (!after) return false;
  if (!before) return true;
  return changedFields(before, after).some((f) => !INTERNAL_FIELDS.has(f));
}

/**
 * VT-02 (F-10-13): Stunden (`lessonId:date`), deren Vertretung seit `since` sichtbar geändert wurde – Grundlage des Markers
 * „geändert“ in Vertretungsplan und Monitor. Liefert nur die Schlüssel, keine Inhalte (auch kein interner Hinweis).
 */
export async function changedSince(db: Db, keys: readonly { lessonId: string; date: string }[], since: Date): Promise<Set<string>> {
  const out = new Set<string>();
  if (!keys.length) return out;
  const t = timetableSubstitutionChanges;
  const wanted = new Set(keys.map((k) => `${k.lessonId}:${k.date}`));
  const lessonIds = [...new Set(keys.map((k) => k.lessonId))];
  const dates = [...new Set(keys.map((k) => k.date))];
  for (let i = 0; i < lessonIds.length; i += 500) {
    const rows = await db
      .select({ lessonId: t.lessonId, date: t.date, before: t.before, after: t.after })
      .from(t)
      .where(and(inArray(t.lessonId, lessonIds.slice(i, i + 500)), inArray(t.date, dates), gte(t.createdAt, since)));
    for (const r of rows) {
      const key = `${r.lessonId}:${r.date}`;
      if (wanted.has(key) && publicChange((r.before as SubstitutionSnapshot | null) ?? null, (r.after as SubstitutionSnapshot | null) ?? null)) out.add(key);
    }
  }
  return out;
}

export interface SubstitutionChangeView {
  id: string;
  action: SubstitutionChangeAction;
  date: string;
  lessonId: string | null;
  substitutionId: string | null;
  before: SubstitutionSnapshot | null;
  after: SubstitutionSnapshot | null;
  changed: (keyof SubstitutionSnapshot)[];
  actorId: string | null;
  createdAt: Date;
}

/** Historie der Tage `from`…`to` (optional nur einer Stunde) – nur für die Vertretungsplanung (F-10-13). */
export async function substitutionHistory(db: Db, perms: PermissionSet, from: string, to: string, lessonId?: string): Promise<SubstitutionChangeView[]> {
  if (!hasPermission(perms, "stundenplan.substitute")) throw new ForbiddenError("stundenplan.substitute");
  const t = timetableSubstitutionChanges;
  const rows = await db
    .select()
    .from(t)
    .where(and(gte(t.date, from), lte(t.date, to), lessonId ? eq(t.lessonId, lessonId) : undefined))
    .orderBy(asc(t.date), asc(t.createdAt));
  return rows.map((r) => {
    const before = (r.before as SubstitutionSnapshot | null) ?? null;
    const after = (r.after as SubstitutionSnapshot | null) ?? null;
    return { id: r.id, action: r.action, date: r.date, lessonId: r.lessonId, substitutionId: r.substitutionId, before, after, changed: changedFields(before, after), actorId: r.actorId, createdAt: r.createdAt };
  });
}
