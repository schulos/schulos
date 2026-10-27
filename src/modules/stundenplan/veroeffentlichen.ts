// SP3-04 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1, §2.3, R1/R2): eine freigegebene Planversion ab einem Stichtag veröffentlichen – als Diff
// gegen den gültigen Plan (unveränderte Stunden behalten ihre id; Vertretungen, Material und Klassenbuch ziehen um oder werden gezählt),
// Vorgängerversion archiviert, Varianten derselben Nummer verworfen, Rücknahme-Daten (`undo`) bis zum Stichtag, Änderungsliste je Person
// als gebündelter Gong. `undoPublish()` stellt bis zum Stichtag Stunden, Vertretungen und Material wieder her (SP-13-Niveau, Konfliktzählung
// wie beim Zurücknehmen einer Solver-Übernahme). Die Regeln selbst sind rein in `plan-uebertrag.ts`.
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import {
  classbookEntries,
  groupMembers,
  groups,
  notifications,
  rooms,
  schoolYears,
  subjects,
  timetableAbsenceMaterials,
  timetableLessons,
  timetableSubstitutionChanges,
  timetableSubstitutions,
  users,
  type TimetableLesson,
} from "@/core/db/schema";
import { notifyBundled } from "@/core/notifications";
import { addDays, fromBerlinLocal, isCalendarDate, TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { readSendWindows } from "./benachrichtigung";
import { planDiff, type DiffKind } from "./plan-diff";
import { changeLists, holdsOn, planMessage, transferPlan, transferRefs, type ChangeItem, type ChangeNames, type RefTransfer, type TransferLesson, type TransferPlan } from "./plan-uebertrag";
import { checkValidFrom, getVersion, OPEN_STATUSES, versionNumber } from "./planversionen";
import { timetableDraftLessons, timetablePlanVersions, type PlanVersionStatus, type TimetablePlanVersion } from "./schema";
import { plannedSendAt } from "./sendezeit";
import { roomClashes, substitutionsToRestore, type UndoSubstitution } from "./solverlauf";
import { deletedEntries, moveChangeHistory, recordLessonCascade, recordSubstitutionChanges, snapshotOf } from "./vertretung-historie";
import { informedParents } from "./vertretung-gong";

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const shortDayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });
const fmt = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

const CHUNK = 500;
const chunks = <T>(xs: readonly T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** Bündel-Schlüssel des Gongs einer Veröffentlichung (eine Nachricht je Person und Version; Rücknahme ersetzt sie). */
export const planBundleKey = (versionId: string) => `stundenplan:plan:${versionId}`;

// ---------------------------------------------------------------- Rücknahme-Daten

/** Eine beim Veröffentlichen gelöschte Stunde (begann erst ab dem Stichtag) – vollständig zum Wiederanlegen. */
export type PublishUndoLesson = Pick<TimetableLesson, "id" | "groupId" | "weekday" | "periodNr" | "subjectId" | "teacherId" | "roomId" | "week" | "validFrom" | "validUntil" | "couplingId" | "fixed" | "solverRunId" | "planVersionId">;

/** Ein beim Veröffentlichen gelöschtes Material (Nachfolger findet an dem Tag nicht statt) – vollständig zum Wiederanlegen. */
export interface PublishUndoMaterial {
  id: string;
  absenceId: string | null;
  lessonId: string;
  date: string;
  text: string | null;
  fileKey: string | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  forStudents: boolean;
  createdBy: string | null;
  createdAt: string;
}

/**
 * SP3-04: was das Veröffentlichen am gültigen Plan und an den Versionen geändert hat – Grundlage für „Veröffentlichung zurücknehmen“.
 * Enthält Lehrkraft-Kennungen und wird deshalb ab dem Stichtag geleert (Nachtjob) bzw. beim Zurücknehmen; die Kontolöschung ersetzt sie.
 */
export interface PublishUndo {
  from: string;
  /** vorgemerkter Stichtag des Entwurfs vor dem Veröffentlichen */
  draftValidFrom: string | null;
  /** Nummer vor dem Veröffentlichen, falls sie beim Veröffentlichen neu vergeben wurde */
  number?: { major: number; minor: number };
  /** archivierte Vorgängerversion mit ihrem früheren Ende */
  previous: { id: string; validUntil: string | null } | null;
  /** Varianten derselben Nummer, die beim Veröffentlichen verworfen wurden, mit ihrem früheren Status */
  discarded: { id: string; status: PlanVersionStatus }[];
  kept: number;
  ended: { id: string; validUntil: string | null }[];
  deleted: PublishUndoLesson[];
  /** neue Stunden mit Vorgängerin und Inhalt beim Veröffentlichen (Konfliktzählung „seitdem verändert“) */
  created: { id: string; of: string | null; key: string }[];
  /** umgezogene Vertretungen (Stunde bzw. aufnehmende Stunde), Material und Klassenbuch-Einträge */
  moved: { kind: "substitution" | "merge" | "material" | "classbook"; id: string; from: string; to: string }[];
  substitutions: UndoSubstitution[];
  materials: PublishUndoMaterial[];
  classbookDetached: { id: string; lessonId: string }[];
}

const lessonKey = (l: { groupId: string; subjectId: string; teacherId: string | null; roomId: string | null; weekday: number; periodNr: number; week: string; validFrom: string }) =>
  `${l.groupId}|${l.subjectId}|${l.teacherId ?? ""}|${l.roomId ?? ""}|${l.weekday}|${l.periodNr}|${l.week}|${l.validFrom}`;

/** VT-01: Historie der Vertretungen ab `fromYmd` mitnehmen – nur für Stunden, die überhaupt Einträge haben (eine Abfrage statt je Stunde). */
async function moveHistory(tx: Db, pairs: readonly (readonly [string, string])[], fromYmd: string): Promise<void> {
  const to = new Map(pairs);
  for (const part of chunks([...to.keys()])) {
    const hit = await tx
      .selectDistinct({ lessonId: timetableSubstitutionChanges.lessonId })
      .from(timetableSubstitutionChanges)
      .where(and(inArray(timetableSubstitutionChanges.lessonId, part), gte(timetableSubstitutionChanges.date, fromYmd)));
    for (const { lessonId } of hit) if (lessonId) await moveChangeHistory(tx, lessonId, to.get(lessonId)!, fromYmd);
  }
}

// ---------------------------------------------------------------- Laden

const toTransfer = (r: Pick<TimetableLesson, "id" | "groupId" | "subjectId" | "teacherId" | "roomId" | "weekday" | "periodNr" | "week" | "couplingId" | "validFrom" | "validUntil" | "fixed" | "solverRunId"> & { originLessonId?: string | null }): TransferLesson => ({
  id: r.id,
  groupId: r.groupId,
  subjectId: r.subjectId,
  teacherId: r.teacherId,
  roomId: r.roomId,
  weekday: r.weekday,
  periodNr: r.periodNr,
  week: r.week,
  couplingId: r.couplingId,
  validFrom: r.validFrom,
  validUntil: r.validUntil,
  fixed: r.fixed,
  solverRunId: r.solverRunId,
  ...(r.originLessonId !== undefined ? { originLessonId: r.originLessonId } : {}),
});

interface Computed {
  version: TimetablePlanVersion;
  year: { id: string; startsOn: string; endsOn: string };
  from: string;
  live: TimetableLesson[];
  draft: TransferLesson[];
  plan: TransferPlan;
  refs: RefTransfer;
  gone: Set<string>;
  /** Änderungen für die Änderungsliste (sichtbare Änderungen, ohne Zeitraum/Kopplungs-id) */
  items: ChangeItem[];
}

/** Stunden des gültigen Plans, die ab dem Stichtag im Schuljahr gelten, Entwurfsstunden der Version und der Übertrag. */
async function compute(db: Db, v: TimetablePlanVersion, year: Computed["year"], from: string, newId?: () => string): Promise<Computed> {
  const live = await db
    .select()
    .from(timetableLessons)
    .where(and(lte(timetableLessons.validFrom, year.endsOn), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, from))))
    .orderBy(asc(timetableLessons.createdAt), asc(timetableLessons.id));
  const draftRows = await db
    .select()
    .from(timetableDraftLessons)
    .where(eq(timetableDraftLessons.versionId, v.id))
    .orderBy(asc(timetableDraftLessons.createdAt), asc(timetableDraftLessons.id));
  const liveT = live.map((l) => toTransfer(l));
  const draft = draftRows.map((d) => toTransfer(d));
  const plan = transferPlan({ live: liveT, draft, from, yearEnd: year.endsOn }, newId);
  const gone = new Set([...plan.ended.map((e) => e.id), ...plan.deleted]);
  const goneIds = [...gone];
  const subs: (typeof timetableSubstitutions.$inferSelect)[] = [];
  const mats: { id: string; lessonId: string; date: string }[] = [];
  const book: { id: string; lessonId: string | null; date: string }[] = [];
  for (const part of chunks(goneIds)) {
    subs.push(
      ...(await db
        .select()
        .from(timetableSubstitutions)
        .where(and(or(inArray(timetableSubstitutions.lessonId, part), inArray(timetableSubstitutions.mergeLessonId, part)), gte(timetableSubstitutions.date, from)))
        .orderBy(asc(timetableSubstitutions.date), asc(timetableSubstitutions.id))),
    );
    mats.push(
      ...(await db
        .select({ id: timetableAbsenceMaterials.id, lessonId: timetableAbsenceMaterials.lessonId, date: timetableAbsenceMaterials.date })
        .from(timetableAbsenceMaterials)
        .where(and(inArray(timetableAbsenceMaterials.lessonId, part), gte(timetableAbsenceMaterials.date, from)))
        .orderBy(asc(timetableAbsenceMaterials.date), asc(timetableAbsenceMaterials.id))),
    );
    book.push(
      ...(await db
        .select({ id: classbookEntries.id, lessonId: classbookEntries.lessonId, date: classbookEntries.date })
        .from(classbookEntries)
        .where(and(inArray(classbookEntries.lessonId, part), gte(classbookEntries.date, from)))
        .orderBy(asc(classbookEntries.date), asc(classbookEntries.id))),
    );
  }
  const uniqueSubs = [...new Map(subs.map((s) => [s.id, s])).values()];
  const keptLessons = new Map(live.filter((l) => !gone.has(l.id)).map((l) => [l.id, { periodNr: l.periodNr }]));
  const refs = transferRefs(
    { from, kept: plan.kept, successor: plan.successor, gone },
    keptLessons,
    {
      substitutions: uniqueSubs.map((s) => ({ id: s.id, lessonId: s.lessonId, date: s.date, kind: s.kind, targetPeriod: s.targetPeriod, mergeLessonId: s.mergeLessonId })),
      materials: mats,
      classbook: book.filter((b): b is { id: string; lessonId: string; date: string } => b.lessonId !== null),
    },
  );
  const diff = planDiff(liveT, draft.filter((d) => d.validUntil === null || d.validUntil >= from));
  const items = diff.entries.filter((e): e is ChangeItem => e.kind !== "unchanged");
  return { version: v, year, from, live, draft, plan, refs, gone, items };
}

