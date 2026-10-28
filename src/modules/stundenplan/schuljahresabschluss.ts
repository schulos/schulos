// SP3-07 (docs/STUNDENPLAN-LEBENSZYKLUS.md §7.2): Schuljahresabschluss in der Stundenplanung – ein abgelaufenes Schuljahr archivieren
// (die gültige Version wird `archiviert`, offene Entwürfe verworfen; alles bleibt lesbar: Versionsliste, Zeitstrahl, „Plan am Tag X“) und
// eine Kurzstatistik Ausfall/Vertretung je Schuljahr. Die Statistik nennt **keine Personen** (keine Lehrkräfte, keine Klassen), nur Zahlen
// je Art, Grund-Kategorie und Monat – so dürfen sie auch die Prüfung (`stundenplan.review`, Schulleitung) und die Planung ohne
// Vertretungsrecht sehen. Die Statistik mit Lehrkräften bleibt die Vertretungsstatistik (`stundenplan.substitute`).
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { schoolYears, timetableLessons, timetablePlanVersions, timetableSubstitutions } from "@/core/db/schema";
import { ForbiddenError } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { SUBSTITUTION_REASON_LABELS } from "./display";
import { ensureBaseVersions, OPEN_STATUSES, versionNumber } from "./planversionen";
import { PLAN_MANAGE } from "./rechte";
import type { SubstitutionKind, SubstitutionReason, TimetablePlanVersion } from "./schema";
import { lessonActiveOn } from "./service";

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const fmt = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));
const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: TZ });

type Year = typeof schoolYears.$inferSelect;

/** Planung (`manage`) und/oder Prüfung (`review`) – dieselbe Form wie der Viewer der Prüfung (SP3-03). */
export interface ClosingViewer {
  userId: string;
  manage: boolean;
  review: boolean;
}

// ---------------------------------------------------------------- rein: Kurzstatistik

export interface SubstitutionStatRow {
  date: string;
  kind: SubstitutionKind;
  reason: SubstitutionReason | null;
  supervisionOnly: boolean;
}

export interface YearStatistics {
  from: string;
  to: string;
  /** Unterrichtsstunden laut Plan an Schultagen im Zeitraum (je Lerngruppe gezählt) */
  planned: number;
  /** Entfall */
  cancel: number;
  /** Vertretung durch eine andere Lehrkraft (inkl. „nur Betreuung“) */
  substitute: number;
  /** davon nur Betreuung (F-10-9) */
  supervision: number;
  /** Zusammenlegung/Mitbetreuung */
  merge: number;
  /** Verlegung innerhalb des Tages */
  move: number;
  /** nur Raumänderung */
  room: number;
  /** Grund-Kategorien (öffentlich, grob – F-10-8); `null` = ohne Angabe (Bestand vor VT-01) */
  byReason: { reason: SubstitutionReason | null; label: string; count: number }[];
  /** je Monat (`YYYY-MM`) */
  byMonth: { month: string; label: string; cancel: number; substitute: number; other: number }[];
}

/** Rein: Stunden laut Plan an den Schultagen `days` (je Stunde und Lerngruppe; A/B-Woche und Gültigkeit beachtet). */
export function plannedLessons(lessons: readonly { weekday: number; week: string; validFrom: string; validUntil: string | null }[], days: readonly string[]): number {
  let n = 0;
  for (const d of days) for (const l of lessons) if (lessonActiveOn(l, d)) n++;
  return n;
}

/**
 * Rein (SP3-07): Kurzstatistik eines Schuljahrs aus den Änderungen (`timetable_substitutions`) – nur Zahlen je Art, Grund-Kategorie und
 * Monat, keine Personen. Zusammenlegung zählt als eigene Art (in der Vertretungsstatistik als „vertreten“), Verlegung und Raumänderung als
 * „andere Änderung“.
 */
