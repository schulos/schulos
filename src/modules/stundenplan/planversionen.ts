// SP3-01 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1/2.2/2.5, §3.1): Planversionen und Entwurfsbereich. Ein Entwurf ist eine Version im
// Status `entwurf` mit eigenen Stunden in `timetable_draft_lessons`; der gültige Plan (`timetable_lessons`) bleibt unberührt, bis
// SP3-04 veröffentlicht. Hier: „Bestand 1.0“, Entwurf anlegen (aus dem gültigen Plan ab Stichtag, leer, aus einer Vorversion),
// Variante, Verwerfen, Versionsliste mit Kennzahlen und das nächtliche Aufräumen. Arbeiten im Entwurf (Setzhilfe, Solver, Diff) ist SP3-02.
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { schoolYears, timetableDraftLessons, timetableLessons, timetablePlanVersions, users } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, isCalendarDate, toBerlinDate, TZ, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { lessonFields, planFigures, planLessons, type PlanFigures, type PlanSource } from "./plan-quelle";
import type { PlanVersionSource, PlanVersionStatus, TimetablePlanVersion } from "./schema";

export const STATUS_LABELS: Record<PlanVersionStatus, string> = {
  entwurf: "Entwurf",
  pruefung: "in Prüfung",
  freigegeben: "freigegeben",
  gueltig: "gültig",
  archiviert: "archiviert",
  verworfen: "verworfen",
};

/** Status, in denen eine Version noch Entwurf ist (eigene Stunden, bearbeitbar bzw. prüfbar, verwerfbar). */
export const OPEN_STATUSES = ["entwurf", "pruefung", "freigegeben"] as const satisfies readonly PlanVersionStatus[];
/** veröffentlichte Versionen: ihr Inhalt ist der gültige Plan im Zeitraum `valid_from` … `valid_until` */
export const PUBLISHED_STATUSES = ["gueltig", "archiviert"] as const satisfies readonly PlanVersionStatus[];

const isOpen = (s: PlanVersionStatus) => (OPEN_STATUSES as readonly string[]).includes(s);
const isPublished = (s: PlanVersionStatus) => (PUBLISHED_STATUSES as readonly string[]).includes(s);

/** Wege, einen Entwurf anzulegen (Variante getrennt über `createVariant`). */
export const DRAFT_SOURCES = ["live_copy", "empty", "previous_version"] as const satisfies readonly PlanVersionSource[];
export type DraftSource = (typeof DRAFT_SOURCES)[number];

export const NAME_MAX = 80;

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const fmt = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

export const versionNumber = (v: { major: number; minor: number }) => `${v.major}.${v.minor}`;

// ---------------------------------------------------------------- Bestand 1.0

/**
 * „Bestand 1.0“ (idempotent, wie die Daten-Migration 0111): je begonnenem Schuljahr mit Stunden und ohne veröffentlichte Version eine
 * Version 1.0 `bestand` – `gueltig` ab Schuljahresbeginn, für abgelaufene Schuljahre `archiviert` bis Schuljahresende. Stunden, die heute gelten,
 * bekommen sie als Herkunft (`plan_version_id`). Läuft bei neuen Installationen (die Migration lief auf einer leeren Datenbank),
 * im Demo-Seed, vor dem Anlegen eines Entwurfs, auf der Versionsliste und im Nachtjob.
 */