async function yearOf(db: Db, v: TimetablePlanVersion) {
  const [y] = await db.select({ id: schoolYears.id, startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.id, v.schoolYearId));
  if (!y) throw new ValidationError({ version: "Das Schuljahr der Version gibt es nicht mehr" });
  return y;
}

/** Die gültige Version des Schuljahrs (außer `exceptId`). */
async function currentValid(db: Db, schoolYearId: string, exceptId?: string): Promise<TimetablePlanVersion | null> {
  const [v] = await db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), eq(timetablePlanVersions.status, "gueltig"), exceptId ? ne(timetablePlanVersions.id, exceptId) : undefined));
  return v ?? null;
}

/** Varianten derselben Nummer (offene Entwürfe), die beim Veröffentlichen verworfen werden, und übrige offene Entwürfe des Schuljahrs. */
async function otherDrafts(db: Db, v: TimetablePlanVersion): Promise<{ variants: TimetablePlanVersion[]; others: TimetablePlanVersion[] }> {
  const rows = await db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, v.schoolYearId), inArray(timetablePlanVersions.status, [...OPEN_STATUSES]), ne(timetablePlanVersions.id, v.id)))
    .orderBy(asc(timetablePlanVersions.createdAt), asc(timetablePlanVersions.id));
  const same = (o: TimetablePlanVersion) => o.major === v.major && o.minor === v.minor;
  return { variants: rows.filter(same), others: rows.filter((o) => !same(o)) };
}

/**
 * Prüfungen vor dem Veröffentlichen (wie die Übernahme eines Solver-Laufs, §2.3): Status `freigegeben`, Stichtag ein Schultag nach heute im
 * Schuljahr, frühestens am vorgemerkten Stichtag des Entwurfs und nach dem Beginn der gültigen Version (nur eine Version gilt je Tag – die
 * Vorgängerin behält einen Zeitraum von mindestens einem Tag).
 */
async function checkPublish(db: Db, v: TimetablePlanVersion, from: string, today: string) {
  if (v.status !== "freigegeben")
    throw new ValidationError({
      version:
        v.status === "gueltig" || v.status === "archiviert"
          ? `Version ${versionNumber(v)} ist schon veröffentlicht`
          : `Nur freigegebene Versionen lassen sich veröffentlichen – Version ${versionNumber(v)} ist ${v.status === "entwurf" ? "ein Entwurf" : v.status === "pruefung" ? "in Prüfung" : "verworfen"}`,
    });
  const year = await yearOf(db, v);
  if (!isCalendarDate(from)) throw new ValidationError({ validFrom: "Stichtag wählen" });
  await checkValidFrom(db, year, from, today);
  if (v.validFrom && from < v.validFrom) throw new ValidationError({ validFrom: `Der Entwurf ist ab ${fmt(v.validFrom)} geplant – frühestens ab diesem Tag veröffentlichen` });
  const prev = await currentValid(db, v.schoolYearId, v.id);
  if (prev?.validFrom && from <= prev.validFrom)
    throw new ValidationError({ validFrom: `Version ${versionNumber(prev)} gilt ab ${fmt(prev.validFrom)} – eine neue Version frühestens ab dem Tag danach (je Tag gilt genau eine Version)` });
  return { year, prev };
}

