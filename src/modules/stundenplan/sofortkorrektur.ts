// SP3-05 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.4, F-10-2, R3): Sofort-Korrekturen am gültigen Plan. Die Planung (`stundenplan.manage`) darf
// weiter direkt im gültigen Plan ändern – aber **als Split** ab einem Stichtag (Vorgabe: nächster Schultag): die laufende Stunde endet am
// Vortag, eine neue gilt ab dem Stichtag; Vertretungen, Material und Klassenbuch-Einträge ab dem Stichtag ziehen mit (dieselben Regeln wie
// beim Veröffentlichen, `transferRefs`). In place bleibt nur, was keinen Vergangenheitsbezug hat (Stunde beginnt erst nach heute oder ist heute
// angelegt und hat noch keine Einträge). Jede Korrektur landet im Protokoll `timetable_plan_changes`, die Betroffenen bekommen einen Gong
// (Lehrkräfte sofort, Schüler:innen/Eltern zur Vortags-Uhrzeit), und offene Entwürfe ziehen nach (R3), damit ihr Diff nicht abreißt.
// Die Regeln selbst sind rein (`planUnit`), Lesen/Schreiben in `applyLiveUnits`.
import { and, asc, count, countDistinct, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { classbookEntries, schoolYears, timetableAbsenceMaterials, timetableLessons, timetableSubstitutions, users, type TimetableLesson } from "@/core/db/schema";
import { notifyBundled } from "@/core/notifications";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, isCalendarDate, toBerlinDate, TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { readSendWindows } from "./benachrichtigung";
import { changedFields, type DiffLesson } from "./plan-diff";
import { changeNames, notifyGroupLists } from "./plan-gong";
import { changeLists, transferRefs, type ChangeItem, type CreatedLesson } from "./plan-uebertrag";
import { ensureBaseVersions, OPEN_STATUSES, validVersion, versionNumber } from "./planversionen";
import { timetableDraftLessons, timetablePlanChanges, timetablePlanVersions, type PlanChangeKind } from "./schema";
import { plannedSendAt } from "./sendezeit";
import { mergesInto, notifyReleasedMerges } from "./vertretung";
import { deletedEntries, moveChangeHistory, recordLessonCascade, recordSubstitutionChanges } from "./vertretung-historie";

/** Ab so vielen direkt geänderten Stunden (je Aktion bzw. seit die gültige Version gilt) rät die Pflege zur Folgeversion (F-10-2). */
export const FOLLOW_UP_HINT = 10;
export const REASON_MAX = 120;

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const shortDayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });
const fmt = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));
const CHUNK = 500;
const chunks = <T>(xs: readonly T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** Gong-Bündel einer Sofort-Korrektur (eine Nachricht je Person und Aktion). */
export const correctionBundleKey = (batchId: string) => `stundenplan:korrektur:${batchId}`;

/** Optionen einer Änderung im gültigen Plan (Tests geben `today` vor; die Oberfläche den Stichtag nur über die Vorgabe). */
export interface LiveOptions {
  today?: string;
  /** Stichtag der Korrektur (Vorgabe: nächster Schultag nach heute) */
  from?: string;
  /** optionale Begründung (≤ 120 Zeichen, keine Personen) */
  reason?: string | null;
  /** Kennung der Aktion (Protokoll, Gong); die Oberfläche liest damit das Ergebnis für den Hinweis */
  batchId?: string;
  now?: Date;
}

/** Stand einer Stunde im Protokoll – Kennungen statt Namen. */
export interface PlanChangeLesson {
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
  week: "all" | "A" | "B";
  validFrom: string;
  validUntil: string | null;
  couplingId: string | null;
}

/** Eine Stunde des gültigen Plans vor der Änderung. */
export interface UnitBefore extends PlanChangeLesson {
  id: string;
  fixed: boolean;
  solverRunId: string | null;
}
/** Eine Stunde nach der Änderung (mit `id`: dieselbe Stunde wie vorher; ohne: neu). */
export interface UnitAfter extends PlanChangeLesson {
  id?: string;
}

export interface UnitChange {
  kind: PlanChangeKind;
  lessonId: string;
  successorId: string | null;
  validFrom: string;
  before: PlanChangeLesson | null;
  after: PlanChangeLesson | null;
}

export interface UnitPlan {
  mode: "noop" | "inplace" | "split";
  /** Stichtag: ab hier wirkt die Änderung (bei `inplace` heute) */
  cut: string;
  updates: { id: string; set: PlanChangeLesson }[];
  /** Stunden, die am Vortag des Stichtags enden */
  ends: string[];
  /** Stunden ohne Vergangenheitsbezug, die ganz entfallen */
  deletes: string[];
  inserts: (PlanChangeLesson & { id: string; fixed: boolean; solverRunId: string | null; predecessorId: string | null })[];
  changes: UnitChange[];
}

export const changeFields = (l: PlanChangeLesson): PlanChangeLesson => ({
  groupId: l.groupId,
  subjectId: l.subjectId,
  teacherId: l.teacherId,
  roomId: l.roomId,
  weekday: l.weekday,
  periodNr: l.periodNr,
  week: l.week,
  validFrom: l.validFrom,
  validUntil: l.validUntil,
  couplingId: l.couplingId,
});

/** Gleicher Inhalt (Gruppe, Fach, Lehrkraft, Raum, Tag, Stunde, Woche) – ohne Gültigkeit und Kopplungs-id. */
export const sameContent = (a: Omit<PlanChangeLesson, "validFrom" | "validUntil" | "couplingId">, b: Omit<PlanChangeLesson, "validFrom" | "validUntil" | "couplingId">) =>
  a.groupId === b.groupId && a.subjectId === b.subjectId && a.teacherId === b.teacherId && a.roomId === b.roomId && a.weekday === b.weekday && a.periodNr === b.periodNr && a.week === b.week;

const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

/**
 * Rein (§2.4): was eine Änderung an einer Einheit des gültigen Plans (Einzelstunde bzw. alle Teile einer Kopplung) bewirkt. `before` = Teile
 * vorher, `after` = Teile nachher (mit `id` = derselbe Teil); fehlt ein Teil in `after`, entfällt er; ohne `id` kommt er dazu.
 * - **ohne Vergangenheitsbezug** (`noPast`: beginnt erst nach heute bzw. heute angelegt ohne Einträge, oder eine neue Stunde): in place.
 * - **laufend, nur das Ende verschoben**: in place (frühestens bis heute; der Beginn lässt sich nicht mehr ändern).
 * - **laufend, Inhalt/Teile geändert**: Split ab dem Stichtag (`from`, bzw. ein späterer Beginn aus `after`) – alle Teile enden am Vortag, alle
 *   Teile nachher gelten ab dem Stichtag; eine Kopplung bekommt eine neue Kopplungs-id (Einheit wie beim Veröffentlichen).
 * - **laufend, entfällt**: endet am Vortag des Stichtags.
 */
export function planUnit(
  input: { before: readonly UnitBefore[]; after: readonly UnitAfter[]; coupled: boolean; today: string; from: string; noPast: boolean },
  newId: () => string = () => crypto.randomUUID(),
): UnitPlan {
  const { before, after, today, from } = input;
  const byId = new Map(before.map((b) => [b.id, b]));
  const kept = after.filter((a) => a.id && byId.has(a.id));
  const added = after.filter((a) => !a.id || !byId.has(a.id));
  const keptIds = new Set(kept.map((a) => a.id!));
  const removed = before.filter((b) => !keptIds.has(b.id));
  const plan: UnitPlan = { mode: "noop", cut: today, updates: [], ends: [], deletes: [], inserts: [], changes: [] };

  if (input.noPast || before.length === 0) {
    for (const a of kept) {
      const b = byId.get(a.id!)!;
      const set = changeFields(a);
      const same = sameContent(b, a) && b.validFrom === a.validFrom && b.validUntil === a.validUntil && b.couplingId === a.couplingId;
      if (same) continue;
      plan.updates.push({ id: b.id, set });
      plan.changes.push({ kind: "inplace", lessonId: b.id, successorId: null, validFrom: later(earlier(b.validFrom, a.validFrom), today), before: changeFields(b), after: set });
    }
    for (const b of removed) {
      plan.deletes.push(b.id);
      plan.changes.push({ kind: "delete", lessonId: b.id, successorId: null, validFrom: later(b.validFrom, today), before: changeFields(b), after: null });
    }
    for (const a of added) {
      const id = newId();
      plan.inserts.push({ ...changeFields(a), id, fixed: false, solverRunId: null, predecessorId: null });
      plan.changes.push({ kind: "create", lessonId: id, successorId: null, validFrom: later(a.validFrom, today), before: null, after: changeFields(a) });
    }
    if (plan.changes.length) plan.mode = "inplace";
    return plan;
  }

  const contentSame = removed.length === 0 && added.length === 0 && kept.every((a) => sameContent(byId.get(a.id!)!, a));
  if (contentSame) {
    // laufend, gleicher Inhalt: höchstens das Ende verschieben
    for (const a of kept) {
      const b = byId.get(a.id!)!;
      if (a.validFrom !== b.validFrom)
        throw new ValidationError({ validFrom: `Die Stunde läuft seit ${fmt(b.validFrom)} – der Beginn lässt sich nicht mehr ändern (eine inhaltliche Änderung gilt ab ${fmt(from)})` });
      if (a.validUntil === b.validUntil) continue;
      if (a.validUntil !== null && a.validUntil < today) throw new ValidationError({ validUntil: `Frühestens bis heute (${fmt(today)}) – vergangene Tage bleiben, wie sie waren` });
      const set = { ...changeFields(b), validUntil: a.validUntil };
      plan.updates.push({ id: b.id, set });
      plan.changes.push({ kind: "inplace", lessonId: b.id, successorId: null, validFrom: today, before: changeFields(b), after: set });
    }
    if (plan.changes.length) plan.mode = "inplace";
    return plan;
  }

  // laufend und geändert: Split ab dem Stichtag
  const cut = later(from, after[0]?.validFrom ?? from);
  for (const b of before)
    if (b.validUntil !== null && b.validUntil < cut)
      throw new ValidationError({ validFrom: `Die Stunde endet am ${fmt(b.validUntil)} – eine Änderung ab ${fmt(cut)} wirkt nicht mehr` });
  for (const a of after)
    if (a.validUntil !== null && a.validUntil < cut) throw new ValidationError({ validUntil: `Die Änderung gilt ab ${fmt(cut)} – das Ende muss danach liegen` });
  plan.mode = "split";
  plan.cut = cut;
  plan.ends = before.map((b) => b.id);
  const couplingId = input.coupled && after.length > 1 ? newId() : null;
  for (const a of after) {
    const b = a.id ? byId.get(a.id) : undefined;
    const id = newId();
    const row = { ...changeFields(a), validFrom: cut, couplingId };
    plan.inserts.push({ ...row, id, fixed: b?.fixed ?? false, solverRunId: b?.solverRunId ?? null, predecessorId: b?.id ?? null });
    plan.changes.push(
      b
        ? { kind: "split", lessonId: b.id, successorId: id, validFrom: cut, before: changeFields(b), after: row }
        : { kind: "create", lessonId: id, successorId: null, validFrom: cut, before: null, after: row },
    );
  }
  for (const b of removed) plan.changes.push({ kind: "delete", lessonId: b.id, successorId: null, validFrom: cut, before: changeFields(b), after: null });
  return plan;
}

// ---------------------------------------------------------------- Lesen

/** Stichtag einer Sofort-Korrektur: der nächste Schultag nach heute (bzw. ein vorgegebener Schultag nach heute). */
export async function correctionFrom(db: Db, today: string, from?: string): Promise<string> {
  const cal = await loadSchoolCalendar(db);
  if (from === undefined) return cal.nextSchoolDay(addDays(today, 1));
  if (!isCalendarDate(from)) throw new ValidationError({ validFrom: "Stichtag wählen" });
  if (from <= today) throw new ValidationError({ validFrom: "Der Stichtag muss in der Zukunft liegen" });
  if (!cal.isSchoolDay(from)) throw new ValidationError({ validFrom: `Der ${fmt(from)} ist kein Schultag – nächster Schultag: ${fmt(cal.nextSchoolDay(from))}` });
  return from;
}

/**
 * Haben die Stunden einen Vergangenheitsbezug? Nein, wenn alle erst nach heute beginnen oder heute in der Pflege neu angelegt wurden
 * (Protokoll-Eintrag „neu“ von heute) und noch keine Klassenbuch-Einträge, Vertretungen oder Materialien bis heute haben – der Tippfehler
 * gleich nach dem Anlegen. Eingespielte oder veröffentlichte Stunden zählen immer als laufend.
 */
export async function withoutPast(db: Db, rows: readonly Pick<TimetableLesson, "id" | "validFrom">[], today: string): Promise<boolean> {
  if (rows.every((r) => r.validFrom > today)) return true;
  const ids = rows.map((r) => r.id);
  const created = await db
    .select({ lessonId: timetablePlanChanges.lessonId, createdAt: timetablePlanChanges.createdAt })
    .from(timetablePlanChanges)
    .where(and(eq(timetablePlanChanges.kind, "create"), inArray(timetablePlanChanges.lessonId, ids)));
  const fresh = new Set(created.filter((c) => toBerlinDate(c.createdAt) === today).map((c) => c.lessonId));
  if (!rows.every((r) => r.validFrom > today || fresh.has(r.id))) return false;
  const [a, b, c] = await Promise.all([
    db.$count(classbookEntries, and(inArray(classbookEntries.lessonId, ids), lte(classbookEntries.date, today))),
    db.$count(timetableSubstitutions, and(or(inArray(timetableSubstitutions.lessonId, ids), inArray(timetableSubstitutions.mergeLessonId, ids)), lte(timetableSubstitutions.date, today))),
    db.$count(timetableAbsenceMaterials, and(inArray(timetableAbsenceMaterials.lessonId, ids), lte(timetableAbsenceMaterials.date, today))),
  ]);
  return a + b + c === 0;
}

export const toBefore = (l: TimetableLesson): UnitBefore => ({ id: l.id, ...changeFields(l), fixed: l.fixed, solverRunId: l.solverRunId });

/** Die gültige Version des Schuljahrs, in dem `ymd` liegt (nach „Bestand 1.0“). */
async function versionAt(db: Db, ymd: string, today: string) {
  await ensureBaseVersions(db, today);
  const [year] = await db.select({ id: schoolYears.id }).from(schoolYears).where(and(lte(schoolYears.startsOn, ymd), gte(schoolYears.endsOn, ymd)));
  return year ? validVersion(db, year.id) : null;
}

/** Zahl der direkt geänderten Stunden (Protokoll-Zeilen) einer gültigen Version. */
export async function correctionCount(db: Db, versionId: string): Promise<number> {
  return db.$count(timetablePlanChanges, eq(timetablePlanChanges.versionId, versionId));
}

/** SP3-05 (R3): Sofort-Korrekturen (Aktionen) im Schuljahr seit einem Zeitpunkt – für Diff und Veröffentlichen eines Entwurfs. */
export async function correctionsSince(db: Db, schoolYearId: string, since: Date): Promise<{ actions: number; lessons: number }> {
  const [r] = await db
    .select({ actions: countDistinct(timetablePlanChanges.batchId), lessons: count() })
    .from(timetablePlanChanges)
    .innerJoin(timetablePlanVersions, eq(timetablePlanVersions.id, timetablePlanChanges.versionId))
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), sql`${timetablePlanChanges.createdAt} > ${since.toISOString()}::timestamptz`));
  return { actions: Number(r?.actions ?? 0), lessons: Number(r?.lessons ?? 0) };
}