export async function ensureBaseVersions(db: Db, todayYmd: string): Promise<number> {
  const years = await db.select().from(schoolYears);
  if (!years.length) return 0;
  const existing = await db
    .select({ yearId: timetablePlanVersions.schoolYearId })
    .from(timetablePlanVersions)
    .where(or(eq(timetablePlanVersions.source, "bestand"), inArray(timetablePlanVersions.status, [...PUBLISHED_STATUSES])));
  const covered = new Set(existing.map((r) => r.yearId));
  let created = 0;
  for (const y of years) {
    // künftige Schuljahre: unbefristete Stunden reichen hinein, geplant wird dort aber neu (erster Entwurf = 1.0)
    if (covered.has(y.id) || y.startsOn > todayYmd) continue;
    const [hit] = await db
      .select({ id: timetableLessons.id })
      .from(timetableLessons)
      .where(and(lte(timetableLessons.validFrom, y.endsOn), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, y.startsOn))))
      .limit(1);
    if (!hit) continue;
    const ended = y.endsOn < todayYmd;
    const rows = await db
      .insert(timetablePlanVersions)
      .values({
        schoolYearId: y.id,
        major: 1,
        minor: 0,
        name: "Bestand",
        status: ended ? "archiviert" : "gueltig",
        source: "bestand",
        validFrom: y.startsOn,
        validUntil: ended ? y.endsOn : null,
      })
      .onConflictDoNothing()
      .returning({ id: timetablePlanVersions.id });
    created += rows.length;
  }
  // Herkunft der heute geltenden Stunden (nur im Schuljahr von heute)
  const current = years.find((y) => y.startsOn <= todayYmd && todayYmd <= y.endsOn);
  if (current) {
    const [base] = await db
      .select({ id: timetablePlanVersions.id })
      .from(timetablePlanVersions)
      .where(and(eq(timetablePlanVersions.schoolYearId, current.id), eq(timetablePlanVersions.source, "bestand"), eq(timetablePlanVersions.status, "gueltig")));
    if (base && created)
      await db
        .update(timetableLessons)
        .set({ planVersionId: base.id })
        .where(
          and(
            isNull(timetableLessons.planVersionId),
            lte(timetableLessons.validFrom, todayYmd),
            or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, todayYmd)),
          ),
        );
  }
  return created;
}

// ---------------------------------------------------------------- Lesen

export interface VersionSummary {
  version: TimetablePlanVersion;
  label: string;
  yearName: string;
  createdByName: string | null;
  /** Nummer der Version, von der sie abstammt (Variante/Folgeversion/Kopie) */
  parentLabel: string | null;
  /** SP3-07: Schuljahr der Vorgängerin, wenn sie in einem anderen Schuljahr liegt („Neues Schuljahr“ aus dem Vorjahr) */
  parentYearName: string | null;
  /** Stichtag, an dem die Kennzahlen gelten (veröffentlichte Versionen) bzw. null (Entwurf: alle Stunden) */
  figuresOn: string | null;
  figures: PlanFigures;
}

/** Quelle einer Version: Entwürfe ihre Stunden, veröffentlichte Versionen der gültige Plan in ihrem Zeitraum. */
export function versionSource(v: Pick<TimetablePlanVersion, "id" | "status" | "validFrom" | "validUntil">, todayYmd: string): PlanSource {
  if (!isPublished(v.status)) return { kind: "draft", versionId: v.id };
  const from = v.validFrom ?? todayYmd;
  let ref = v.status === "archiviert" ? (v.validUntil ?? from) : todayYmd < from ? from : todayYmd;
  if (v.validUntil && ref > v.validUntil) ref = v.validUntil;
  return { kind: "live", refYmd: ref };
}

