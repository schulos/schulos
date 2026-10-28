// SP3-04 (F-10-1): die frühere direkte Übernahme eines Solver-Laufs in den gültigen Plan (SP-09, Übergangsweg bis zum Veröffentlichen) –
// **nur noch für Tests**. Im Produkt geht ein Lauf in einen Entwurf (`applyRunToDraft`) und der gültige Plan ändert sich nur über
// `publishVersion()` (veroeffentlichen.ts). Die Rücknahme schon übernommener Läufe (`undoApply`) bleibt bis zu ihrem Stichtag; ihre Tests
// brauchen einen übernommenen Lauf, den diese Hilfe wie früher anlegt (Rücknahme-Daten im alten Format, Teilen am Zeitraumende).
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { timetableLessons, timetableSolverRuns, timetableSubstitutions, users, type TimetableLesson, type TimetableSubstitution } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, isCalendarDate, TZ, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  assignmentValidity,
  getRun,
  LOG_LIMIT,
  logEntry,
  moveReferences,
  proposedLessons,
  roomClashes,
  runPeriod,
  withCouplingIds,
  type ProposedLesson,
  type SolverRun,
  type UndoData,
  type UndoSubstitution,
} from "./solverlauf";
import { planningYear } from "./verteilung";
import { deletedEntries, recordSubstitutionChanges } from "./vertretung-historie";

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const CHUNK = 500;
const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Stunden, die die Übernahme ab `fromYmd` ersetzen würde: gültig zwischen dem Stichtag und dem Ende des Planungszeitraums
 * (`untilYmd`), nicht fixiert, nicht „bleibt“ (ohne Lehrauftrag). Stunden, die erst nach dem Zeitraum beginnen, bleiben (A2).
 */
async function replaceableLessons(db: Db, untilYmd: string, fromYmd: string, kept: Set<string>): Promise<TimetableLesson[]> {
  return (
    await db
      .select()
      .from(timetableLessons)
      .where(and(lte(timetableLessons.validFrom, untilYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, fromYmd))))
  ).filter((l) => !l.fixed && !kept.has(l.id));
}

/**
 * R1a/A2: teilt ersetzbare Stunden, die über das Ende des Planungszeitraums hinaus gelten (wie „Periode kopieren“): die Stunde
 * endet am letzten Tag des Zeitraums, eine Kopie (neue Kopplungs-id je Kopplung, gleiche Herkunft und Anlagezeit) gilt danach bis
 * zum bisherigen Ende; Vertretungen (auch als aufnehmende Stunde), Klassenbuch und Material ab dann ziehen auf die Kopie um.
 */
async function splitAfter(tx: Db, lessons: TimetableLesson[], untilYmd: string): Promise<{ id: string; of: string }[]> {
  const cutoff = addDays(untilYmd, 1);
  const crossing = lessons.filter((l) => l.validUntil === null || l.validUntil > untilYmd);
  if (!crossing.length) return [];
  const couplings = new Map<string, string>();
  const copies = crossing.map((l) => {
    let couplingId: string | null = null;
    if (l.couplingId) {
      if (!couplings.has(l.couplingId)) couplings.set(l.couplingId, crypto.randomUUID());
      couplingId = couplings.get(l.couplingId)!;
    }
    return { ...l, id: crypto.randomUUID(), couplingId, validFrom: cutoff };
  });
  for (const part of chunks(copies)) await tx.insert(timetableLessons).values(part);
  for (const part of chunks(crossing.map((l) => l.id))) await tx.update(timetableLessons).set({ validUntil: untilYmd }).where(inArray(timetableLessons.id, part));
  const out = copies.map((c, i) => ({ id: c.id, of: crossing[i]!.id }));
  for (const { id, of } of out) await moveReferences(tx, of, id, cutoff);
  return out;
}

/** Vertretungen ab `fromYmd` an diesen Stunden – auch Zusammenlegungen anderer Gruppen in diese Stunden (R1a/A1). */
const substitutionsOn = (ids: string[], fromYmd: string) =>
  and(or(inArray(timetableSubstitutions.lessonId, ids), inArray(timetableSubstitutions.mergeLessonId, ids)), gte(timetableSubstitutions.date, fromYmd));