export interface CorrectionSummary {
  batchId: string;
  from: string;
  lessons: number;
  kinds: Record<PlanChangeKind, number>;
  versionLabel: string | null;
  /** direkt geänderte Stunden der gültigen Version insgesamt */
  versionTotal: number;
  /** Hinweis „besser als Folgeversion“ (ab `FOLLOW_UP_HINT` Stunden in der Aktion oder in der Version) */
  suggestFollowUp: boolean;
}

/** Ergebnis einer Aktion für den Hinweis in der Pflege (`null`, wenn es die Aktion nicht gibt). */
export async function correctionSummary(db: Db, batchId: string): Promise<CorrectionSummary | null> {
  const rows = await db.select().from(timetablePlanChanges).where(eq(timetablePlanChanges.batchId, batchId)).orderBy(asc(timetablePlanChanges.validFrom), asc(timetablePlanChanges.id));
  if (!rows.length) return null;
  const kinds: Record<PlanChangeKind, number> = { split: 0, inplace: 0, delete: 0, create: 0 };
  for (const r of rows) kinds[r.kind]++;
  const versionId = rows[0]!.versionId;
  const [v] = versionId ? await db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, versionId)) : [];
  const versionTotal = versionId ? await correctionCount(db, versionId) : rows.length;
  return {
    batchId,
    from: rows[0]!.validFrom,
    lessons: rows.length,
    kinds,
    versionLabel: v ? versionNumber(v) : null,
    versionTotal,
    suggestFollowUp: rows.length >= FOLLOW_UP_HINT || versionTotal >= FOLLOW_UP_HINT,
  };
}