/** Versionen eines Schuljahrs (veröffentlichte und offene oben, verworfene unten; je neueste zuerst) mit Kennzahlen. */
export async function listVersions(db: Db, schoolYearId: string, todayYmd: string): Promise<VersionSummary[]> {
  const rows = await db
    .select({ v: timetablePlanVersions, yearName: schoolYears.name, createdByName: users.name })
    .from(timetablePlanVersions)
    .innerJoin(schoolYears, eq(schoolYears.id, timetablePlanVersions.schoolYearId))
    .leftJoin(users, eq(users.id, timetablePlanVersions.createdBy))
    .where(eq(timetablePlanVersions.schoolYearId, schoolYearId))
    .orderBy(desc(timetablePlanVersions.major), desc(timetablePlanVersions.minor), desc(timetablePlanVersions.createdAt));
  const byId = new Map(rows.map((r) => [r.v.id, r.v]));
  // SP3-07: „Neues Schuljahr“ stammt von einer Version des Vorjahrs ab
  const foreign = [...new Set(rows.map((r) => r.v.parentVersionId).filter((id): id is string => id !== null && !byId.has(id)))];
  const foreignRows = foreign.length
    ? await db
        .select({ v: timetablePlanVersions, yearName: schoolYears.name })
        .from(timetablePlanVersions)
        .innerJoin(schoolYears, eq(schoolYears.id, timetablePlanVersions.schoolYearId))
        .where(inArray(timetablePlanVersions.id, foreign))
    : [];
  const foreignById = new Map(foreignRows.map((r) => [r.v.id, r]));
  const rank = (s: PlanVersionStatus) => (s === "verworfen" ? 2 : s === "archiviert" ? 1 : 0);
  rows.sort((a, b) => rank(a.v.status) - rank(b.v.status));
  return Promise.all(
    rows.map(async (r) => {
      const source = versionSource(r.v, todayYmd);
      const other = r.v.parentVersionId ? foreignById.get(r.v.parentVersionId) : undefined;
      const parent = r.v.parentVersionId ? (byId.get(r.v.parentVersionId) ?? other?.v) : undefined;
      return {
        version: r.v,
        label: versionNumber(r.v),
        yearName: r.yearName,
        createdByName: r.createdByName,
        parentLabel: parent ? versionNumber(parent) : null,
        parentYearName: other?.yearName ?? null,
        figuresOn: source.kind === "live" ? source.refYmd : null,
        figures: planFigures(await planLessons(db, source)),
      };
    }),
  );
}

export async function getVersion(db: Db, id: string): Promise<TimetablePlanVersion | null> {
  const [v] = await db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, id));
  return v ?? null;
}

/** Die gültige Version eines Schuljahrs (höchstens eine, eindeutiger Teilindex). */
export async function validVersion(db: Db, schoolYearId: string): Promise<TimetablePlanVersion | null> {
  const [v] = await db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), eq(timetablePlanVersions.status, "gueltig")));
  return v ?? null;
}

// ---------------------------------------------------------------- Nummern

export type Numbering = "major" | "minor";

/**
 * Vorgesehene Nummer eines neuen Entwurfs: neue Planung (`major`) = höchste Hauptnummer + 1 (verworfene zählen nicht); Folgeversion
 * (`minor`) = Hauptnummer der gültigen Version, Unternummer + 1. Ohne gültige Version gibt es keine Folgeversion. Varianten übernehmen
 * die Nummer ihres Entwurfs (sie „zählen bis zur Veröffentlichung nicht“, §2.1).
 */
export async function nextNumber(db: Db, schoolYearId: string, numbering: Numbering): Promise<{ major: number; minor: number } | null> {
  const rows = await db
    .select({ major: timetablePlanVersions.major, minor: timetablePlanVersions.minor, status: timetablePlanVersions.status })
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), ne(timetablePlanVersions.status, "verworfen")));
  if (numbering === "major") return { major: Math.max(0, ...rows.map((r) => r.major)) + 1, minor: 0 };
  const valid = rows.find((r) => r.status === "gueltig");
  if (!valid) return null;
  return { major: valid.major, minor: Math.max(...rows.filter((r) => r.major === valid.major).map((r) => r.minor)) + 1 };
}

// ---------------------------------------------------------------- Anlegen

export interface DraftInput {
  schoolYearId: string;
  source: DraftSource;
  /** Stichtag „gültig ab“ (vorgemerkt) */
  validFrom: string;
  numbering: Numbering;
  name?: string | null;
  /** nur `previous_version` */
  previousVersionId?: string | null;
  /** nur `empty`: fixierte Stunden des gültigen Plans am Stichtag übernehmen */
  withFixed?: boolean;
}

function cleanName(name: string | null | undefined): string | null {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (n.length > NAME_MAX) throw new ValidationError({ name: `Höchstens ${NAME_MAX} Zeichen` });
  return n;
}