/** Was eine Übernahme ab `fromYmd` ändern würde (Hinweis vor dem Übernehmen, SP-09). */
export interface ApplyPreview {
  from: string;
  /** Stunden, die am Vortag enden */
  ended: number;
  /** Stunden, die ganz entfallen (sie beginnen erst ab dem Stichtag) */
  deleted: number;
  /** Vertretungen ab dem Stichtag an ersetzten Stunden – sie entfallen; das Zurücknehmen stellt sie wieder her, sofern ihre Stunde dann wieder gilt (SP-13) */
  substitutions: number;
  /** Raumbuchungen/Klausuren ab dem Stichtag in Räumen, die der Vorschlag zu dieser Zeit belegt */
  roomClashes: { bookings: number; exams: number };
  /** R1a/A2: Ende des Planungszeitraums, wenn er vor dem Schuljahresende endet (danach bleibt der Plan, wie er ist), sonst `null` */
  until: string | null;
}

export async function applyPreview(db: Db, run: SolverRun, fromYmd: string): Promise<ApplyPreview | null> {
  // SP3-02: im Entwurf gerechnete Läufe gehen nur in einen Entwurf
  if (!run.stored || run.stored.versionId) return null;
  const year = await planningYear(db);
  if (!year) return null;
  const period = await runPeriod(db, year, run.stored);
  const current = await replaceableLessons(db, period.until, fromYmd, new Set(run.stored.keptLessonIds));
  const ids = current.map((l) => l.id);
  const subIds = new Set<string>();
  // nach dem Zeitraumende ziehen Vertretungen auf die Kopie um (Teilen) – sie entfallen nicht
  for (const part of chunks(ids))
    for (const s of await db.select({ id: timetableSubstitutions.id }).from(timetableSubstitutions).where(and(substitutionsOn(part, fromYmd), lte(timetableSubstitutions.date, period.until))))
      subIds.add(s.id);
  const proposal = proposedLessons(run.stored).map((l) => ({ ...l, week: "all" as const, validFrom: fromYmd, validUntil: period.until }));
  return {
    from: fromYmd,
    ended: current.filter((l) => l.validFrom < fromYmd).length,
    deleted: current.filter((l) => l.validFrom >= fromYmd).length,
    substitutions: subIds.size,
    roomClashes: await roomClashes(db, proposal, fromYmd),
    until: period.until < year.endsOn ? period.until : null,
  };
}

/**
 * Übernimmt den Vorschlag ab `fromYmd` (ein Schultag in der Zukunft, im Schuljahr): alle übrigen Stunden des Schuljahres
 * (nicht fixiert, mit Lehrauftrag) enden am Vortag bzw. werden gelöscht, wenn sie erst danach beginnen; Vertretungen ab dem
 * Stichtag an diesen Stunden entfallen. Die vorgeschlagenen Stunden gelten ab dem Stichtag bis zum Schuljahresende und tragen
 * den Lauf als Herkunft (SP-06). Was geändert wurde, steht in `undo` – „Übernahme zurücknehmen“ (SP-09) stellt es bis zum
 * Stichtag wieder her, auch die entfernten Vertretungen, sofern ihre Stunde an dem Tag wieder gilt (SP-13).
 */