// ---------------------------------------------------------------- Gong

/** Rein: Nachricht einer Sofort-Korrektur – Titel mit Stichtag und Zahl, je Änderung eine Zeile. */
export function correctionMessage(fromLabel: string, lines: readonly string[]): { title: string; body: string } {
  const title = `Stundenplan ab ${fromLabel} geändert: ${lines.length === 1 ? "1 Änderung" : `${lines.length} Änderungen`} für dich`;
  const shown = lines.slice(0, 12);
  const more = lines.length - shown.length;
  return { title, body: `${shown.join(" · ")}${more > 0 ? ` · … und ${more} weitere – siehe Stundenplan` : ""}` };
}

const asDiff = (id: string, l: PlanChangeLesson): DiffLesson => ({
  id,
  groupId: l.groupId,
  subjectId: l.subjectId,
  teacherId: l.teacherId,
  roomId: l.roomId,
  weekday: l.weekday,
  periodNr: l.periodNr,
  week: l.week,
  couplingId: l.couplingId,
});

/** Rein: sichtbare Änderungen für die Änderungsliste (ohne „nur Zeitraum“/„nur Kopplungs-id“). */
export function changeItems(rows: readonly Pick<UnitChange, "kind" | "lessonId" | "before" | "after">[]): ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const r of rows) {
    if (r.kind === "create" && r.after) out.push({ kind: "added", before: null, after: asDiff(r.lessonId, r.after), changes: [] });
    else if (r.kind === "delete" && r.before) out.push({ kind: "removed", before: asDiff(r.lessonId, r.before), after: null, changes: [] });
    else if (r.before && r.after) {
      const b = asDiff(r.lessonId, r.before);
      const a = asDiff(r.lessonId, r.after);
      const changes = changedFields(b, a);
      if (changes.length) out.push({ kind: "changed", before: b, after: a, changes });
    }
  }
  return out;
}

