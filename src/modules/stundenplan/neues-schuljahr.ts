// SP3-07 (docs/STUNDENPLAN-LEBENSZYKLUS.md §4 Vorlagen, §7.2): Vorlage „Neues Schuljahr“. Der Weg ist eine Checkliste wie im Fahrplan:
// Schuljahr angelegt → Schuljahreswechsel gestartet → Versetzung (neue Klassen, `class_map`) → Entwurf im neuen Schuljahr. Der Entwurf
// entsteht aus dem Plan am letzten Schultag des Vorjahrs, **hochgestuft**: jede Stunde einer Klasse geht an ihre Nachfolgeklasse
// (`class_map` 1:1, ältere Übergänge über die Namensregel – dieselbe Zuordnung wie „Aus dem Vorjahr übernehmen“ in der Matrix, SP3-LA);
// Kurse, andere Lerngruppen und gekoppelte Stunden (Bänder) kommen nicht mit. Die Lehraufträge des neuen Jahres entstehen nicht hier,
// sondern als Vorschlag in der Matrix („Aus dem Vorjahr übernehmen“, Lehrkraft folgt der Klasse) – Lehraufträge sind nicht versioniert (F-10-5).
// Exportiert für den Planungsfahrplan (SP3-06/SP3-08): `newYearTemplate()` (Schritte + Angebot) und `createNewYearDraft()`.
import { and, asc, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, schoolYears, schoolYearTransitions, timetableLessons, timetablePlanVersions, users } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { classMapFor, previousYear } from "./matrix";
import { checkValidFrom, ensureBaseVersions, insertDraftRows, nextNumber, validVersion, versionNumber, type DraftLessonInsert as DraftRow } from "./planversionen";
import type { TimetablePlanVersion } from "./schema";
import { activeOn, listAssignments } from "./verteilung";

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const fmt = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

// ---------------------------------------------------------------- rein: hochstufen

/** Stunde des Vorjahrs (Plan am letzten Schultag) – nur die Felder, die das Hochstufen braucht. */
export interface PreviousLesson {
  id: string;
  groupId: string;
  weekday: number;
  periodNr: number;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  week: "all" | "A" | "B";
  couplingId: string | null;
  fixed: boolean;
}

export interface PromotedLessons {
  rows: DraftRow[];
  skipped: {
    /** Kurse, AGs und andere Lerngruppen, die keine Klassen des Vorjahrs sind */
    courses: number;
    /** gekoppelte Stunden (Bänder, Religion/Ethik …) – werden neu geplant */
    coupled: number;
    /** Klassen ohne eindeutige Nachfolgeklasse (Abschlussjahrgang, zusammengelegte Klassen) */
    unmapped: number;
  };
  /** Lehrkraft nicht mehr aktiv → Stunde ohne Lehrkraft übernommen */
  teacherCleared: number;
}

/**
 * Rein (SP3-07): Stunden des Vorjahrs auf die Klassen des neuen Schuljahrs hochstufen. Übernommen werden nur ungekoppelte Stunden von
 * Klassen des Vorjahrs, deren Klasse in `classMap` (nur 1:1-Paare) eine Nachfolgeklasse hat. Tag, Stunde, Woche, Fach, Raum und Fixierung
 * bleiben; die Lehrkraft bleibt, wenn sie noch aktiv ist („Lehrkraft folgt der Klasse“), sonst bleibt die Stunde offen. Die Stunden gelten ab
 * dem Stichtag unbefristet, ohne Herkunft im gültigen Plan (`origin_lesson_id` leer – der gültige Plan des neuen Jahres ist ein anderer) und
 * ohne Lehrauftrag (die Lehraufträge entstehen in der Matrix).
 */