export async function applyRun(
  db: Db,
  actorId: string,
  runId: string,
  fromYmd: string,
  todayYmd: string,
): Promise<{ created: number; ended: number; deleted: number; removedSubstitutions: number; expired?: number }> {
  const run = await getRun(db, runId);
  if (!run || run.status !== "done") throw new ValidationError({ run: "Nur ein fertiger, noch nicht übernommener Lauf lässt sich übernehmen" });
  if (!run.stored) throw new ValidationError({ run: "Das Ergebnis dieses Laufs wurde beim Aufräumen entfernt – einen neuen Lauf starten" });
  // SP3-02: ein im Entwurf gerechneter Lauf behält Entwurfsstunden – er geht nur in einen Entwurf (F-10-1)
  if (run.stored.versionId || run.params?.versionId) throw new ValidationError({ run: "Dieser Lauf wurde in einem Entwurf gerechnet – in den Entwurf übernehmen" });
  const year = await planningYear(db);
  if (!year) throw new ValidationError({ run: "Kein Schuljahr" });
  if (!isCalendarDate(fromYmd) || fromYmd <= todayYmd) throw new ValidationError({ from: "Der Stichtag muss in der Zukunft liegen" });
  if (fromYmd < year.startsOn || fromYmd > year.endsOn) throw new ValidationError({ from: "Der Stichtag muss im Schuljahr liegen" });
  const cal = await loadSchoolCalendar(db);
  if (!cal.isSchoolDay(fromYmd)) {
    const next = cal.nextSchoolDay(fromYmd);
    const why = weekdayMon0(fromYmd) >= 5 ? "Wochenende" : (cal.dayOff(fromYmd)?.kind === "feiertag" ? "Feiertag" : "Ferien/frei");
    throw new ValidationError({ from: `Der Stichtag ${dayFmt.format(fromBerlinLocal(fromYmd))} ist kein Schultag (${why}) – nächster Schultag: ${next}` });
  }
  if (run.stored.result.unplaced.length)
    throw new ValidationError({ run: `${run.stored.result.unplaced.length} Stunden ließen sich nicht setzen – erst Lehraufträge oder Sperrzeiten anpassen` });
  const kept = new Set(run.stored.keptLessonIds);
  const proposal = proposedLessons(run.stored);
  const dayBefore = addDays(fromYmd, -1);
  // SP2-09: Gültigkeit der Lehraufträge (aktueller Stand) – eine Stunde endet mit ihrem Lehrauftrag; Lehraufträge, die erst nach dem
  // Stichtag beginnen, würden zu früh gesetzt → Übernahme erst ab ihrem Beginn. Ohne Gültigkeit (oder Lehrauftrag gelöscht): bis Schuljahresende.
  const validity = await assignmentValidity(db, proposal);
  const startsLater = [...validity.values()].map((v) => v.validFrom).filter((v): v is string => v !== null && v > fromYmd).sort();
  if (startsLater.length)
    throw new ValidationError({
      from: `Lehraufträge dieses Laufs gelten erst ab ${dayFmt.format(fromBerlinLocal(startsLater.at(-1)!))} – Übernahme frühestens ab diesem Tag (oder den Lauf mit einem anderen Planungsstand rechnen)`,
    });
  // R1a/A2: nur der Planungszeitraum des Laufs wird ersetzt – vorher (anderer Planungsstand) lässt er sich nicht übernehmen,
  // danach bleibt der Plan, wie er ist (dort gilt ein Lehrauftrag, den der Lauf nicht kennt)
  const period = await runPeriod(db, year, run.stored);
  const periodHint = `Planungsstand ${dayFmt.format(fromBerlinLocal(run.stored.refYmd))}`;
  if (fromYmd < period.from)
    throw new ValidationError({ from: `Dieser Lauf gilt erst ab ${dayFmt.format(fromBerlinLocal(period.from))} (${periodHint}) – Übernahme frühestens ab diesem Tag` });
  if (fromYmd > period.until)
    throw new ValidationError({
      from: `Dieser Lauf gilt nur bis ${dayFmt.format(fromBerlinLocal(period.until))} (${periodHint}; danach gelten andere Lehraufträge) – für einen späteren Stichtag einen Lauf mit passendem Planungsstand rechnen`,
    });
  const untilOf = (l: ProposedLesson) => {
    const v = l.assignmentId ? validity.get(l.assignmentId)?.validUntil : null;
    return v && v < period.until ? v : period.until;
  };
  const expired = proposal.filter((l) => untilOf(l) < fromYmd).length;

  const out = await db.transaction(async (tx) => {
    let current = await replaceableLessons(tx, period.until, fromYmd, kept);
    // Stunden über das Zeitraumende hinaus teilen; ersetzt wird dann nur der Teil im Zeitraum
    const split = period.until < year.endsOn ? await splitAfter(tx, current, period.until) : [];
    if (split.length) current = await replaceableLessons(tx, period.until, fromYmd, kept);
    const ids = current.map((l) => l.id);
    const later = current.filter((l) => l.validFrom >= fromYmd);
    const running = current.filter((l) => l.validFrom < fromYmd);
    const removed: UndoSubstitution[] = [];
    const gone: TimetableSubstitution[] = [];
    for (const part of chunks(ids))
      for (const s of await tx.delete(timetableSubstitutions).where(substitutionsOn(part, fromYmd)).returning()) {
        gone.push(s);
        removed.push({
          id: s.id,
          lessonId: s.lessonId,
          date: s.date,
          kind: s.kind,
          substituteId: s.substituteId,
          roomId: s.roomId,
          note: s.note,
          subjectId: s.subjectId,
          targetPeriod: s.targetPeriod,
          mergeLessonId: s.mergeLessonId,
          createdBy: s.createdBy,
          createdAt: s.createdAt.toISOString(),
          reason: s.reason,
          internalNote: s.internalNote,
          supervisionOnly: s.supervisionOnly,
        });
      }
    // VT-01: die bei der Übernahme entfernten Vertretungen stehen in der Historie (`plan_publish`)
    await recordSubstitutionChanges(tx, actorId, deletedEntries(gone, "plan_publish"));
    const removedSubstitutions = removed.length;
    for (const part of chunks(later.map((l) => l.id))) await tx.delete(timetableLessons).where(inArray(timetableLessons.id, part));
    for (const part of chunks(running.map((l) => l.id))) await tx.update(timetableLessons).set({ validUntil: dayBefore }).where(inArray(timetableLessons.id, part));
    const undo: UndoData = {
      ended: running.map((l) => ({ id: l.id, validUntil: l.validUntil })),
      deleted: later.map(({ id, groupId, weekday, periodNr, subjectId, teacherId, roomId, week, validFrom, validUntil, couplingId, fixed, solverRunId }) => ({ id, groupId, weekday, periodNr, subjectId, teacherId, roomId, week, validFrom, validUntil, couplingId, fixed, solverRunId })),
      removedSubstitutions,
      substitutions: removed,
      ...(split.length ? { split } : {}),
    };
    // SP-14: Lehrkräfte, deren Konto seit dem Lauf gelöscht wurde („gelöschte Lehrkraft“), werden leer – die Stunde bleibt offen
    const knownUsers = new Set((await tx.select({ id: users.id }).from(users)).map((u) => u.id));
    const rows = withCouplingIds(proposal.filter((l) => untilOf(l) >= fromYmd)).map((l) => ({
      groupId: l.groupId,
      subjectId: l.subjectId,
      teacherId: l.teacherId && knownUsers.has(l.teacherId) ? l.teacherId : null,
      roomId: l.roomId,
      weekday: l.weekday,
      periodNr: l.periodNr,
      week: "all" as const,
      validFrom: fromYmd,
      validUntil: untilOf(l),
      couplingId: l.couplingId,
      solverRunId: runId,
    }));
    for (const part of chunks(rows)) await tx.insert(timetableLessons).values(part);
    const result = { created: rows.length, ended: running.length, deleted: later.length, removedSubstitutions, ...(expired ? { expired } : {}) };
    const log = [
      ...run.log,
      logEntry(
        "apply",
        `Übernommen ab ${dayFmt.format(fromBerlinLocal(fromYmd))}: ${result.created} Stunden gesetzt, ${result.ended} bestehende enden am Vortag, ${result.deleted} später beginnende entfallen, ${removedSubstitutions} Vertretungen ab dem Stichtag entfallen${expired ? `, ${expired} Stunden nicht gesetzt (Lehrauftrag endet vor dem Stichtag)` : ""}${period.until < year.endsOn ? `; ersetzt nur bis ${dayFmt.format(fromBerlinLocal(period.until))}${split.length ? ` (${split.length} Stunden dort geteilt)` : ""}` : ""}`,
        { from: fromYmd, ...result, ...(period.until < year.endsOn ? { until: period.until } : {}) },
      ),
    ].slice(-LOG_LIMIT);
    const changed = await tx
      .update(timetableSolverRuns)
      .set({ status: "applied", appliedFrom: fromYmd, appliedBy: actorId, appliedAt: new Date(), undo, log })
      .where(and(eq(timetableSolverRuns.id, runId), eq(timetableSolverRuns.status, "done")))
      .returning({ id: timetableSolverRuns.id });
    if (!changed.length) throw new ValidationError({ run: "Der Lauf wurde inzwischen verändert – Seite neu laden" });
    return result;
  });
  await audit(db, actorId, "stundenplan.solver.apply", null, { run: runId, from: fromYmd, ...out });
  return out;
}