const planHref = (from: string) => `/stundenplan?woche=${from}`;

/** Änderungsliste einer Aktion an Schüler:innen und Eltern senden – genau einmal (Zeilen werden unter der Zeilensperre beansprucht). */
async function sendBatch(db: Db, batchId: string, now: Date): Promise<number> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const claimed = await tx
      .update(timetablePlanChanges)
      .set({ notifiedAt: now })
      .where(and(eq(timetablePlanChanges.batchId, batchId), isNull(timetablePlanChanges.notifiedAt)))
      .returning();
    if (!claimed.length) return 0;
    const lists = changeLists(
      changeItems(claimed.map((c) => ({ kind: c.kind, lessonId: c.lessonId ?? c.id, before: c.before as PlanChangeLesson | null, after: c.after as PlanChangeLesson | null }))),
      await changeNames(tx),
    );
    const from = claimed.map((c) => c.validFrom).sort()[0]!;
    const label = shortDayFmt.format(fromBerlinLocal(from));
    return notifyGroupLists(tx, Object.fromEntries(lists.byGroup), (lines) => correctionMessage(label, lines), { href: planHref(from), bundleKey: correctionBundleKey(batchId) });
  });
}

/** Minutentakt (Job „vertretung-gong“): fällige Änderungslisten der Sofort-Korrekturen an Schüler:innen/Eltern senden. */
export async function runPlanChangeNotifications(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db
    .selectDistinct({ batchId: timetablePlanChanges.batchId })
    .from(timetablePlanChanges)
    .where(and(isNull(timetablePlanChanges.notifiedAt), isNotNull(timetablePlanChanges.notifyAt), lte(timetablePlanChanges.notifyAt, now)))
    .orderBy(asc(timetablePlanChanges.batchId));
  let sent = 0;
  for (const { batchId } of due) sent += await sendBatch(db, batchId, now);
  return sent;
}