// ---------------------------------------------------------------- Vorschau

export interface PublishPreview {
  from: string;
  versionLabel: string;
  /** Paare unverändert/geändert, neu, entfällt (wie im Diff, mit Zeitraum und Kopplung als Einheit) */
  counts: Record<DiffKind, number>;
  /** davon nur im Zeitraum bzw. nur wegen eines geänderten Kopplungsteils geändert */
  changedTiming: number;
  changedWithCoupling: number;
  /** Stunden des gültigen Plans, die am Vortag enden bzw. ganz entfallen (begannen ab dem Stichtag), neue Zeilen */
  ended: number;
  deleted: number;
  created: number;
  substitutions: { moved: number; removed: number };
  materials: { moved: number; removed: number };
  classbook: { moved: number; detached: number };
  /** Raumbuchungen/Klausuren ab dem Stichtag in Räumen, die neue Stunden zu dieser Zeit belegen */
  roomClashes: { bookings: number; exams: number };
  /** Vorgängerversion (wird archiviert) */
  previous: { label: string; name: string; validFrom: string | null } | null;
  /** Varianten derselben Nummer (werden verworfen) und übrige offene Entwürfe (bleiben stehen) */
  variants: { label: string; name: string }[];
  otherDrafts: number;
  /** Empfänger der Änderungsliste: Lehrkräfte sofort, Klassen/Kurse zur Vortags-Uhrzeit */
  teachers: number;
  groups: number;
  /** Zahl der sichtbaren Änderungen (Änderungsliste) */
  changes: number;
}

/** Vorschau der Veröffentlichung ab `from` – Zahlen vor dem Klick (`ok: false` mit Grund, wenn die Version so nicht veröffentlichbar ist). */
export async function publishPreview(db: Db, versionId: string, from: string, today: string): Promise<{ ok: true; preview: PublishPreview } | { ok: false; problem: string }> {
  const v = await getVersion(db, versionId);
  if (!v) return { ok: false, problem: "Die Version gibt es nicht (mehr)." };
  let checked: Awaited<ReturnType<typeof checkPublish>>;
  try {
    checked = await checkPublish(db, v, from, today);
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, problem: Object.values(err.fieldErrors)[0] ?? "Nicht veröffentlichbar" };
    throw err;
  }
  const c = await compute(db, v, checked.year, from);
  const { variants, others } = await otherDrafts(db, v);
  const lists = changeLists(c.items, { groups: new Map(), subjects: new Map(), teachers: new Map() });
  return {
    ok: true,
    preview: {
      from,
      versionLabel: versionNumber(v),
      counts: c.plan.counts,
      changedTiming: c.plan.changedTiming,
      changedWithCoupling: c.plan.changedWithCoupling,
      ended: c.plan.ended.length,
      deleted: c.plan.deleted.length,
      created: c.plan.created.length,
      substitutions: { moved: c.refs.substitutionMoves.length, removed: c.refs.substitutionsRemoved.length },
      materials: { moved: c.refs.materialMoves.length, removed: c.refs.materialsRemoved.length },
      classbook: { moved: c.refs.classbookMoves.length, detached: c.refs.classbookDetached.length },
      roomClashes: await roomClashes(db, c.plan.created, from),
      previous: checked.prev ? { label: versionNumber(checked.prev), name: checked.prev.name, validFrom: checked.prev.validFrom } : null,
      variants: variants.map((x) => ({ label: versionNumber(x), name: x.name })),
      otherDrafts: others.length,
      teachers: lists.byTeacher.size,
      groups: lists.byGroup.size,
      changes: c.items.length,
    },
  };
}

// ---------------------------------------------------------------- Änderungsliste

async function changeNames(db: Db): Promise<ChangeNames> {
  const [g, s, t] = await Promise.all([
    db.select({ id: groups.id, name: groups.name }).from(groups),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")),
  ]);
  return {
    groups: new Map(g.map((x) => [x.id, x.name])),
    subjects: new Map(s.map((x) => [x.id, x.name])),
    teachers: new Map(t.map((x) => [x.id, x.code?.trim() || x.name])),
  };
}

const planHref = (from: string) => `/stundenplan?woche=${from}`;

/** Änderungsliste an Schüler:innen und Eltern einer Version (zur geplanten Zeit). Gibt die Zahl der Nachrichten zurück. */
async function sendStudentList(db: Db, v: Pick<TimetablePlanVersion, "id" | "major" | "minor" | "validFrom">, notify: { groups: Record<string, string[]> }): Promise<number> {
  const groupIds = Object.keys(notify.groups);
  if (!groupIds.length || !v.validFrom) return 0;
  const members = await db
    .select({ u: groupMembers.userId, g: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, groupIds), eq(groupMembers.role, "member"), eq(users.role, "schueler")));
  const groupsOf = new Map<string, Set<string>>();
  for (const m of members) groupsOf.set(m.u, (groupsOf.get(m.u) ?? new Set()).add(m.g));
  const linesOf = (gs: Iterable<string>) => [...new Set([...gs].flatMap((g) => notify.groups[g] ?? []))];
  const items = new Map<string, string[]>();
  for (const [u, gs] of groupsOf) items.set(u, linesOf(gs));
  // Eltern nach Moduleinstellung (wie bei Vertretungen) – alle betroffenen Kinder in einer Nachricht
  for (const [p, kids] of await informedParents(db, [...groupsOf.keys()])) {
    if (items.has(p)) continue;
    items.set(p, linesOf([...kids].flatMap((k) => [...(groupsOf.get(k) ?? [])])));
  }
  const label = shortDayFmt.format(fromBerlinLocal(v.validFrom));
  const list = [...items].filter(([, lines]) => lines.length > 0).map(([userId, lines]) => ({ userId, ...planMessage(label, versionNumber(v), lines), href: planHref(v.validFrom!) }));
  if (!list.length) return 0;
  return notifyBundled(db, list, { moduleId: "stundenplan", bundleKey: planBundleKey(v.id) });
}

/**
 * Minutentakt (Job „vertretung-gong“): fällige Änderungslisten an Schüler:innen/Eltern veröffentlichter Versionen senden – genau einmal
 * (der Eintrag wird unter der Zeilensperre beansprucht), danach wird die Liste geleert.
 */
