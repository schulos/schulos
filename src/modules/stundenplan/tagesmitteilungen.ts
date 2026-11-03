// VT-01: Tagesmitteilungen im Vertretungsplan („6. Stunde Schulversammlung in der Aula“) – kurzer Text ohne Personen, an alle oder
// nur an Beschäftigte. Folgen der Tagesfreigabe (Q5-11): an einem Entwurfstag sieht sie nur die Planung. Anzeige in Vertretungsplan,
// Monitor und Druck folgt mit VT-02; gepflegt wird auf `/planung/vertretungen` (Recht `stundenplan.substitute`).
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { timetableDayNotes } from "@/core/db/schema";
import { isCalendarDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { DAY_NOTE_AUDIENCES, INTERNAL_NOTE_MAX, type DayNoteAudience } from "./schema";
import { draftDays } from "./freigabe";
import { listRoomBlocks } from "./raumsperren";

export const DAY_NOTE_AUDIENCE_LABELS: Record<DayNoteAudience, string> = { alle: "alle", beschaeftigte: "nur Beschäftigte" };

export interface DayNoteInput {
  date: string;
  body: string;
  audience: string;
}

export interface DayNote {
  id: string;
  date: string;
  body: string;
  audience: DayNoteAudience;
  /** Tag ist noch Entwurf (nur mit `drafts: true` enthalten) */
  draft: boolean;
  /** VA-04: abgeleitete Zeile aus einer Raumsperre (nicht in `timetable_day_notes`, nicht bearbeitbar) */
  derived?: boolean;
}

/** Rein: „3.–4. Std.“, „3. Std.“, ganztägig → „ganztägig“. */
export function periodsText(from: number | null, to: number | null): string {
  if (from === null || to === null) return "ganztägig";
  return from === to ? `${from}. Std.` : `${from}.–${to}. Std.`;
}

/**
 * VA-04: Hinweiszeile zu einer Raumsperre durch eine Veranstaltung – „Raum 2.14 gesperrt (Veranstaltung), 3.–4. Std.“. Bewusst ohne
 * den Veranstaltungstitel (die Notiz der Sperre bleibt intern bei Hausmeisterei und Planung).
 */
export function roomBlockNoteText(b: { roomId: string; fromPeriod: number | null; toPeriod: number | null }): string {
  return `Raum ${b.roomId} gesperrt (Veranstaltung), ${periodsText(b.fromPeriod, b.toPeriod)}`;
}

/** Tagesmitteilung anlegen (`id` leer) oder ändern. */
export async function saveDayNote(db: Db, actorId: string, id: string | null, input: DayNoteInput): Promise<string> {
  const fe: Record<string, string> = {};
  const body = input.body.trim();
  if (!isCalendarDate(input.date)) fe.date = "Datum angeben";
  if (!body) fe.body = "Text eingeben";
  else if (body.length > INTERNAL_NOTE_MAX) fe.body = `Höchstens ${INTERNAL_NOTE_MAX} Zeichen`;
  if (!(DAY_NOTE_AUDIENCES as readonly string[]).includes(input.audience)) fe.audience = "Zielgruppe wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const audience = input.audience as DayNoteAudience;
  let noteId = id;
  if (id) {
    const done = await db
      .update(timetableDayNotes)
      .set({ date: input.date, body, audience, updatedAt: new Date() })
      .where(eq(timetableDayNotes.id, id))
      .returning({ id: timetableDayNotes.id });
    if (!done.length) throw new ValidationError({ body: "Diese Mitteilung gibt es nicht (mehr)" });
  } else {
    const n = await db.$count(timetableDayNotes, eq(timetableDayNotes.date, input.date));
    const [row] = await db.insert(timetableDayNotes).values({ date: input.date, body, audience, sortOrder: n, createdBy: actorId }).returning({ id: timetableDayNotes.id });
    noteId = row!.id;
  }
  await audit(db, actorId, "stundenplan.daynote.save", null, { date: input.date, audience });
  return noteId!;
}

export async function deleteDayNote(db: Db, actorId: string, id: string): Promise<void> {
  const [gone] = await db.delete(timetableDayNotes).where(eq(timetableDayNotes.id, id)).returning({ date: timetableDayNotes.date });
  if (gone) await audit(db, actorId, "stundenplan.daynote.delete", null, { date: gone.date });
}

/**
 * Tagesmitteilungen der Tage: `staff` = auch „nur Beschäftigte“; Entwurfstage nur mit `drafts: true` (Vertretungsplanung).
 * `roomBlocks` (VA-04, Vertretungsplan/Monitor/Druck): dazu je Raumsperre „Veranstaltung“ eine abgeleitete Zeile, nach den Mitteilungen.
 */
export async function dayNotesOn(db: Db, dates: readonly string[], opts: { drafts?: boolean; staff?: boolean; roomBlocks?: boolean } = {}): Promise<DayNote[]> {
  if (!dates.length) return [];
  const drafts = await draftDays(db, [...dates]);
  const visible = opts.drafts ? [...dates] : dates.filter((d) => !drafts.has(d));
  if (!visible.length) return [];
  const rows = await db
    .select()
    .from(timetableDayNotes)
    .where(and(inArray(timetableDayNotes.date, visible), opts.staff ? undefined : eq(timetableDayNotes.audience, "alle")))
    .orderBy(asc(timetableDayNotes.date), asc(timetableDayNotes.sortOrder), asc(timetableDayNotes.createdAt));
  const notes: DayNote[] = rows.map((r) => ({ id: r.id, date: r.date, body: r.body, audience: r.audience, draft: drafts.has(r.date) }));
  if (opts.roomBlocks) {
    const blocks = (await listRoomBlocks(db, visible.reduce((a, b) => (a < b ? a : b)))).filter((b) => b.reason === "veranstaltung");
    for (const date of [...visible].sort()) {
      for (const b of blocks.filter((x) => x.startsOn <= date && x.endsOn >= date)) {
        notes.push({ id: `block-${b.id}-${date}`, date, body: roomBlockNoteText(b), audience: "alle", draft: drafts.has(date), derived: true });
      }
    }
    notes.sort((a, b) => a.date.localeCompare(b.date) || Number(Boolean(a.derived)) - Number(Boolean(b.derived)));
  }
  return notes;
}