export function summarizeSubstitutions(rows: readonly SubstitutionStatRow[], planned: number, from: string, to: string): YearStatistics {
  const out: YearStatistics = { from, to, planned, cancel: 0, substitute: 0, supervision: 0, merge: 0, move: 0, room: 0, byReason: [], byMonth: [] };
  const reasons = new Map<SubstitutionReason | null, number>();
  const months = new Map<string, { cancel: number; substitute: number; other: number }>();
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    const m = months.get(r.date.slice(0, 7)) ?? { cancel: 0, substitute: 0, other: 0 };
    if (r.kind === "cancel") {
      out.cancel++;
      m.cancel++;
    } else if (r.kind === "substitute") {
      out.substitute++;
      m.substitute++;
      if (r.supervisionOnly) out.supervision++;
    } else {
      out[r.kind]++;
      if (r.kind === "merge") m.substitute++;
      else m.other++;
    }
    months.set(r.date.slice(0, 7), m);
    reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  }
  out.byReason = [...reasons]
    .map(([reason, count]) => ({ reason, label: reason ? SUBSTITUTION_REASON_LABELS[reason] : "ohne Angabe", count }))
    .sort((a, b) => b.count - a.count || (a.reason === null ? 1 : b.reason === null ? -1 : a.label.localeCompare(b.label, "de")));
  out.byMonth = [...months]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, label: monthFmt.format(fromBerlinLocal(`${month}-15`)), ...v }));
  return out;
}

/** Anteil in Prozent mit einer Nachkommastelle (null ohne Grundlage). */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

// ---------------------------------------------------------------- Lesen

/** Kurzstatistik eines Schuljahrs bis heute (laufendes Jahr) bzw. bis Schuljahresende – `null`, solange es nicht begonnen hat. */
export async function yearStatistics(db: Db, year: Pick<Year, "startsOn" | "endsOn">, today: string): Promise<YearStatistics | null> {
  if (today < year.startsOn) return null;
  const from = year.startsOn;
  const to = today < year.endsOn ? today : year.endsOn;
  const [rows, lessons, cal] = await Promise.all([
    db
      .select({ date: timetableSubstitutions.date, kind: timetableSubstitutions.kind, reason: timetableSubstitutions.reason, supervisionOnly: timetableSubstitutions.supervisionOnly })
      .from(timetableSubstitutions)
      .where(and(gte(timetableSubstitutions.date, from), lte(timetableSubstitutions.date, to))),
    db
      .select({ weekday: timetableLessons.weekday, week: timetableLessons.week, validFrom: timetableLessons.validFrom, validUntil: timetableLessons.validUntil })
      .from(timetableLessons)
      .where(and(lte(timetableLessons.validFrom, to), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, from)))),
    loadSchoolCalendar(db),
  ]);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (cal.isSchoolDay(d)) days.push(d);
  return summarizeSubstitutions(rows, plannedLessons(lessons, days), from, to);
}

export interface YearArchiveState {
  /** Schuljahr vorbei (Ende vor heute) */
  ended: boolean;
  /** die (noch) gültige Version */
  valid: { id: string; label: string; name: string } | null;
  /** offene Entwürfe (Entwurf, in Prüfung, freigegeben) */
  open: number;
  /** archiviert: vorbei, keine gültige Version, keine offenen Entwürfe, mindestens eine archivierte Version */
  archived: boolean;
}

export async function yearArchiveState(db: Db, year: Pick<Year, "id" | "endsOn">, today: string): Promise<YearArchiveState> {
  const versions = await db
    .select({ id: timetablePlanVersions.id, status: timetablePlanVersions.status, major: timetablePlanVersions.major, minor: timetablePlanVersions.minor, name: timetablePlanVersions.name })
    .from(timetablePlanVersions)
    .where(eq(timetablePlanVersions.schoolYearId, year.id));
  const valid = versions.find((v) => v.status === "gueltig");
  const open = versions.filter((v) => (OPEN_STATUSES as readonly string[]).includes(v.status)).length;
  const ended = year.endsOn < today;
  return {
    ended,
    valid: valid ? { id: valid.id, label: versionNumber(valid), name: valid.name } : null,
    open,
    archived: ended && !valid && open === 0 && versions.some((v) => v.status === "archiviert"),
  };
}

