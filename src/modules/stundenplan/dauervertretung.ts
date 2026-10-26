// SP2-08 (SP-G-09, SP-G-10): Dauervertretung für den Zeitraum einer Abwesenheit und Vertretungsbedarf im Wochenblick.
// Dauervertretung = einmal festlegen, gilt für jede betroffene Stunde im Zeitraum (je Tag eine gewöhnliche Vertretung, also einzeln
// überschreib- und aufhebbar). Tage, an denen die Stunde schon geregelt ist oder die Vertretung nicht kann, bleiben unverändert und
// werden genannt.
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableLessons } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { absenceCovers, absencesBetween, needsOn } from "./abwesenheit";
import { lessonActiveOn } from "./service";
import { saveSubstitution, substitutionsOn } from "./vertretung";

export interface PermanentInput {
  lessonId: string;
  /** erster Tag (Tag der bearbeiteten Stunde) */
  from: string;
  absenceId: string;
  substituteId: string;
  subjectId?: string | null;
  roomId?: string | null;
  note?: string | null;
}

export interface PermanentResult {
  saved: string[];
  skipped: { date: string; reason: string }[];
}

/** Dauervertretung: dieselbe Vertretung an allen Tagen der Abwesenheit ab `from`, an denen die Stunde stattfindet und noch offen ist. */
export async function savePermanentSubstitution(db: Db, actorId: string, input: PermanentInput): Promise<PermanentResult> {
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, input.lessonId));
  const absence = (await absencesBetween(db, input.from, "9999-12-31")).find((a) => a.id === input.absenceId);
  if (!l || !absence || !absence.teacherId || absence.teacherId !== l.teacherId) throw new ValidationError({ absenceId: "Abwesenheit der Lehrkraft dieser Stunde wählen" });
  // R1b/A11: ohne Vertretungslehrkraft gar nicht erst versuchen (sonst „an 0 Tagen eingetragen … benachrichtigt“)
  if (!input.substituteId) throw new ValidationError({ substituteId: "Vertretungslehrkraft wählen" });
  const cal = await loadSchoolCalendar(db);
  const out: PermanentResult = { saved: [], skipped: [] };
  for (let d = input.from < absence.startsOn ? absence.startsOn : input.from; d <= absence.endsOn; d = addDays(d, 1)) {
    if (cal.dayOff(d) || !lessonActiveOn(l, d) || !absenceCovers(absence, d, l.periodNr)) continue;
    const existing = (await substitutionsOn(db, [d], { drafts: true })).find((e) => e.lessonId === l.id && e.movedFrom === null);
    if (existing && d !== input.from) {
      out.skipped.push({ date: d, reason: "schon geregelt" });
      continue;
    }
    try {
      await saveSubstitution(db, actorId, { lessonId: l.id, date: d, kind: "substitute", substituteId: input.substituteId, roomId: input.roomId ?? null, note: input.note ?? null, subjectId: input.subjectId ?? null });
      out.saved.push(d);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      out.skipped.push({ date: d, reason: Object.values(err.fieldErrors)[0] ?? "geht nicht" });
    }
  }
  // R1b/A11: an keinem Tag eingetragen → Fehler mit den Gründen statt Erfolgsmeldung
  if (out.saved.length === 0) {
    const why = out.skipped.map((s) => `${ddmm(s.date)} (${s.reason})`).join(", ");
    throw new ValidationError({ substituteId: why ? `Dauervertretung an keinem Tag eingetragen: ${why}` : "Dauervertretung an keinem Tag eingetragen – die Stunde findet im Zeitraum nicht statt" });
  }
  return out;
}

const ddmm = (ymd: string) => `${ymd.slice(8)}.${ymd.slice(5, 7)}.`;

/** Rückmeldung nach einer Dauervertretung: „an 3 Tagen eingetragen; nicht am 07.10. (…)“. Rein. */
export function permanentMessage(r: PermanentResult): string {
  const saved = r.saved.length === 1 ? "an 1 Tag eingetragen" : `an ${r.saved.length} Tagen eingetragen`;
  const skipped = r.skipped.map((s) => `${ddmm(s.date)} (${s.reason})`).join(", ");
  return `Dauervertretung ${saved}${skipped ? `; nicht am ${skipped}` : ""} – Betroffene sind benachrichtigt.`;
}

export interface WeekNeed {
  date: string;
  open: number;
  settled: number;
  absences: number;
}

/** Wochenblick: Vertretungsbedarf der nächsten `days` Schultage ab `from` (offen / geregelt / Abwesenheiten). */
export async function weekNeeds(db: Db, from: string, days = 5): Promise<WeekNeed[]> {
  const cal = await loadSchoolCalendar(db);
  const out: WeekNeed[] = [];
  for (let d = cal.nextSchoolDay(from); out.length < days; d = cal.nextSchoolDay(addDays(d, 1))) {
    const n = await needsOn(db, d);
    out.push({ date: d, open: n.open.filter((o) => o.status === "open").length, settled: n.open.filter((o) => o.status !== "open").length, absences: n.absences.length });
  }
  return out;
}