/** Nach einer Änderung der Sendezeiten: offene Änderungslisten neu planen. */
export async function reschedulePlanChangeNotifications(db: Db): Promise<number> {
  const windows = await readSendWindows(db);
  const rows = await db
    .select({ id: timetablePlanChanges.id, validFrom: timetablePlanChanges.validFrom, createdAt: timetablePlanChanges.createdAt, notifyAt: timetablePlanChanges.notifyAt })
    .from(timetablePlanChanges)
    .where(and(isNull(timetablePlanChanges.notifiedAt), isNotNull(timetablePlanChanges.notifyAt)));
  let changed = 0;
  for (const r of rows) {
    const due = plannedSendAt(r.validFrom, r.createdAt, windows.lernende);
    if (r.notifyAt && due.getTime() === r.notifyAt.getTime()) continue;
    await db.update(timetablePlanChanges).set({ notifyAt: due }).where(eq(timetablePlanChanges.id, r.id));
    changed++;
  }
  return changed;
}

// ---------------------------------------------------------------- Entwürfe nachziehen (R3)

const overlaps = (a: { validFrom: string; validUntil: string | null; week: string }, b: { validFrom: string; validUntil: string | null; week: string }) =>
  (a.week === "all" || b.week === "all" || a.week === b.week) && a.validFrom <= (b.validUntil ?? "9999-12-31") && b.validFrom <= (a.validUntil ?? "9999-12-31");

/** Kollidiert eine Stunde im Entwurf (Lehrkraft, Raum, Gruppe) mit einer anderen Stunde der Version – ohne die eigene Einheit? */
async function draftClash(db: Db, versionId: string, l: PlanChangeLesson, exclude: { ids: readonly string[]; couplingId: string | null }): Promise<boolean> {
  const t = timetableDraftLessons;
  const who = [eq(t.groupId, l.groupId), ...(l.teacherId ? [eq(t.teacherId, l.teacherId)] : []), ...(l.roomId ? [eq(t.roomId, l.roomId)] : [])];
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.versionId, versionId), eq(t.weekday, l.weekday), eq(t.periodNr, l.periodNr), or(...who)));
  return rows.some((r) => !exclude.ids.includes(r.id) && !(exclude.couplingId && r.couplingId === exclude.couplingId) && overlaps(r, l));
}

/**
 * R3 (Vorgabe SP3-05): offene Entwürfe (Entwurf, in Prüfung, freigegeben) ziehen eine Sofort-Korrektur nach, damit der Diff beim
 * Veröffentlichen nicht abreißt und die Korrektur nicht zurückdreht. Je Entwurfsstunde mit Herkunft in der Einheit:
 * - **Split** (Entwurf gilt ab dem Stichtag der Korrektur oder später): Herkunft → Nachfolgerin; war die Entwurfsstunde wie die alte
 *   Stunde, übernimmt sie auch den neuen Inhalt (nicht bei einer Kollision im Entwurf); eine neue Kopplungs-id gilt für alle Teile im Entwurf.
 * - **in place**: war die Entwurfsstunde wie die alte Stunde, übernimmt sie den neuen Inhalt.
 * - **entfällt**: war die Entwurfsstunde wie die alte Stunde, entfällt sie auch im Entwurf.
 * - **neu**: kommt in jeden Entwurf, der noch während ihrer Gültigkeit beginnt (Beginn frühestens am Stichtag des Entwurfs), wenn sie dort
 *   nicht kollidiert.
 * Was der Entwurf schon anders geplant hatte, bleibt – der Diff zeigt es dann als Änderung. Die Unterschiede zum gültigen Plan werden dadurch
 * nie größer; eine Freigabe bleibt deshalb bestehen. Gibt nachgezogene bzw. nicht nachgezogene Entwurfsstunden zurück.
 */