export async function runPlanNotifications(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: timetablePlanVersions.id })
    .from(timetablePlanVersions)
    .where(and(isNotNull(timetablePlanVersions.notify), isNull(timetablePlanVersions.notifiedAt), lte(timetablePlanVersions.notifyAt, now)))
    .orderBy(asc(timetablePlanVersions.notifyAt));
  let sent = 0;
  for (const { id } of due)
    sent += await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const [claimed] = await tx
        .update(timetablePlanVersions)
        .set({ notifiedAt: now })
        .where(and(eq(timetablePlanVersions.id, id), isNull(timetablePlanVersions.notifiedAt), isNotNull(timetablePlanVersions.notify), inArray(timetablePlanVersions.status, ["gueltig", "archiviert"])))
        .returning();
      if (!claimed) return 0;
      const n = await sendStudentList(tx, claimed, claimed.notify as { groups: Record<string, string[]> });
      await tx.update(timetablePlanVersions).set({ notify: null }).where(eq(timetablePlanVersions.id, id));
      return n;
    });
  return sent;
}

/** Nach einer Änderung der Sendezeiten: offene Änderungslisten neu planen (wie die Warteschlange der Vertretungen). */
export async function reschedulePlanNotifications(db: Db): Promise<number> {
  const windows = await readSendWindows(db);
  const rows = await db
    .select({ id: timetablePlanVersions.id, validFrom: timetablePlanVersions.validFrom, publishedAt: timetablePlanVersions.publishedAt, notifyAt: timetablePlanVersions.notifyAt })
    .from(timetablePlanVersions)
    .where(and(isNotNull(timetablePlanVersions.notify), isNull(timetablePlanVersions.notifiedAt)));
  let changed = 0;
  for (const r of rows) {
    if (!r.validFrom || !r.publishedAt) continue;
    const due = plannedSendAt(r.validFrom, r.publishedAt, windows.lernende);
    if (r.notifyAt && due.getTime() === r.notifyAt.getTime()) continue;
    await db.update(timetablePlanVersions).set({ notifyAt: due }).where(eq(timetablePlanVersions.id, r.id));
    changed++;
  }
  return changed;
}

// ---------------------------------------------------------------- Veröffentlichen

export interface PublishResult {
  from: string;
  versionLabel: string;
  counts: Record<DiffKind, number>;
  ended: number;
  deleted: number;
  created: number;
  substitutions: { moved: number; removed: number };
  materials: { moved: number; removed: number };
  classbook: { moved: number; detached: number };
  /** Lehrkräfte, die die Änderungsliste sofort bekommen haben */
  notifiedTeachers: number;
  /** Klassen/Kurse, deren Schüler:innen/Eltern sie zur geplanten Zeit bekommen */
  notifyGroups: number;
  notifyAt: Date | null;
  previous: string | null;
  discardedVariants: number;
}

const lockYear = (tx: Db, yearId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stundenplan:publish:${yearId}`}))`);

/**
 * Veröffentlicht eine freigegebene Version ab `from` (§2.3) in **einer** Transaktion: Diff gegen den gültigen Plan (`transferPlan`),
 * Übertrag von Vertretungen/Material/Klassenbuch (`transferRefs`), neue Stunden mit Herkunft (`plan_version_id`, Solver-Lauf aus dem Entwurf),
 * Vorgängerversion archiviert (endet am Vortag), Varianten derselben Nummer verworfen, Nummer bei Bedarf neu vergeben, Rücknahme-Daten.
 * Änderungsliste: Lehrkräfte sofort (gebündelter Gong `stundenplan:plan:<Version>`), Schüler:innen/Eltern zur Vortags-Uhrzeit (Einstellung
 * „Lernende“). Audit `stundenplan.plan.publish` mit Zahlen.
 */