/** Stichtag prüfen: echtes Datum, nach heute, im Schuljahr, Schultag (wie die Übernahme eines Solver-Laufs, SP-09). */
export async function checkValidFrom(db: Db, year: { startsOn: string; endsOn: string }, ymd: string, todayYmd: string) {
  if (!isCalendarDate(ymd)) throw new ValidationError({ validFrom: "Datum wählen" });
  if (ymd <= todayYmd) throw new ValidationError({ validFrom: "Der Stichtag muss in der Zukunft liegen" });
  if (ymd < year.startsOn || ymd > year.endsOn) throw new ValidationError({ validFrom: `Der Stichtag muss im Schuljahr liegen (${fmt(year.startsOn)} – ${fmt(year.endsOn)})` });
  const cal = await loadSchoolCalendar(db);
  if (!cal.isSchoolDay(ymd)) {
    const why = weekdayMon0(ymd) >= 5 ? "Wochenende" : cal.dayOff(ymd)?.kind === "feiertag" ? "Feiertag" : "Ferien/frei";
    throw new ValidationError({ validFrom: `Der ${fmt(ymd)} ist kein Schultag (${why}) – nächster Schultag: ${fmt(cal.nextSchoolDay(ymd))}` });
  }
}

/** Vorschlag für den Stichtag: Beginn des 2. Halbjahrs, wenn er noch kommt, sonst der nächste Schultag nach heute (im Schuljahr). */
export async function suggestedValidFrom(db: Db, year: { startsOn: string; endsOn: string; term2StartsOn: string | null }, todayYmd: string): Promise<string | null> {
  const cal = await loadSchoolCalendar(db);
  const candidates = [year.term2StartsOn && year.term2StartsOn > todayYmd ? year.term2StartsOn : null, addDays(todayYmd < year.startsOn ? addDays(year.startsOn, -1) : todayYmd, 1)];
  for (const c of candidates) {
    if (!c) continue;
    const d = cal.nextSchoolDay(c);
    if (d > todayYmd && d >= year.startsOn && d <= year.endsOn) return d;
  }
  return null;
}

type DraftRow = typeof timetableDraftLessons.$inferInsert;
/** Zeile einer Entwurfsstunde ohne Version (SP3-07: hochgestufte Stunden des Vorjahrs) */
export type DraftLessonInsert = Omit<DraftRow, "versionId">;

/** Stunden des gültigen Plans ab dem Stichtag (im Schuljahr) – Kopie mit Herkunft, Beginn frühestens am Stichtag. */
async function liveRowsFrom(db: Db, year: { endsOn: string }, fromYmd: string, onlyFixed: boolean): Promise<Omit<DraftRow, "versionId">[]> {
  const rows = await db
    .select()
    .from(timetableLessons)
    .where(
      and(
        lte(timetableLessons.validFrom, year.endsOn),
        or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, fromYmd)),
        onlyFixed ? eq(timetableLessons.fixed, true) : undefined,
      ),
    )
    .orderBy(asc(timetableLessons.createdAt), asc(timetableLessons.id));
  return rows.map((l) => ({ ...lessonFields(l), validFrom: l.validFrom < fromYmd ? fromYmd : l.validFrom, originLessonId: l.id }));
}

/** Inhalt einer Vorversion: Entwurfsstunden (verworfen) bzw. der gültige Plan an ihrem ersten Tag (archiviert). */
async function previousRows(db: Db, prev: TimetablePlanVersion, fromYmd: string): Promise<Omit<DraftRow, "versionId">[]> {
  if (prev.status === "verworfen") {
    const rows = await db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, prev.id)).orderBy(asc(timetableDraftLessons.createdAt), asc(timetableDraftLessons.id));
    // Stunden, die vor dem neuen Stichtag enden, kommen nicht mit (wie beim gültigen Plan)
    return rows
      .filter((l) => l.validUntil === null || l.validUntil >= fromYmd)
      .map((l) => ({ ...lessonFields(l), validFrom: l.validFrom < fromYmd ? fromYmd : l.validFrom, originLessonId: l.originLessonId, assignmentId: l.assignmentId }));
  }
  const ref = prev.validFrom!;
  const rows = await db
    .select()
    .from(timetableLessons)
    .where(and(lte(timetableLessons.validFrom, ref), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, ref))))
    .orderBy(asc(timetableLessons.createdAt), asc(timetableLessons.id));
  // die Stunden einer archivierten Version enden vor dem Stichtag – im Entwurf gelten sie ab dem Stichtag, befristet nur, wenn das Ende danach liegt
  return rows.map((l) => ({ ...lessonFields(l), validFrom: fromYmd, validUntil: l.validUntil && l.validUntil >= fromYmd ? l.validUntil : null, originLessonId: l.id }));
}