export function promoteLessons(
  lessons: readonly PreviousLesson[],
  opts: { classMap: ReadonlyMap<string, string>; classIds: ReadonlySet<string>; activeTeachers: ReadonlySet<string>; validFrom: string },
): PromotedLessons {
  const out: PromotedLessons = { rows: [], skipped: { courses: 0, coupled: 0, unmapped: 0 }, teacherCleared: 0 };
  for (const l of lessons) {
    if (!opts.classIds.has(l.groupId)) {
      out.skipped.courses++;
      continue;
    }
    if (l.couplingId) {
      out.skipped.coupled++;
      continue;
    }
    const to = opts.classMap.get(l.groupId);
    if (!to) {
      out.skipped.unmapped++;
      continue;
    }
    const teacherId = l.teacherId && opts.activeTeachers.has(l.teacherId) ? l.teacherId : null;
    if (l.teacherId && !teacherId) out.teacherCleared++;
    out.rows.push({
      groupId: to,
      weekday: l.weekday,
      periodNr: l.periodNr,
      subjectId: l.subjectId,
      teacherId,
      roomId: l.roomId,
      week: l.week,
      validFrom: opts.validFrom,
      validUntil: null,
      couplingId: null,
      fixed: l.fixed,
      solverRunId: null,
      originLessonId: null,
      assignmentId: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Schritte und Angebot

export type NewYearStepKey = "jahr" | "wechsel" | "versetzung" | "entwurf";

export interface NewYearStep {
  key: NewYearStepKey;
  label: string;
  done: boolean;
  /** Stand bzw. was fehlt */
  detail: string;
  /** Sprungziel (Schuljahreswechsel in der Verwaltung, Versionsliste) */
  href: string | null;
}

export type NewYearOffer = { ok: true; validFrom: string; number: string; name: string } | { ok: false; reason: string };

export interface NewYearTemplate {
  year: { id: string; name: string };
  previousYear: { id: string; name: string } | null;
  steps: NewYearStep[];
  offer: NewYearOffer;
  /** Ist das Schuljahr das Planungsjahr (aktuelles Schuljahr)? Nur dann arbeiten Stundenplan, Unterrichtsverteilung und Solver im Entwurf. */
  planningYear: boolean;
  /** Vorschau des Hochstufens (nur mit Vorjahr und Zuordnung) */
  preview: { lessons: number; skipped: PromotedLessons["skipped"]; teacherCleared: number; classes: number; reconstructed: boolean; reference: string } | null;
  /** Lehraufträge des Vorjahrs, die die Matrix als „Lehrkraft folgt der Klasse“ vorschlagen kann (höchstens so viele) */
  assignmentSuggestions: number;
}

/** Letzter Schultag eines Schuljahrs (sonst das Schuljahresende) – an diesem Tag gilt der „Plan des Vorjahrs“. */
async function lastSchoolDay(db: Db, year: { startsOn: string; endsOn: string }): Promise<string> {
  const cal = await loadSchoolCalendar(db);
  let d = year.endsOn;
  for (let i = 0; i < 370 && d >= year.startsOn; i++, d = addDays(d, -1)) if (cal.isSchoolDay(d)) return d;
  return year.endsOn;
}

/** Stichtag des neuen Schuljahrs: erster Schultag im Schuljahr nach heute (vor Schuljahresbeginn: der erste Schultag). */
async function firstSchoolDayAfter(db: Db, year: { startsOn: string; endsOn: string }, today: string): Promise<string | null> {
  const cal = await loadSchoolCalendar(db);
  const d = cal.nextSchoolDay(today < year.startsOn ? year.startsOn : addDays(today, 1));
  return d > today && d >= year.startsOn && d <= year.endsOn ? d : null;
}

async function previousLessons(db: Db, prevYearId: string, ref: string) {
  const classRows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.schoolYearId, prevYearId), eq(groups.kind, "klasse")));
  const lessons = await db
    .select({
      id: timetableLessons.id,
      groupId: timetableLessons.groupId,
      weekday: timetableLessons.weekday,
      periodNr: timetableLessons.periodNr,
      subjectId: timetableLessons.subjectId,
      teacherId: timetableLessons.teacherId,
      roomId: timetableLessons.roomId,
      week: timetableLessons.week,
      couplingId: timetableLessons.couplingId,
      fixed: timetableLessons.fixed,
    })
    .from(timetableLessons)
    .where(and(lte(timetableLessons.validFrom, ref), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, ref))))
    .orderBy(asc(timetableLessons.groupId), asc(timetableLessons.weekday), asc(timetableLessons.periodNr), asc(timetableLessons.id));
  return { lessons, classIds: new Set(classRows.map((c) => c.id)) };
}

async function activeTeacherIds(db: Db): Promise<Set<string>> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.status, "active"));
  return new Set(rows.map((r) => r.id));
}

type Year = typeof schoolYears.$inferSelect;

/** Hochstufen mit den Daten aus der Datenbank (Vorschau und Anlegen rechnen gleich). */
async function promoteFromDb(db: Db, prev: Year, year: Year, validFrom: string) {
  const reference = await lastSchoolDay(db, prev);
  const [{ map, reconstructed }, { lessons, classIds }, active] = await Promise.all([
    classMapFor(db, prev.id, year.id),
    previousLessons(db, prev.id, reference),
    activeTeacherIds(db),
  ]);
  return { result: promoteLessons(lessons, { classMap: map, classIds, activeTeachers: active, validFrom }), map, reconstructed, reference };
}