export async function publishVersion(db: Db, actorId: string, versionId: string, from: string, today: string, now: Date = new Date()): Promise<PublishResult> {
  const v0 = await getVersion(db, versionId);
  if (!v0) throw new ValidationError({ version: "Version nicht gefunden" });
  await checkPublish(db, v0, from, today);
  const windows = await readSendWindows(db);
  const names = await changeNames(db);

  const out = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await lockYear(tx, v0.schoolYearId);
    // unter der Sperre neu lesen und prüfen (gleichzeitige Klicks: einer gewinnt)
    const v = (await getVersion(tx, versionId))!;
    const { year, prev } = await checkPublish(tx, v, from, today);
    const c = await compute(tx, v, year, from);
    const dayBefore = addDays(from, -1);

    // 1. neue Stunden
    const created = c.plan.created;
    for (const part of chunks(created))
      await tx.insert(timetableLessons).values(
        part.map((l) => ({
          id: l.id,
          groupId: l.groupId,
          weekday: l.weekday,
          periodNr: l.periodNr,
          subjectId: l.subjectId,
          teacherId: l.teacherId,
          roomId: l.roomId,
          week: l.week,
          validFrom: l.validFrom,
          validUntil: l.validUntil,
          couplingId: l.couplingId,
          fixed: l.fixed,
          solverRunId: l.solverRunId,
          planVersionId: v.id,
        })),
      );

    // 2. Übertrag ab dem Stichtag: umziehen …
    const moved: PublishUndo["moved"] = [];
    for (const m of c.refs.substitutionMoves) {
      await tx
        .update(timetableSubstitutions)
        .set({ ...(m.lessonId ? { lessonId: m.lessonId.to } : {}), ...(m.mergeLessonId ? { mergeLessonId: m.mergeLessonId.to } : {}) })
        .where(eq(timetableSubstitutions.id, m.id));
      if (m.lessonId) moved.push({ kind: "substitution", id: m.id, ...m.lessonId });
      if (m.mergeLessonId) moved.push({ kind: "merge", id: m.id, ...m.mergeLessonId });
    }
    for (const m of c.refs.materialMoves) {
      await tx.update(timetableAbsenceMaterials).set({ lessonId: m.to }).where(eq(timetableAbsenceMaterials.id, m.id));
      moved.push({ kind: "material", ...m });
    }
    for (const m of c.refs.classbookMoves) {
      await tx.update(classbookEntries).set({ lessonId: m.to }).where(eq(classbookEntries.id, m.id));
      moved.push({ kind: "classbook", ...m });
    }
    // VT-01: die Historie zieht mit (je Stunde ab dem Stichtag)
    await moveHistory(tx, [...c.plan.successor].map(([fromId, succ]) => [fromId, succ.id] as const), from);

    // … sonst sichern und löschen (Vertretung, Material) bzw. vom Bezug lösen (Klassenbuch)
    const removedSubs: UndoSubstitution[] = [];
    for (const part of chunks(c.refs.substitutionsRemoved)) {
      const gone = await tx.delete(timetableSubstitutions).where(inArray(timetableSubstitutions.id, part)).returning();
      await recordSubstitutionChanges(tx, actorId, deletedEntries(gone, "plan_publish"));
      for (const s of gone)
        removedSubs.push({
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
    const removedMaterials: PublishUndoMaterial[] = [];
    for (const part of chunks(c.refs.materialsRemoved))
      for (const m of await tx.delete(timetableAbsenceMaterials).where(inArray(timetableAbsenceMaterials.id, part)).returning())
        removedMaterials.push({
          id: m.id,
          absenceId: m.absenceId,
          lessonId: m.lessonId,
          date: m.date,
          text: m.text,
          fileKey: m.fileKey,
          fileName: m.fileName,
          fileMime: m.fileMime,
          fileSize: m.fileSize,
          forStudents: m.forStudents,
          createdBy: m.createdBy,
          createdAt: m.createdAt.toISOString(),
        });
    for (const part of chunks(c.refs.classbookDetached.map((d) => d.id))) await tx.update(classbookEntries).set({ lessonId: null }).where(inArray(classbookEntries.id, part));

    // 3. geänderte/entfallende Stunden enden am Vortag bzw. werden gelöscht (sie begannen erst ab dem Stichtag)
    for (const part of chunks(c.plan.ended.map((e) => e.id))) await tx.update(timetableLessons).set({ validUntil: dayBefore }).where(inArray(timetableLessons.id, part));
    const deletedIds = new Set(c.plan.deleted);
    const deletedRows = c.live.filter((l) => deletedIds.has(l.id));
    for (const part of chunks(c.plan.deleted)) await tx.delete(timetableLessons).where(inArray(timetableLessons.id, part));

    // 4. Versionen: Vorgängerin archiviert, Varianten derselben Nummer verworfen, Nummer frei?
    if (prev) await tx.update(timetablePlanVersions).set({ status: "archiviert", validUntil: dayBefore }).where(eq(timetablePlanVersions.id, prev.id));
    const { variants } = await otherDrafts(tx, v);
    for (const x of variants) await tx.update(timetablePlanVersions).set({ status: "verworfen", discardedBy: actorId, discardedAt: now }).where(eq(timetablePlanVersions.id, x.id));
    let number: { major: number; minor: number } = { major: v.major, minor: v.minor };
    const taken = await tx
      .select({ major: timetablePlanVersions.major, minor: timetablePlanVersions.minor })
      .from(timetablePlanVersions)
      .where(and(eq(timetablePlanVersions.schoolYearId, v.schoolYearId), inArray(timetablePlanVersions.status, ["gueltig", "archiviert"]), ne(timetablePlanVersions.id, v.id)));
    if (taken.some((t) => t.major === v.major && t.minor === v.minor))
      number =
        v.minor > 0 && prev
          ? { major: prev.major, minor: Math.max(...taken.filter((t) => t.major === prev.major).map((t) => t.minor)) + 1 }
          : { major: Math.max(...taken.map((t) => t.major)) + 1, minor: 0 };

    // 5. Änderungsliste je Person
    const lists = changeLists(c.items, names);
    const label = shortDayFmt.format(fromBerlinLocal(from));
    const vLabel = versionNumber(number);
    const teacherItems = [...lists.byTeacher]
      .filter(([id]) => id !== actorId)
      .map(([userId, lines]) => ({ userId, ...planMessage(label, vLabel, lines), href: planHref(from) }));
    const knownTeachers = new Set(
      teacherItems.length ? (await tx.select({ id: users.id }).from(users).where(inArray(users.id, teacherItems.map((t) => t.userId)))).map((u) => u.id) : [],
    );
    const notifiedTeachers = await notifyBundled(
      tx,
      teacherItems.filter((t) => knownTeachers.has(t.userId)),
      { moduleId: "stundenplan", bundleKey: planBundleKey(v.id) },
    );
    const notify = lists.byGroup.size ? { groups: Object.fromEntries(lists.byGroup) } : null;
    const notifyAt = notify ? plannedSendAt(from, now, windows.lernende) : null;

    const undo: PublishUndo = {
      from,
      draftValidFrom: v.validFrom,
      ...(number.major !== v.major || number.minor !== v.minor ? { number: { major: v.major, minor: v.minor } } : {}),
      previous: prev ? { id: prev.id, validUntil: prev.validUntil } : null,
      discarded: variants.map((x) => ({ id: x.id, status: x.status })),
      kept: c.plan.kept.length,
      ended: c.plan.ended,
      deleted: deletedRows.map(({ id, groupId, weekday, periodNr, subjectId, teacherId, roomId, week, validFrom, validUntil, couplingId, fixed, solverRunId, planVersionId }) => ({
        id,
        groupId,
        weekday,
        periodNr,
        subjectId,
        teacherId,
        roomId,
        week,
        validFrom,
        validUntil,
        couplingId,
        fixed,
        solverRunId,
        planVersionId,
      })),
      created: created.map((l) => ({ id: l.id, of: l.predecessorId, key: lessonKey(l) })),
      moved,
      substitutions: removedSubs,
      materials: removedMaterials,
      classbookDetached: c.refs.classbookDetached,
    };
    const [done] = await tx
      .update(timetablePlanVersions)
      .set({
        status: "gueltig",
        major: number.major,
        minor: number.minor,
        validFrom: from,
        validUntil: null,
        publishedBy: actorId,
        publishedAt: now,
        undo,
        notify,
        notifyAt,
        notifiedAt: null,
      })
      .where(and(eq(timetablePlanVersions.id, v.id), eq(timetablePlanVersions.status, "freigegeben")))
      .returning();
    if (!done) throw new ValidationError({ version: "Die Version wurde inzwischen geändert – Seite neu laden" });
    // fällig? (Veröffentlichen erst nach der Vortags-Uhrzeit des Vortags → sofort)
    if (notify && notifyAt && notifyAt.getTime() <= now.getTime()) {
      await sendStudentList(tx, done, notify);
      await tx.update(timetablePlanVersions).set({ notify: null, notifiedAt: now }).where(eq(timetablePlanVersions.id, v.id));
    }
    const result: PublishResult = {
      from,
      versionLabel: vLabel,
      counts: c.plan.counts,
      ended: c.plan.ended.length,
      deleted: c.plan.deleted.length,
      created: created.length,
      substitutions: { moved: c.refs.substitutionMoves.length, removed: removedSubs.length },
      materials: { moved: c.refs.materialMoves.length, removed: removedMaterials.length },
      classbook: { moved: c.refs.classbookMoves.length, detached: c.refs.classbookDetached.length },
      notifiedTeachers,
      notifyGroups: lists.byGroup.size,
      notifyAt,
      previous: prev ? versionNumber(prev) : null,
      discardedVariants: variants.length,
    };
    return result;
  });
  await audit(db, actorId, "stundenplan.plan.publish", versionId, {
    version: out.versionLabel,
    from,
    ...out.counts,
    ended: out.ended,
    deleted: out.deleted,
    created: out.created,
    substitutionsMoved: out.substitutions.moved,
    substitutionsRemoved: out.substitutions.removed,
    materialsMoved: out.materials.moved,
    materialsRemoved: out.materials.removed,
    classbookMoved: out.classbook.moved,
    classbookDetached: out.classbook.detached,
    teachers: out.notifiedTeachers,
    groups: out.notifyGroups,
    previous: out.previous,
    discardedVariants: out.discardedVariants,
  });
  return out;
}

// ---------------------------------------------------------------- Zurücknehmen

/** Ist die Veröffentlichung noch zurücknehmbar? Nur die gültige Version, mit Rücknahme-Daten, vor ihrem Stichtag. */
export function isPublishUndoable(v: Pick<TimetablePlanVersion, "status" | "validFrom" | "undo">, today: string): boolean {
  return v.status === "gueltig" && v.undo !== null && v.validFrom !== null && v.validFrom > today;
}

/** Was „Veröffentlichung zurücknehmen“ tun würde bzw. getan hat – mit den Konfliktfällen (wie beim Zurücknehmen einer Solver-Übernahme). */
export interface UndoPublishPreview {
  /** neue Stunden der Version, die entfernt werden */
  lessons: number;
  /** davon seit dem Veröffentlichen von Hand verändert (verschoben, andere Lehrkraft/anderer Raum) – sie werden trotzdem entfernt */
  changed: number;
  /** Vertretungen/Material/Klassenbuch an neuen Stunden, die zurück an die bisherige Stunde ziehen */
  substitutionsBack: number;
  materialsBack: number;
  classbookBack: number;
  /** … die keine bisherige Stunde haben (neue Stunden ohne Vorgängerin bzw. die findet an dem Tag nicht statt): gehen verloren bzw. verlieren den Bezug */
  substitutionsLost: number;
  materialsLost: number;
  classbookLost: number;
  /** beendete Stunden, die wieder bis zu ihrem früheren Ende gelten / die sich nicht wiederherstellen lassen (inzwischen gelöscht oder verändert) */
  restorable: number;
  notRestorable: number;
  /** gelöschte Stunden, die wieder angelegt werden / die entfallen (Gruppe oder Fach inzwischen gelöscht) */
  reinsert: number;
  reinsertSkipped: number;
  /** Stunden ab dem Stichtag, die nach dem Veröffentlichen von Hand angelegt wurden – bleiben; Kollisionen prüfen */
  foreign: number;
  /** beim Veröffentlichen gelöschte Vertretungen/Material, die zurückkommen bzw. nicht (Stunde gilt an dem Tag nicht mehr) */
  restoredSubstitutions: number;
  lostSubstitutions: number;
  restoredMaterials: number;
  lostMaterials: number;
  /** Klassenbuch-Einträge, die ihren Bezug zurückbekommen */
  reattachedClassbook: number;
  /** Raumbuchungen/Klausuren ab dem Stichtag in Räumen, die der alte Plan zu dieser Zeit belegt */
  roomClashes: { bookings: number; exams: number };
}

type Slot = Pick<TimetableLesson, "weekday" | "week" | "validFrom" | "validUntil">;

/** Stand für das Zurücknehmen – gemeinsam für Vorschau und Rücknahme. */
async function undoState(db: Db, v: TimetablePlanVersion) {
  const undo = v.undo as PublishUndo;
  const from = undo.from;
  const dayBefore = addDays(from, -1);
  const createdIds = undo.created.map((c) => c.id);
  const own: TimetableLesson[] = [];
  for (const part of chunks(createdIds)) own.push(...(await db.select().from(timetableLessons).where(inArray(timetableLessons.id, part))));
  const keyOf = new Map(undo.created.map((c) => [c.id, c.key]));
  const changed = own.filter((l) => lessonKey(l) !== keyOf.get(l.id)).length;
  const endedRows = new Map<string, TimetableLesson>();
  for (const part of chunks(undo.ended.map((e) => e.id))) for (const l of await db.select().from(timetableLessons).where(inArray(timetableLessons.id, part))) endedRows.set(l.id, l);
  const restorable = undo.ended.filter((e) => endedRows.get(e.id)?.validUntil === dayBefore);
  const [groupRows, subjectRows, userRows, roomRows, versionRows] = await Promise.all([
    db.select({ id: groups.id }).from(groups),
    db.select({ id: subjects.id }).from(subjects),
    db.select({ id: users.id }).from(users),
    db.select({ id: rooms.id }).from(rooms),
    db.select({ id: timetablePlanVersions.id }).from(timetablePlanVersions),
  ]);
  const has = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
  const groupIds = has(groupRows);
  const subjectIds = has(subjectRows);
  const userIds = has(userRows);
  const roomIds = has(roomRows);
  const existingLessons = new Set<string>();
  for (const part of chunks(undo.deleted.map((l) => l.id))) for (const l of await db.select({ id: timetableLessons.id }).from(timetableLessons).where(inArray(timetableLessons.id, part))) existingLessons.add(l.id);
  const reinsert = undo.deleted
    .filter((l) => groupIds.has(l.groupId) && subjectIds.has(l.subjectId) && !existingLessons.has(l.id))
    .map((l) => ({
      ...l,
      teacherId: l.teacherId && userIds.has(l.teacherId) ? l.teacherId : null,
      roomId: l.roomId && roomIds.has(l.roomId) ? l.roomId : null,
      planVersionId: l.planVersionId && has(versionRows).has(l.planVersionId) ? l.planVersionId : null,
    }));
  // Gültigkeit der bisherigen Stunden nach dem Zurücknehmen
  const after = new Map<string, Slot>();
  for (const [id, l] of endedRows) after.set(id, { weekday: l.weekday, week: l.week, validFrom: l.validFrom, validUntil: l.validUntil });
  for (const e of restorable) after.set(e.id, { ...after.get(e.id)!, validUntil: e.validUntil });
  for (const l of reinsert) after.set(l.id, { weekday: l.weekday, week: l.week, validFrom: l.validFrom, validUntil: l.validUntil });
  const holdsAfter = (id: string | null, date: string) => {
    const s = id ? after.get(id) : undefined;
    return s !== undefined && holdsOn(s, date);
  };
  // Verweise an den neuen Stunden ab dem Stichtag: zurück an die Vorgängerin, wenn sie an dem Tag (wieder) stattfindet
  const ofCreated = new Map(undo.created.map((c) => [c.id, c.of]));
  const refsOn = async () => {
    const subs: { id: string; lessonId: string; mergeLessonId: string | null; date: string }[] = [];
    const mats: { id: string; lessonId: string; date: string }[] = [];
    const book: { id: string; lessonId: string; date: string }[] = [];
    for (const part of chunks(own.map((l) => l.id))) {
      subs.push(
        ...(await db
          .select({ id: timetableSubstitutions.id, lessonId: timetableSubstitutions.lessonId, mergeLessonId: timetableSubstitutions.mergeLessonId, date: timetableSubstitutions.date })
          .from(timetableSubstitutions)
          .where(or(inArray(timetableSubstitutions.lessonId, part), inArray(timetableSubstitutions.mergeLessonId, part)))),
      );
      mats.push(...(await db.select({ id: timetableAbsenceMaterials.id, lessonId: timetableAbsenceMaterials.lessonId, date: timetableAbsenceMaterials.date }).from(timetableAbsenceMaterials).where(inArray(timetableAbsenceMaterials.lessonId, part))));
      book.push(
        ...(await db.select({ id: classbookEntries.id, lessonId: classbookEntries.lessonId, date: classbookEntries.date }).from(classbookEntries).where(inArray(classbookEntries.lessonId, part))).filter(
          (b): b is { id: string; lessonId: string; date: string } => b.lessonId !== null,
        ),
      );
    }
    return { subs: [...new Map(subs.map((s) => [s.id, s])).values()], mats, book };
  };
  const refs = await refsOn();
  const back = (lessonId: string, date: string) => {
    if (!ofCreated.has(lessonId)) return lessonId; // keine neue Stunde (z. B. aufnehmende Stunde unverändert)
    const of = ofCreated.get(lessonId) ?? null;
    return of && holdsAfter(of, date) ? of : null;
  };
  const subPlan = refs.subs.map((s) => ({ ...s, to: back(s.lessonId, s.date), mergeTo: s.mergeLessonId ? back(s.mergeLessonId, s.date) : null }));
  const subsBack = subPlan.filter((s) => s.to !== null && (!s.mergeLessonId || s.mergeTo !== null));
  const matPlan = refs.mats.map((m) => ({ ...m, to: back(m.lessonId, m.date) }));
  const bookPlan = refs.book.map((b) => ({ ...b, to: back(b.lessonId, b.date) }));
  const foreign = v.publishedAt
    ? await db.$count(
        timetableLessons,
        and(
          createdIds.length ? sql`${timetableLessons.id} not in (${sql.join(createdIds.map((id) => sql`${id}`), sql`, `)})` : undefined,
          sql`${timetableLessons.createdAt} > ${v.publishedAt.toISOString()}::timestamptz`,
          or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, from)),
        ),
      )
    : 0;
  // beim Veröffentlichen gelöschte Vertretungen/Material
  const validity = new Map<string, { validFrom: string; validUntil: string | null }>();
  for (const [id, s] of after) validity.set(id, { validFrom: s.validFrom, validUntil: s.validUntil });
  const lessonIdsOfSubs = [...new Set(undo.substitutions.flatMap((s) => (s.mergeLessonId ? [s.lessonId, s.mergeLessonId] : [s.lessonId])))].filter((id) => !validity.has(id));
  for (const part of chunks(lessonIdsOfSubs))
    for (const l of await db.select({ id: timetableLessons.id, validFrom: timetableLessons.validFrom, validUntil: timetableLessons.validUntil, weekday: timetableLessons.weekday, week: timetableLessons.week }).from(timetableLessons).where(inArray(timetableLessons.id, part))) {
      validity.set(l.id, { validFrom: l.validFrom, validUntil: l.validUntil });
      after.set(l.id, { weekday: l.weekday, week: l.week, validFrom: l.validFrom, validUntil: l.validUntil });
    }
  const subsToRestore = substitutionsToRestore(undo.substitutions, validity, { users: userIds, rooms: roomIds, subjects: subjectIds });
  const matsToRestore = undo.materials.filter((m) => holdsAfter(m.lessonId, m.date));
  const restoredSlots: Parameters<typeof roomClashes>[1] = [
    ...restorable.map((e) => ({ ...endedRows.get(e.id)!, validUntil: e.validUntil })),
    ...reinsert,
  ];
  return {
    undo,
    from,
    dayBefore,
    own,
    changed,
    restorable,
    reinsert,
    subPlan,
    subsBack,
    matPlan,
    bookPlan,
    foreign,
    subsToRestore,
    matsToRestore,
    userIds,
    roomClashes: await roomClashes(db, restoredSlots, from),
  };
}