export async function insertDraftRows(db: Db, versionId: string, rows: Omit<DraftRow, "versionId">[]) {
  for (let i = 0; i < rows.length; i += 500) await db.insert(timetableDraftLessons).values(rows.slice(i, i + 500).map((r) => ({ ...r, versionId })));
}

/**
 * Neuen Entwurf anlegen (§2.2): `live_copy` = Kopie des gültigen Plans ab Stichtag (ersetzt fachlich „Periode kopieren“, ohne den
 * gültigen Plan anzufassen), `empty` = leer (optional mit den fixierten Stunden), `previous_version` = Kopie einer archivierten oder
 * verworfenen Version desselben Schuljahrs. Der Entwurf wirkt nirgends, bis er veröffentlicht wird (SP3-04).
 */
export async function createDraft(db: Db, actorId: string, input: DraftInput, todayYmd: string): Promise<TimetablePlanVersion> {
  if (!(DRAFT_SOURCES as readonly string[]).includes(input.source)) throw new ValidationError({ source: "Ausgangsbasis wählen" });
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, input.schoolYearId));
  if (!year) throw new ValidationError({ schoolYearId: "Schuljahr wählen" });
  await checkValidFrom(db, year, input.validFrom, todayYmd);
  const name = cleanName(input.name);
  await ensureBaseVersions(db, todayYmd);
  const prev = input.source === "previous_version" ? (input.previousVersionId ? await getVersion(db, input.previousVersionId) : null) : null;
  if (input.source === "previous_version") {
    if (!prev || prev.schoolYearId !== year.id) throw new ValidationError({ previousVersionId: "Vorversion dieses Schuljahrs wählen" });
    if (prev.status !== "archiviert" && prev.status !== "verworfen")
      throw new ValidationError({ previousVersionId: "Nur archivierte oder verworfene Versionen – für den gültigen Plan „aus dem gültigen Plan“ wählen, für einen offenen Entwurf „Variante anlegen“" });
    if (prev.status === "archiviert" && !prev.validFrom) throw new ValidationError({ previousVersionId: "Diese Version hat keinen Zeitraum" });
  }
  const number = await nextNumber(db, year.id, input.numbering);
  if (!number) throw new ValidationError({ numbering: "Eine Folgeversion braucht eine gültige Version – „neue Planung“ wählen" });
  const parent = input.source === "previous_version" ? prev : input.source === "live_copy" ? await validVersion(db, year.id) : null;
  const defaultName =
    input.source === "live_copy" ? `Ab ${fmt(input.validFrom)}` : input.source === "empty" ? "Leerer Entwurf" : `Kopie von ${versionNumber(prev!)}`;

  const result = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const rows =
      input.source === "live_copy"
        ? await liveRowsFrom(t, year, input.validFrom, false)
        : input.source === "empty"
          ? input.withFixed
            ? await liveRowsFrom(t, year, input.validFrom, true)
            : []
          : await previousRows(t, prev!, input.validFrom);
    const [v] = await tx
      .insert(timetablePlanVersions)
      .values({
        schoolYearId: year.id,
        major: number.major,
        minor: number.minor,
        name: name ?? defaultName,
        status: "entwurf",
        source: input.source,
        parentVersionId: parent?.id ?? null,
        validFrom: input.validFrom,
        createdBy: actorId,
      })
      .returning();
    await insertDraftRows(t, v!.id, rows);
    return { version: v!, lessons: rows.length };
  });
  await audit(db, actorId, "stundenplan.plan.create", result.version.id, {
    version: versionNumber(result.version),
    source: input.source,
    validFrom: input.validFrom,
    lessons: result.lessons,
  });
  return result.version;
}