/**
 * Vorlage „Neues Schuljahr“ für das Schuljahr `year` (Ziel): Schritte mit Stand und – wenn alles da ist – Nummer, Stichtag und Name des
 * Entwurfs. Vorgaben (SP3-07): Die Versetzung gilt als erledigt, wenn der Schuljahreswechsel vom Vorjahr in dieses Schuljahr sie
 * durchgeführt hat; ohne Schuljahreswechsel reichen Klassen im neuen Schuljahr (von Hand angelegt – Zuordnung dann über die Namensregel).
 * Angeboten wird die Vorlage, solange im Schuljahr kein Plan gilt; Stichtag ist der erste Schultag nach heute im Schuljahr.
 */
export async function newYearTemplate(db: Db, year: Year, today: string, planningYearId: string | null = null): Promise<NewYearTemplate> {
  const prev = await previousYear(db, year);
  const base = { year: { id: year.id, name: year.name }, previousYear: prev ? { id: prev.id, name: prev.name } : null, planningYear: planningYearId === year.id };
  const steps: NewYearStep[] = [
    { key: "jahr", label: `Schuljahr ${year.name} angelegt`, done: true, detail: `${fmt(year.startsOn)} – ${fmt(year.endsOn)}${year.isCurrent ? " · aktuelles Schuljahr" : ""}`, href: null },
  ];
  if (!prev) {
    steps.push({ key: "wechsel", label: "Schuljahreswechsel", done: false, detail: "Es gibt kein Vorjahr – der erste Plan entsteht als leerer Entwurf.", href: null });
    return { ...base, steps, offer: { ok: false, reason: `Vor ${year.name} gibt es kein Schuljahr – einen leeren Entwurf anlegen.` }, preview: null, assignmentSuggestions: 0 };
  }
  const [transition] = await db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.fromYearId, prev.id));
  const [newClass] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.schoolYearId, year.id), eq(groups.kind, "klasse")))
    .limit(1);
  const wechselHref = "/verwaltung/schuljahreswechsel";
  const otherTarget = transition && transition.toYearId !== year.id;
  const started = Boolean(transition && !otherTarget);
  const promoted = started ? Boolean(transition!.promotedAt) : !transition && Boolean(newClass);
  steps.push({
    key: "wechsel",
    label: `Schuljahreswechsel ${prev.name} → ${year.name}`,
    done: started || promoted,
    detail: otherTarget
      ? "Der Schuljahreswechsel des Vorjahrs führt in ein anderes Schuljahr."
      : started
        ? transition!.completedAt
          ? "abgeschlossen"
          : "gestartet (Verwaltung)"
        : promoted
          ? "ohne Assistent – die Klassen sind von Hand angelegt"
          : "noch nicht gestartet (Verwaltung → Schuljahreswechsel)",
    href: wechselHref,
  });
  steps.push({
    key: "versetzung",
    label: "Versetzung: Klassen im neuen Schuljahr",
    done: promoted,
    detail: promoted
      ? transition?.classMap
        ? "erledigt – die Zuordnung alt → neu ist gespeichert"
        : "erledigt – Zuordnung alt → neu über die Klassennamen"
      : "fehlt – erst die Versetzung im Schuljahreswechsel durchführen",
    href: wechselHref,
  });
  const [valid, number, existing] = await Promise.all([
    validVersion(db, year.id),
    nextNumber(db, year.id, "major"),
    db
      .select({ id: timetablePlanVersions.id })
      .from(timetablePlanVersions)
      .where(and(eq(timetablePlanVersions.schoolYearId, year.id), ne(timetablePlanVersions.status, "verworfen")))
      .limit(1),
  ]);
  steps.push({
    key: "entwurf",
    label: "Entwurf im neuen Schuljahr",
    done: existing.length > 0,
    detail: existing.length ? "angelegt – weiter in der Versionsliste" : "noch keiner",
    href: `/planung/versionen?jahr=${encodeURIComponent(year.id)}`,
  });
  const validFrom = await firstSchoolDayAfter(db, year, today);
  let offer: NewYearOffer;
  if (otherTarget) offer = { ok: false, reason: "Der Schuljahreswechsel des Vorjahrs führt in ein anderes Schuljahr." };
  else if (!promoted) offer = { ok: false, reason: `Erst die Versetzung im Schuljahreswechsel ${prev.name} → ${year.name} durchführen (Verwaltung).` };
  else if (valid) offer = { ok: false, reason: `Im Schuljahr ${year.name} gilt schon ein Plan – Änderungen über „Änderung im laufenden Plan“ oder „Neues Halbjahr“.` };
  else if (!validFrom) offer = { ok: false, reason: "Das Schuljahr hat keinen Schultag mehr." };
  else offer = { ok: true, validFrom, number: versionNumber(number!), name: `Schuljahr ${year.name}` };

  let preview: NewYearTemplate["preview"] = null;
  let assignmentSuggestions = 0;
  if (promoted && !otherTarget) {
    const p = await promoteFromDb(db, prev, year, validFrom ?? year.startsOn);
    preview = {
      lessons: p.result.rows.length,
      skipped: p.result.skipped,
      teacherCleared: p.result.teacherCleared,
      classes: new Set(p.result.rows.map((r) => r.groupId)).size,
      reconstructed: p.reconstructed,
      reference: p.reference,
    };
    const list = await listAssignments(db, prev.id);
    assignmentSuggestions = list.filter((a) => activeOn(a, prev.endsOn) && !a.bandId && a.groups.length === 1 && a.teachers.length <= 1 && p.map.has(a.groups[0]!.id)).length;
  }
  return { ...base, steps, offer, preview, assignmentSuggestions };
}