function previewOf(s: Awaited<ReturnType<typeof undoState>>): UndoPublishPreview {
  return {
    lessons: s.own.length,
    changed: s.changed,
    substitutionsBack: s.subsBack.length,
    materialsBack: s.matPlan.filter((m) => m.to !== null).length,
    classbookBack: s.bookPlan.filter((b) => b.to !== null).length,
    substitutionsLost: s.subPlan.length - s.subsBack.length,
    materialsLost: s.matPlan.filter((m) => m.to === null).length,
    classbookLost: s.bookPlan.filter((b) => b.to === null).length,
    restorable: s.restorable.length,
    notRestorable: s.undo.ended.length - s.restorable.length,
    reinsert: s.reinsert.length,
    reinsertSkipped: s.undo.deleted.length - s.reinsert.length,
    foreign: s.foreign,
    restoredSubstitutions: s.subsToRestore.length,
    lostSubstitutions: s.undo.substitutions.length - s.subsToRestore.length,
    restoredMaterials: s.matsToRestore.length,
    lostMaterials: s.undo.materials.length - s.matsToRestore.length,
    reattachedClassbook: s.undo.classbookDetached.length,
    roomClashes: s.roomClashes,
  };
}

/** Vorschau für „Veröffentlichung zurücknehmen“ – `null`, wenn sie nicht (mehr) zurücknehmbar ist. */
export async function undoPublishPreview(db: Db, versionId: string, today: string): Promise<UndoPublishPreview | null> {
  const v = await getVersion(db, versionId);
  if (!v || !isPublishUndoable(v, today)) return null;
  return previewOf(await undoState(db, v));
}