async function followDrafts(tx: Db, plans: readonly UnitPlan[]): Promise<{ followed: number; skipped: number; versions: number }> {
  const beforeIds = plans.flatMap((p) => p.changes.filter((c) => c.kind !== "create").map((c) => c.lessonId));
  const creates = plans.flatMap((p) => p.changes.filter((c) => c.kind === "create").map((c) => ({ plan: p, change: c })));
  const open = await tx
    .select({ id: timetablePlanVersions.id, validFrom: timetablePlanVersions.validFrom })
    .from(timetablePlanVersions)
    .where(inArray(timetablePlanVersions.status, [...OPEN_STATUSES]))
    .orderBy(asc(timetablePlanVersions.createdAt), asc(timetablePlanVersions.id));
  if (!open.length) return { followed: 0, skipped: 0, versions: 0 };
  const startOf = new Map(open.map((v) => [v.id, v.validFrom]));
  const drafts: (typeof timetableDraftLessons.$inferSelect)[] = [];
  for (const part of chunks(beforeIds))
    drafts.push(
      ...(await tx
        .select()
        .from(timetableDraftLessons)
        .where(and(inArray(timetableDraftLessons.originLessonId, part), inArray(timetableDraftLessons.versionId, open.map((v) => v.id))))
        .orderBy(asc(timetableDraftLessons.createdAt), asc(timetableDraftLessons.id))),
    );
  let followed = 0;
  let skipped = 0;
  const touched = new Set<string>();
  /** je Version: alte → neue Kopplungs-id */
  const couplings = new Map<string, Map<string, string | null>>();
  for (const p of plans)
    for (const c of p.changes) {
      if (c.kind === "create") continue;
      const before = c.before!;
      for (const d of drafts.filter((x) => x.originLessonId === c.lessonId)) {
        const vFrom = startOf.get(d.versionId) ?? null;
        // ein Entwurf, der vor dem Stichtag der Korrektur beginnt, behält die bisherige Stunde (sie gilt an seinem Stichtag noch)
        if (p.mode === "split" && (vFrom === null || vFrom < c.validFrom)) {
          skipped++;
          continue;
        }
        touched.add(d.versionId);
        const asBefore = sameContent(d, before);
        if (c.kind === "delete") {
          if (asBefore) {
            await tx.delete(timetableDraftLessons).where(eq(timetableDraftLessons.id, d.id));
            followed++;
          } else skipped++;
          continue;
        }
        const after = c.after!;
        const set: Partial<typeof timetableDraftLessons.$inferInsert> = {};
        if (c.kind === "split") set.originLessonId = c.successorId;
        if (p.mode === "split" && before.couplingId && after.couplingId !== before.couplingId) {
          const m = couplings.get(d.versionId) ?? new Map<string, string | null>();
          m.set(before.couplingId, after.couplingId);
          couplings.set(d.versionId, m);
        }
        const target = { ...after, validFrom: d.validFrom, validUntil: d.validUntil === before.validUntil ? after.validUntil : d.validUntil };
        if (asBefore && !(await draftClash(tx, d.versionId, target, { ids: [d.id], couplingId: d.couplingId }))) {
          Object.assign(set, {
            groupId: after.groupId,
            subjectId: after.subjectId,
            teacherId: after.teacherId,
            roomId: after.roomId,
            weekday: after.weekday,
            periodNr: after.periodNr,
            week: after.week,
            validUntil: target.validUntil !== null && target.validUntil < d.validFrom ? d.validFrom : target.validUntil,
          });
          followed++;
        } else if (!sameContent(d, after)) skipped++;
        if (Object.keys(set).length) await tx.update(timetableDraftLessons).set(set).where(eq(timetableDraftLessons.id, d.id));
      }
    }
  for (const [versionId, m] of couplings)
    for (const [from, to] of m) await tx.update(timetableDraftLessons).set({ couplingId: to }).where(and(eq(timetableDraftLessons.versionId, versionId), eq(timetableDraftLessons.couplingId, from)));
  for (const { plan, change } of creates) {
    const n = change.after!;
    for (const v of open) {
      if (!v.validFrom || (n.validUntil !== null && n.validUntil < v.validFrom) || (plan.mode === "split" && v.validFrom < change.validFrom)) continue;
      const row = { ...n, validFrom: later(n.validFrom, v.validFrom) };
      if (await draftClash(tx, v.id, row, { ids: [], couplingId: n.couplingId })) {
        skipped++;
        continue;
      }
      await tx.insert(timetableDraftLessons).values({ ...row, versionId: v.id, originLessonId: change.lessonId });
      touched.add(v.id);
      followed++;
    }
  }
  return { followed, skipped, versions: touched.size };
}

// ---------------------------------------------------------------- Schreiben

export interface LiveChangeResult {
  batchId: string;
  mode: "inplace" | "split";
  from: string;
  lessons: number;
}

/**
 * Schreibt die Pläne der Einheiten in **einer** Transaktion: neue Zeilen (mit `plan_version_id` der gültigen Version), Übertrag der
 * Vertretungen/Material/Klassenbuch-Einträge ab dem Stichtag (bei in place: an Tagen, an denen die Stunde nicht mehr stattfindet, werden
 * Vertretungen und Material entfernt), Ende bzw. Änderung der bisherigen Zeilen, Löschen ohne Vergangenheitsbezug, Entwürfe nachziehen (R3),
 * Protokoll und Gong (Lehrkräfte sofort, Schüler:innen/Eltern zur Vortags-Uhrzeit). `null`, wenn sich nichts ändert.
 */