/** Abschluss-Bereich der Versionsliste: Kurzstatistik (Planung und Prüfung) und Archiv-Stand. Ohne `manage`/`review` verboten. */
export async function yearClosing(db: Db, viewer: ClosingViewer, year: Year, today: string): Promise<{ stats: YearStatistics | null; state: YearArchiveState; canArchive: boolean }> {
  if (!viewer.manage && !viewer.review) throw new ForbiddenError(PLAN_MANAGE);
  const [stats, state] = await Promise.all([yearStatistics(db, year, today), yearArchiveState(db, year, today)]);
  return { stats, state, canArchive: viewer.manage && state.ended && (state.valid !== null || state.open > 0) };
}

// ---------------------------------------------------------------- Archivieren

export interface ArchiveYearResult {
  archived: TimetablePlanVersion | null;
  discarded: number;
}

/**
 * Schuljahr archivieren (nur `stundenplan.manage`, erst nach dem Schuljahresende): die gültige Version wird `archiviert` (gültig bis
 * höchstens Schuljahresende, Rücknahme-Daten geleert), offene Entwürfe werden verworfen (wie der Nachtjob es ohnehin täte). Der Plan selbst
 * (`timetable_lessons`) bleibt unverändert und lesbar („Plan am Tag X“, Druck, Versionsliste); Löschfristen ändern sich nicht (LK-SJ-1J ab
 * Schuljahr). Audit `stundenplan.plan.archive_year` mit Zahlen.
 */
export async function archiveYear(db: Db, viewer: ClosingViewer, yearId: string, today: string, now = new Date()): Promise<ArchiveYearResult> {
  if (!viewer.manage) throw new ForbiddenError(PLAN_MANAGE);
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, yearId));
  if (!year) throw new ValidationError({ year: "Schuljahr nicht gefunden" });
  if (year.endsOn >= today) throw new ValidationError({ year: `Archivieren geht erst nach dem Schuljahresende (${fmt(year.endsOn)}).` });
  await ensureBaseVersions(db, today);
  const result = await db.transaction(async (tx) => {
    // dieselbe Sperre je Schuljahr wie das Veröffentlichen – gleichzeitige Klicks: einer gewinnt
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stundenplan:publish:${year.id}`}))`);
    const [archived] = await tx
      .update(timetablePlanVersions)
      .set({
        status: "archiviert",
        undo: null,
        validUntil: sql`case when ${timetablePlanVersions.validUntil} is null or ${timetablePlanVersions.validUntil} > ${year.endsOn} then ${year.endsOn}::date else ${timetablePlanVersions.validUntil} end`,
      })
      .where(and(eq(timetablePlanVersions.schoolYearId, year.id), eq(timetablePlanVersions.status, "gueltig")))
      .returning();
    const discarded = await tx
      .update(timetablePlanVersions)
      .set({ status: "verworfen", discardedBy: viewer.userId, discardedAt: now })
      .where(and(eq(timetablePlanVersions.schoolYearId, year.id), inArray(timetablePlanVersions.status, [...OPEN_STATUSES])))
      .returning({ id: timetablePlanVersions.id });
    return { archived: archived ?? null, discarded: discarded.length };
  });
  if (!result.archived && result.discarded === 0) throw new ValidationError({ year: `Das Schuljahr ${year.name} ist schon archiviert.` });
  await audit(db, viewer.userId, "stundenplan.plan.archive_year", result.archived?.id ?? null, {
    year: year.name,
    version: result.archived ? versionNumber(result.archived) : null,
    discarded: result.discarded,
  });
  return result;
}