export const NEW_YEAR_BASES = ["vorjahr", "leer"] as const;
export type NewYearBase = (typeof NEW_YEAR_BASES)[number];

/**
 * Entwurf „Neues Schuljahr“ anlegen (Nummer `x.0`, Stichtag aus der Vorlage): `vorjahr` = Plan am letzten Schultag des Vorjahrs hochgestuft
 * (Quelle `previous_version`, Vorgängerin = die Version, die an dem Tag galt), `leer` = leerer Entwurf (Quelle `empty`). Audit
 * `stundenplan.plan.create` mit Zahlen (übernommen, ausgelassen), ohne Personen.
 */
export async function createNewYearDraft(db: Db, actorId: string, schoolYearId: string, base: NewYearBase, today: string): Promise<TimetablePlanVersion> {
  if (!(NEW_YEAR_BASES as readonly string[]).includes(base)) throw new ValidationError({ base: "Ausgangsbasis wählen" });
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, schoolYearId));
  if (!year) throw new ValidationError({ schoolYearId: "Schuljahr wählen" });
  await ensureBaseVersions(db, today);
  const t = await newYearTemplate(db, year, today);
  if (!t.offer.ok) throw new ValidationError({ template: t.offer.reason });
  const offer = t.offer;
  await checkValidFrom(db, year, offer.validFrom, today);
  const prev = (await db.select().from(schoolYears).where(eq(schoolYears.id, t.previousYear!.id)))[0]!;
  const promoted = base === "vorjahr" ? await promoteFromDb(db, prev, year, offer.validFrom) : null;
  if (promoted && promoted.result.rows.length === 0) throw new ValidationError({ base: "Aus dem Vorjahr lässt sich keine Stunde übernehmen – einen leeren Entwurf anlegen." });
  // Vorgängerin: die veröffentlichte Version des Vorjahrs, die am letzten Schultag galt (Herkunft für die Anzeige)
  const parent = promoted
    ? (
        await db
          .select({ id: timetablePlanVersions.id })
          .from(timetablePlanVersions)
          .where(
            and(
              eq(timetablePlanVersions.schoolYearId, prev.id),
              inArray(timetablePlanVersions.status, ["gueltig", "archiviert"]),
              lte(timetablePlanVersions.validFrom, promoted.reference),
              or(isNull(timetablePlanVersions.validUntil), gte(timetablePlanVersions.validUntil, promoted.reference)),
            ),
          )
          .orderBy(asc(timetablePlanVersions.validFrom))
          .limit(1)
      )[0]
    : undefined;
  const rows = promoted?.result.rows ?? [];
  const version = await db.transaction(async (tx) => {
    const [v] = await tx
      .insert(timetablePlanVersions)
      .values({
        schoolYearId: year.id,
        major: Number(offer.number.split(".")[0]),
        minor: 0,
        name: offer.name,
        status: "entwurf",
        source: promoted ? "previous_version" : "empty",
        parentVersionId: parent?.id ?? null,
        validFrom: offer.validFrom,
        createdBy: actorId,
      })
      .returning();
    await insertDraftRows(tx as unknown as Db, v!.id, rows);
    return v!;
  });
  await audit(db, actorId, "stundenplan.plan.create", version.id, {
    version: versionNumber(version),
    source: version.source,
    template: "schuljahr",
    validFrom: offer.validFrom,
    lessons: rows.length,
    ...(promoted
      ? {
          from: prev.name,
          skippedCourses: promoted.result.skipped.courses,
          skippedCoupled: promoted.result.skipped.coupled,
          skippedUnmapped: promoted.result.skipped.unmapped,
          withoutTeacher: promoted.result.teacherCleared,
          reconstructed: promoted.reconstructed,
        }
      : {}),
  });
  return version;
}