export async function applyLiveUnits(db: Db, actorId: string, plans: readonly UnitPlan[], opts: LiveOptions = {}): Promise<LiveChangeResult | null> {
  const active = plans.filter((p) => p.mode !== "noop" && p.changes.length);
  if (!active.length) return null;
  const today = opts.today ?? toBerlinDate(new Date());
  const now = opts.now ?? new Date();
  const batchId = opts.batchId ?? crypto.randomUUID();
  const reason = cleanReason(opts.reason);
  const effective = active.map((p) => p.changes.map((c) => c.validFrom).sort()[0]!).sort()[0]!;
  const windows = await readSendWindows(db);
  const names = await changeNames(db);
  const hardDeletes = active.flatMap((p) => p.deletes);
  const released = await mergesInto(db, hardDeletes, today);

  const out = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const version = await versionAt(tx, effective, today);
    const rowsBefore = new Map<string, TimetableLesson>();
    const ids = active.flatMap((p) => [...p.ends, ...p.deletes, ...p.updates.map((u) => u.id), ...p.inserts.flatMap((i) => (i.predecessorId ? [i.predecessorId] : []))]);
    for (const part of chunks(ids)) for (const l of await tx.select().from(timetableLessons).where(inArray(timetableLessons.id, part))) rowsBefore.set(l.id, l);

    // 1. neue Zeilen
    const inserts = active.flatMap((p) => p.inserts);
    for (const part of chunks(inserts))
      await tx.insert(timetableLessons).values(
        part.map((l) => ({
          id: l.id,
          ...changeFields(l),
          fixed: l.fixed,
          solverRunId: l.solverRunId,
          planVersionId: version?.id ?? (l.predecessorId ? (rowsBefore.get(l.predecessorId)?.planVersionId ?? null) : null),
        })),
      );

    // 2. Übertrag ab dem Stichtag (Split) bzw. ab heute (in place)
    let movedRefs = 0;
    let removedRefs = 0;
    for (const p of active) {
      const successor = new Map<string, CreatedLesson>();
      for (const i of p.inserts) if (i.predecessorId) successor.set(i.predecessorId, { ...i, draftId: "", predecessorId: i.predecessorId });
      for (const u of p.updates) successor.set(u.id, { id: u.id, ...u.set, fixed: false, solverRunId: null, draftId: "", predecessorId: u.id });
      const gone = new Set([...p.ends, ...p.updates.map((u) => u.id)]);
      if (!gone.size) continue;
      const from = p.mode === "split" ? p.cut : today;
      const goneIds = [...gone];
      const subs = await tx
        .select()
        .from(timetableSubstitutions)
        .where(and(or(inArray(timetableSubstitutions.lessonId, goneIds), inArray(timetableSubstitutions.mergeLessonId, goneIds)), gte(timetableSubstitutions.date, from)))
        .orderBy(asc(timetableSubstitutions.date), asc(timetableSubstitutions.id));
      const mats = await tx
        .select({ id: timetableAbsenceMaterials.id, lessonId: timetableAbsenceMaterials.lessonId, date: timetableAbsenceMaterials.date })
        .from(timetableAbsenceMaterials)
        .where(and(inArray(timetableAbsenceMaterials.lessonId, goneIds), gte(timetableAbsenceMaterials.date, from)))
        .orderBy(asc(timetableAbsenceMaterials.date), asc(timetableAbsenceMaterials.id));
      const book = (
        await tx
          .select({ id: classbookEntries.id, lessonId: classbookEntries.lessonId, date: classbookEntries.date })
          .from(classbookEntries)
          .where(and(inArray(classbookEntries.lessonId, goneIds), gte(classbookEntries.date, from)))
          .orderBy(asc(classbookEntries.date), asc(classbookEntries.id))
      ).filter((b): b is { id: string; lessonId: string; date: string } => b.lessonId !== null);
      const refs = transferRefs({ from, kept: [], successor, gone }, new Map(), {
        substitutions: subs.map((s) => ({ id: s.id, lessonId: s.lessonId, date: s.date, kind: s.kind, targetPeriod: s.targetPeriod, mergeLessonId: s.mergeLessonId })),
        materials: mats,
        classbook: book,
      });
      for (const m of refs.substitutionMoves)
        await tx
          .update(timetableSubstitutions)
          .set({ ...(m.lessonId ? { lessonId: m.lessonId.to } : {}), ...(m.mergeLessonId ? { mergeLessonId: m.mergeLessonId.to } : {}) })
          .where(eq(timetableSubstitutions.id, m.id));
      for (const m of refs.materialMoves) await tx.update(timetableAbsenceMaterials).set({ lessonId: m.to }).where(eq(timetableAbsenceMaterials.id, m.id));
      for (const m of refs.classbookMoves) await tx.update(classbookEntries).set({ lessonId: m.to }).where(eq(classbookEntries.id, m.id));
      for (const [fromId, s] of successor) if (s.id !== fromId) await moveChangeHistory(tx, fromId, s.id, from);
      for (const part of chunks(refs.substitutionsRemoved)) {
        const removed = await tx.delete(timetableSubstitutions).where(inArray(timetableSubstitutions.id, part)).returning();
        await recordSubstitutionChanges(tx, actorId, deletedEntries(removed, "delete"));
      }
      for (const part of chunks(refs.materialsRemoved)) await tx.delete(timetableAbsenceMaterials).where(inArray(timetableAbsenceMaterials.id, part));
      for (const part of chunks(refs.classbookDetached.map((d) => d.id))) await tx.update(classbookEntries).set({ lessonId: null }).where(inArray(classbookEntries.id, part));
      movedRefs += refs.substitutionMoves.length + refs.materialMoves.length + refs.classbookMoves.length;
      removedRefs += refs.substitutionsRemoved.length + refs.materialsRemoved.length + refs.classbookDetached.length;
    }

    // 3. Entwürfe nachziehen (R3) – vor dem Löschen, solange die Herkunft noch steht
    const drafts = await followDrafts(tx, active);

    // 4. bisherige Zeilen: ändern, am Vortag enden lassen, ohne Vergangenheitsbezug löschen
    for (const p of active) {
      for (const u of p.updates) await tx.update(timetableLessons).set(u.set).where(eq(timetableLessons.id, u.id));
      if (p.ends.length) await tx.update(timetableLessons).set({ validUntil: addDays(p.cut, -1) }).where(inArray(timetableLessons.id, p.ends));
    }
    if (hardDeletes.length) {
      // VT-01: Vertretungen gehen per Kaskade mit – vorher in die Historie
      await recordLessonCascade(tx, actorId, hardDeletes, "delete");
      await tx.delete(timetableLessons).where(inArray(timetableLessons.id, hardDeletes));
      // eine Kopplung mit nur noch einem Teil ist keine mehr
      const couplingIds = [...new Set(hardDeletes.map((id) => rowsBefore.get(id)?.couplingId).filter((c): c is string => Boolean(c)))];
      for (const cid of couplingIds) {
        const rest = await tx.select({ id: timetableLessons.id }).from(timetableLessons).where(eq(timetableLessons.couplingId, cid));
        if (rest.length === 1) await tx.update(timetableLessons).set({ couplingId: null }).where(eq(timetableLessons.id, rest[0]!.id));
      }
    }

    // 5. Protokoll und Gong
    const changes = active.flatMap((p) => p.changes);
    const items = changeItems(changes);
    const lists = changeLists(items, names);
    const notifyAt = lists.byGroup.size ? plannedSendAt(effective, now, windows.lernende) : null;
    await tx.insert(timetablePlanChanges).values(
      changes.map((c) => ({
        versionId: version?.id ?? null,
        batchId,
        kind: c.kind,
        // ohne Vergangenheitsbezug gelöschte Stunden gibt es nicht mehr
        lessonId: c.kind === "delete" && hardDeletes.includes(c.lessonId) ? null : c.lessonId,
        successorId: c.successorId,
        validFrom: c.validFrom,
        before: c.before,
        after: c.after,
        reason,
        actorId,
        createdAt: now,
        notifyAt,
        notifiedAt: notifyAt ? null : now,
      })),
    );
    const label = shortDayFmt.format(fromBerlinLocal(effective));
    const teacherItems = [...lists.byTeacher].filter(([id]) => id !== actorId).map(([userId, lines]) => ({ userId, ...correctionMessage(label, lines), href: planHref(effective) }));
    const known = new Set(teacherItems.length ? (await tx.select({ id: users.id }).from(users).where(inArray(users.id, teacherItems.map((t) => t.userId)))).map((u) => u.id) : []);
    const teachers = await notifyBundled(
      tx,
      teacherItems.filter((t) => known.has(t.userId)),
      { moduleId: "stundenplan", bundleKey: correctionBundleKey(batchId) },
    );
    return { version, changes, notifyAt, teachers, groups: lists.byGroup.size, drafts, movedRefs, removedRefs };
  });

  if (out.notifyAt && out.notifyAt.getTime() <= now.getTime()) await sendBatch(db, batchId, now);
  await notifyReleasedMerges(db, actorId, released);
  const kinds = { split: 0, inplace: 0, delete: 0, create: 0 } satisfies Record<PlanChangeKind, number>;
  for (const c of out.changes) kinds[c.kind]++;
  const mode = active.some((p) => p.mode === "split") ? "split" : "inplace";
  await audit(db, actorId, "stundenplan.plan.correction", out.version?.id ?? null, {
    batch: batchId,
    from: effective,
    mode,
    ...kinds,
    refsMoved: out.movedRefs || undefined,
    refsRemoved: out.removedRefs || undefined,
    teachers: out.teachers,
    groups: out.groups,
    draftsFollowed: out.drafts.followed || undefined,
    draftsSkipped: out.drafts.skipped || undefined,
    reason: reason ? true : undefined,
  });
  return { batchId, mode, from: effective, lessons: out.changes.length };
}

function cleanReason(reason: string | null | undefined): string | null {
  const r = (reason ?? "").replace(/\s+/g, " ").trim();
  if (!r) return null;
  if (r.length > REASON_MAX) throw new ValidationError({ reason: `Höchstens ${REASON_MAX} Zeichen` });
  return r;
}

/** Begründung vorab prüfen (vor Kollisionsprüfung und Schreiben). */
export const checkReason = (reason: string | null | undefined) => cleanReason(reason);
