// GT-04: Abgleich der Ganztagslisten mit den Abwesenheiten (docs/GANZTAG.md). Übernommen wird nur die Quelle – ob eine
// Krankmeldung bzw. Beurlaubung vorliegt und wie die Klassenleitung entschieden hat –, nie der Grund. Es gibt keine
// Schreibverbindung in die Abwesenheiten oder ins Klassenbuch; gelesen wird nur.
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { absenceReports, ganztagMarks, type GanztagExcused } from "@/core/db/schema";
import { excusedStateOn } from "@/modules/abwesenheiten/service";

/**
 * Stand aus den Abwesenheiten an einem Tag: `ja` = Beurlaubung, Meldung „entschuldigt“ oder noch offene Meldung („gemeldet“,
 * z. B. krank gemeldet); `nein` = Klassenleitung hat „nicht entschuldigt“ entschieden. Ohne Eintrag: keine Meldung.
 */
export async function absenceCoverage(db: Db, studentIds: readonly string[], date: string): Promise<Map<string, Exclude<GanztagExcused, "offen">>> {
  const ids = [...new Set(studentIds)];
  const out = new Map<string, Exclude<GanztagExcused, "offen">>();
  if (ids.length === 0) return out;
  const decided = await excusedStateOn(db, ids, date);
  for (const [id, ok] of decided) out.set(id, ok ? "ja" : "nein");
  const reported = await db
    .select({ studentId: absenceReports.studentId })
    .from(absenceReports)
    .where(and(inArray(absenceReports.studentId, ids), eq(absenceReports.status, "gemeldet"), lte(absenceReports.fromDate, date), gte(absenceReports.toDate, date)));
  for (const r of reported) out.set(r.studentId, "ja");
  return out;
}

/** `entschuldigt?` einer Zeile „fehlt“ aus dem Stand der Abwesenheiten (ohne Meldung: offen). */
export const excusedFor = (coverage: ReadonlyMap<string, Exclude<GanztagExcused, "offen">>, studentId: string): GanztagExcused => coverage.get(studentId) ?? "offen";

/**
 * Eine Liste mit den Abwesenheiten abgleichen:
 * - Zeilen „fehlt“ bekommen `entschuldigt` aus dem aktuellen Stand (ja/nein/offen) – auch, wenn eine Meldung später kommt.
 * - Vorbelegungen (Herkunft `abwesenheiten`), deren Meldung es nicht mehr gibt, fallen weg.
 * - Mit `prefill`: Teilnehmende ohne Markierung mit Meldung bzw. Beurlaubung werden „fehlt (entschuldigt)“ vorbelegt
 *   (Herkunft `abwesenheiten`, ohne „erfasst von“). Die Leitung kann die Zeile jederzeit ändern.
 * Gibt zurück, ob sich etwas geändert hat.
 */
export async function reconcileSession(
  db: Db,
  session: { id: string; date: string },
  participants: readonly string[],
  opts: { prefill: boolean },
): Promise<boolean> {
  const marks = await db
    .select({ studentId: ganztagMarks.studentId, status: ganztagMarks.status, excused: ganztagMarks.excused, source: ganztagMarks.source })
    .from(ganztagMarks)
    .where(eq(ganztagMarks.sessionId, session.id));
  const coverage = await absenceCoverage(db, [...participants, ...marks.map((m) => m.studentId)], session.date);
  let changed = false;
  for (const m of marks) {
    if (m.status !== "fehlt") continue;
    const state = coverage.get(m.studentId);
    const where = and(eq(ganztagMarks.sessionId, session.id), eq(ganztagMarks.studentId, m.studentId));
    if (m.source === "abwesenheiten" && !state) {
      await db.delete(ganztagMarks).where(where);
      changed = true;
    } else if ((state ?? "offen") !== m.excused) {
      await db.update(ganztagMarks).set({ excused: state ?? "offen" }).where(where);
      changed = true;
    }
  }
  if (opts.prefill) {
    const marked = new Set(marks.map((m) => m.studentId));
    const fresh = participants.filter((id) => !marked.has(id) && coverage.get(id) === "ja");
    if (fresh.length) {
      await db
        .insert(ganztagMarks)
        .values(fresh.map((studentId) => ({ sessionId: session.id, studentId, status: "fehlt" as const, excused: "ja" as const, source: "abwesenheiten" as const, recordedBy: null })))
        .onConflictDoNothing();
      changed = true;
    }
  }
  return changed;
}