/**
 * „Veröffentlichung zurücknehmen“, solange der Stichtag in der Zukunft liegt (§2.1): gelöschte Stunden kommen mit ihrer alten id wieder,
 * beendete gelten wieder bis zu ihrem früheren Ende (nur, wenn sie seitdem unverändert enden), Vertretungen/Material/Klassenbuch an den neuen
 * Stunden ziehen zurück an die bisherige Stunde (wenn sie an dem Tag stattfindet), die neuen Stunden werden entfernt (auch von Hand veränderte;
 * nach dem Veröffentlichen von Hand angelegte bleiben), beim Veröffentlichen gelöschte Vertretungen und Material kommen zurück (SP-13), gelöste
 * Klassenbuch-Einträge bekommen ihren Bezug zurück. Die Version ist danach wieder `freigegeben`, die Vorgängerin wieder `gueltig`, verworfene
 * Varianten wieder offen. Wer die Änderungsliste bekommen hat, bekommt die Rücknahme (gleicher Gong); eine noch nicht versandte entfällt.
 */
export async function undoPublish(db: Db, actorId: string, versionId: string, today: string): Promise<UndoPublishPreview> {
  const v0 = await getVersion(db, versionId);
  if (!v0) throw new ValidationError({ version: "Version nicht gefunden" });
  if (v0.status !== "gueltig") throw new ValidationError({ version: `Version ${versionNumber(v0)} ist nicht die gültige Version` });
  if (!v0.undo) throw new ValidationError({ version: "Zu dieser Veröffentlichung gibt es keine Rücknahme-Daten (Stichtag erreicht oder vor SP3-04 gültig)" });
  if (!isPublishUndoable(v0, today)) throw new ValidationError({ version: `Version ${versionNumber(v0)} gilt seit ${fmt(v0.validFrom!)} und lässt sich nicht mehr zurücknehmen` });

  const out = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await lockYear(tx, v0.schoolYearId);
    const v = (await getVersion(tx, versionId))!;
    if (!isPublishUndoable(v, today)) throw new ValidationError({ version: "Die Version wurde inzwischen geändert – Seite neu laden" });
    const s = await undoState(tx, v);
    const result = previewOf(s);

    // 1. gelöschte Stunden wieder anlegen (alte id), beendete wieder verlängern
    let reinserted = 0;
    for (const part of chunks(s.reinsert)) reinserted += (await tx.insert(timetableLessons).values(part).onConflictDoNothing().returning({ id: timetableLessons.id })).length;
    let restored = 0;
    for (const e of s.restorable)
      restored += (
        await tx
          .update(timetableLessons)
          .set({ validUntil: e.validUntil })
          .where(and(eq(timetableLessons.id, e.id), eq(timetableLessons.validUntil, s.dayBefore)))
          .returning({ id: timetableLessons.id })
      ).length;

    // 2. Verweise an den neuen Stunden zurück an die bisherige Stunde
    for (const sub of s.subsBack)
      await tx
        .update(timetableSubstitutions)
        .set({ lessonId: sub.to!, ...(sub.mergeLessonId ? { mergeLessonId: sub.mergeTo } : {}) })
        .where(eq(timetableSubstitutions.id, sub.id));
    for (const m of s.matPlan) if (m.to && m.to !== m.lessonId) await tx.update(timetableAbsenceMaterials).set({ lessonId: m.to }).where(eq(timetableAbsenceMaterials.id, m.id));
    for (const b of s.bookPlan) if (b.to && b.to !== b.lessonId) await tx.update(classbookEntries).set({ lessonId: b.to }).where(eq(classbookEntries.id, b.id));
    await moveHistory(tx, s.undo.created.flatMap((c) => (c.of ? [[c.id, c.of] as const] : [])), s.from);

    // 3. neue Stunden entfernen (verbliebene Vertretungen/Material per Cascade, in die Historie; Klassenbuch-Bezug wird leer)
    const ownIds = s.own.map((l) => l.id);
    await recordLessonCascade(tx, actorId, ownIds, "plan_undo");
    for (const part of chunks(ownIds)) await tx.delete(timetableLessons).where(inArray(timetableLessons.id, part));

    // 4. beim Veröffentlichen gelöschte Vertretungen und Material wieder anlegen, gelöste Klassenbuch-Einträge wieder zuordnen
    let restoredSubstitutions = 0;
    for (const part of chunks(s.subsToRestore)) {
      const back = await tx.insert(timetableSubstitutions).values(part).onConflictDoNothing().returning();
      restoredSubstitutions += back.length;
      await recordSubstitutionChanges(
        tx,
        actorId,
        back.map((r) => ({ action: "plan_undo" as const, date: r.date, lessonId: r.lessonId, substitutionId: r.id, before: null, after: snapshotOf(r) })),
      );
    }
    let restoredMaterials = 0;
    for (const part of chunks(s.matsToRestore))
      restoredMaterials += (
        await tx
          .insert(timetableAbsenceMaterials)
          .values(part.map((m) => ({ ...m, createdBy: m.createdBy && s.userIds.has(m.createdBy) ? m.createdBy : null, createdAt: new Date(m.createdAt) })))
          .onConflictDoNothing()
          .returning({ id: timetableAbsenceMaterials.id })
      ).length;
    let reattached = 0;
    for (const d of s.undo.classbookDetached)
      reattached += (
        await tx
          .update(classbookEntries)
          .set({ lessonId: d.lessonId })
          .where(and(eq(classbookEntries.id, d.id), isNull(classbookEntries.lessonId), sql`exists (select 1 from ${timetableLessons} where ${timetableLessons.id} = ${d.lessonId})`))
          .returning({ id: classbookEntries.id })
      ).length;

    // 5. Versionen zurück
    const [back] = await tx
      .update(timetablePlanVersions)
      .set({
        status: "freigegeben",
        validFrom: s.undo.draftValidFrom,
        validUntil: null,
        publishedBy: null,
        publishedAt: null,
        undo: null,
        notify: null,
        notifyAt: null,
        notifiedAt: null,
        ...(s.undo.number ? { major: s.undo.number.major, minor: s.undo.number.minor } : {}),
      })
      .where(and(eq(timetablePlanVersions.id, v.id), eq(timetablePlanVersions.status, "gueltig")))
      .returning();
    if (!back) throw new ValidationError({ version: "Die Version wurde inzwischen geändert – Seite neu laden" });
    if (s.undo.previous)
      await tx
        .update(timetablePlanVersions)
        .set({ status: "gueltig", validUntil: s.undo.previous.validUntil })
        .where(and(eq(timetablePlanVersions.id, s.undo.previous.id), eq(timetablePlanVersions.status, "archiviert")));
    for (const d of s.undo.discarded)
      await tx
        .update(timetablePlanVersions)
        .set({ status: d.status, discardedBy: null, discardedAt: null })
        .where(and(eq(timetablePlanVersions.id, d.id), eq(timetablePlanVersions.status, "verworfen")));

    // 6. wer die Änderungsliste bekommen hat, bekommt die Rücknahme (gleicher Gong)
    const got = await tx.select({ userId: notifications.userId }).from(notifications).where(eq(notifications.bundleKey, planBundleKey(v.id)));
    if (got.length) {
      const label = shortDayFmt.format(fromBerlinLocal(s.from));
      await notifyBundled(
        tx,
        got.map((g) => ({
          userId: g.userId,
          title: `Neuer Stundenplan ab ${label} zurückgenommen`,
          body: "Die Veröffentlichung ist zurückgenommen – es gilt weiter der bisherige Stundenplan.",
          href: planHref(s.from),
        })),
        { moduleId: "stundenplan", bundleKey: planBundleKey(v.id) },
      );
    }
    return {
      ...result,
      restorable: restored,
      notRestorable: s.undo.ended.length - restored,
      reinsert: reinserted,
      reinsertSkipped: s.undo.deleted.length - reinserted,
      restoredSubstitutions,
      lostSubstitutions: s.undo.substitutions.length - restoredSubstitutions,
      restoredMaterials,
      lostMaterials: s.undo.materials.length - restoredMaterials,
      reattachedClassbook: reattached,
    } satisfies UndoPublishPreview;
  });
  const { roomClashes: clashes, ...counts } = out;
  await audit(db, actorId, "stundenplan.plan.unpublish", versionId, { version: versionNumber(v0), from: v0.validFrom, ...counts, bookings: clashes.bookings, exams: clashes.exams });
  return out;
}