/** Variante eines offenen Entwurfs (§2.5): gleiche Nummer, gleiche Herkunft der Stunden, eigener Name. */
export async function createVariant(db: Db, actorId: string, versionId: string, name?: string | null): Promise<TimetablePlanVersion> {
  const base = await getVersion(db, versionId);
  if (!base) throw new ValidationError({ version: "Version nicht gefunden" });
  if (!isOpen(base.status)) throw new ValidationError({ version: "Varianten gibt es nur von Entwürfen" });
  const clean = cleanName(name);
  const suffix = " – Variante";
  const result = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const rows = await t.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, base.id)).orderBy(asc(timetableDraftLessons.createdAt), asc(timetableDraftLessons.id));
    const [v] = await tx
      .insert(timetablePlanVersions)
      .values({
        schoolYearId: base.schoolYearId,
        major: base.major,
        minor: base.minor,
        name: clean ?? (base.name.length + suffix.length <= NAME_MAX ? base.name + suffix : `Variante von ${versionNumber(base)}`),
        status: "entwurf",
        source: "variant_of",
        parentVersionId: base.id,
        sourceRunId: base.sourceRunId,
        validFrom: base.validFrom,
        createdBy: actorId,
      })
      .returning();
    await insertDraftRows(
      t,
      v!.id,
      rows.map((l) => ({ ...lessonFields(l), originLessonId: l.originLessonId, assignmentId: l.assignmentId })),
    );
    return { version: v!, lessons: rows.length };
  });
  await audit(db, actorId, "stundenplan.plan.variant", result.version.id, { version: versionNumber(result.version), of: base.id, lessons: result.lessons });
  return result.version;
}

/**
 * Entwurf verwerfen: Status `verworfen`, die Stunden bleiben (für „aus Vorversion“) und gehen mit der Version (Löschklasse). Gültige
 * und archivierte Versionen lassen sich nicht verwerfen.
 */
export async function discardVersion(db: Db, actorId: string, versionId: string, now = new Date()): Promise<TimetablePlanVersion> {
  const v = await getVersion(db, versionId);
  if (!v) throw new ValidationError({ version: "Version nicht gefunden" });
  if (!isOpen(v.status)) throw new ValidationError({ version: v.status === "verworfen" ? "Diese Version ist schon verworfen" : "Nur Entwürfe lassen sich verwerfen" });
  const [done] = await db
    .update(timetablePlanVersions)
    .set({ status: "verworfen", discardedBy: actorId, discardedAt: now })
    .where(and(eq(timetablePlanVersions.id, v.id), inArray(timetablePlanVersions.status, [...OPEN_STATUSES])))
    .returning();
  if (!done) throw new ValidationError({ version: "Die Version wurde inzwischen geändert – Seite neu laden" });
  await audit(db, actorId, "stundenplan.plan.discard", v.id, { version: versionNumber(v), status: v.status });
  return done;
}

// ---------------------------------------------------------------- Nachtjob

/**
 * Nachtjob-Erweiterung (`solver-aufraeumen`, §6): Rücknahme-Daten veröffentlichter Versionen ab dem Stichtag leeren (wie bei Solver-
 * Läufen, SP-09), offene Entwürfe abgelaufener Schuljahre verwerfen (§2.5) und „Bestand 1.0“ nachziehen.
 */
export async function cleanupVersions(db: Db, now = new Date()): Promise<{ undoCleared: number; discarded: number; based: number }> {
  const today = toBerlinDate(now);
  const undoCleared = (
    await db
      .update(timetablePlanVersions)
      .set({ undo: null })
      .where(and(inArray(timetablePlanVersions.status, [...PUBLISHED_STATUSES]), sql`${timetablePlanVersions.undo} is not null`, lte(timetablePlanVersions.validFrom, today)))
      .returning({ id: timetablePlanVersions.id })
  ).length;
  const ended = db.select({ id: schoolYears.id }).from(schoolYears).where(lt(schoolYears.endsOn, today));
  const discarded = (
    await db
      .update(timetablePlanVersions)
      .set({ status: "verworfen", discardedAt: now })
      .where(and(inArray(timetablePlanVersions.status, [...OPEN_STATUSES]), inArray(timetablePlanVersions.schoolYearId, ended)))
      .returning({ id: timetablePlanVersions.id })
  ).length;
  const based = await ensureBaseVersions(db, today);
  return { undoCleared, discarded, based };
}
