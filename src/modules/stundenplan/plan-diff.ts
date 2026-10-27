// SP3-02 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.3, §2.5, R1): Diff-Engine – was ändert sich zwischen zwei Wochenplänen (Entwurf ↔ gültiger
// Plan, Version ↔ Version), je Lehrkraft und je Klasse/Kurs. `planDiff()` ist rein; der Lader holt beide Seiten als Wochenplan an ihrem
// Stichtag über die Planquelle. Paare entstehen über die Herkunft (`origin_lesson_id` bzw. dieselbe Stunde) und sonst über gleichen Inhalt.
// Das Veröffentlichen (SP3-04) nutzt dieselben Regeln für „unverändert/geändert/neu/entfallen“.
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groups, subjects, users } from "@/core/db/schema";
import { activeOnWhere, draftOrigins, lessonCols, type PlanSource } from "./plan-quelle";
import { getVersion, versionNumber, versionSource } from "./planversionen";
import { timetablePlanVersions, type TimetablePlanVersion } from "./schema";

/** Eine Stunde im Vergleich (gemeinsame Zeilenform beider Tabellen; `originLessonId` nur im Entwurf). */
export interface DiffLesson {
  id: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
  week: "all" | "A" | "B";
  couplingId: string | null;
  originLessonId?: string | null;
}

export type DiffKind = "unchanged" | "changed" | "added" | "removed";
/** Was sich an einer Stunde geändert hat (`slot` = Wochentag/Stunde). */
export type DiffField = "slot" | "subject" | "teacher" | "room" | "group" | "week" | "coupling";

export const DIFF_KIND_LABELS: Record<DiffKind, string> = { unchanged: "unverändert", changed: "geändert", added: "neu", removed: "entfällt" };
export const DIFF_FIELD_LABELS: Record<DiffField, string> = {
  slot: "Zeit",
  subject: "Fach",
  teacher: "Lehrkraft",
  room: "Raum",
  group: "Gruppe",
  week: "Woche",
  coupling: "Kopplung",
};

export interface DiffEntry {
  kind: DiffKind;
  /** Stunde vorher (fehlt bei „neu“) */
  before: DiffLesson | null;
  /** Stunde nachher (fehlt bei „entfällt“) */
  after: DiffLesson | null;
  /** nur bei „geändert“ */
  changes: DiffField[];
}

export interface PlanDiff {
  /** alle Paare und Einzelstunden, sortiert nach Tag/Stunde (nachher, sonst vorher) */
  entries: DiffEntry[];
  counts: Record<DiffKind, number>;
  /** Änderungen (ohne „unverändert“) je Lehrkraft – vorher und nachher beteiligte Lehrkräfte */
  byTeacher: Map<string, DiffEntry[]>;
  /** Änderungen je Klasse/Kurs */
  byGroup: Map<string, DiffEntry[]>;
}

const contentKey = (l: DiffLesson) => `${l.groupId}|${l.subjectId}|${l.teacherId ?? ""}|${l.roomId ?? ""}|${l.weekday}|${l.periodNr}|${l.week}`;
/** Kennungen, über die zwei Stunden zusammengehören: die Stunde selbst und ihre Herkunft im gültigen Plan. */
const linkKeys = (l: DiffLesson) => [l.id, ...(l.originLessonId ? [l.originLessonId] : [])];

/** Rein: Felder, in denen sich zwei Stunden unterscheiden (ohne Kopplung). */
export function changedFields(a: DiffLesson, b: DiffLesson): DiffField[] {
  const out: DiffField[] = [];
  if (a.weekday !== b.weekday || a.periodNr !== b.periodNr) out.push("slot");
  if (a.subjectId !== b.subjectId) out.push("subject");
  if (a.teacherId !== b.teacherId) out.push("teacher");
  if (a.roomId !== b.roomId) out.push("room");
  if (a.groupId !== b.groupId) out.push("group");
  if (a.week !== b.week) out.push("week");
  return out;
}

/**
 * Rein: Vergleich zweier Wochenpläne. Paare entstehen (1) über die Herkunft – eine Entwurfsstunde gehört zu der Stunde, aus der sie kam
 * (`origin_lesson_id`), zwei Entwurfsstunden derselben Herkunft gehören zusammen (Varianten) –, bevorzugt mit gleichem Inhalt; (2) für die
 * übrigen über gleichen Inhalt (Gruppe, Fach, Lehrkraft, Raum, Tag, Stunde, Woche). Ein Paar ist „unverändert“, wenn Inhalt und Kopplung
 * gleich sind (Kopplung = dieselben Partner, unabhängig von der Kopplungs-id), sonst „geändert“ mit den Feldern. Was übrig bleibt, ist
 * „entfällt“ (nur vorher) bzw. „neu“ (nur nachher). Gültigkeiten zählen nicht (beide Seiten sind Wochenpläne an ihrem Stichtag).
 */
export function planDiff(before: readonly DiffLesson[], after: readonly DiffLesson[]): PlanDiff {
  const pairOfBefore = new Map<number, number>();
  const pairOfAfter = new Map<number, number>();
  const pair = (i: number, j: number) => {
    pairOfBefore.set(i, j);
    pairOfAfter.set(j, i);
  };
  // (1) Herkunft
  const byLink = new Map<string, number[]>();
  before.forEach((a, i) => {
    for (const k of linkKeys(a)) byLink.set(k, [...(byLink.get(k) ?? []), i]);
  });
  after.forEach((b, j) => {
    const candidates = [...new Set(linkKeys(b).flatMap((k) => byLink.get(k) ?? []))].filter((i) => !pairOfBefore.has(i)).sort((x, y) => x - y);
    if (!candidates.length) return;
    const same = candidates.find((i) => contentKey(before[i]!) === contentKey(b));
    pair(same ?? candidates[0]!, j);
  });
  // (2) gleicher Inhalt
  const byContent = new Map<string, number[]>();
  before.forEach((a, i) => {
    if (pairOfBefore.has(i)) return;
    const k = contentKey(a);
    byContent.set(k, [...(byContent.get(k) ?? []), i]);
  });
  after.forEach((b, j) => {
    if (pairOfAfter.has(j)) return;
    const i = byContent.get(contentKey(b))?.find((x) => !pairOfBefore.has(x));
    if (i !== undefined) pair(i, j);
  });

  // Kopplung gleich = dieselben Partner (über die Paare abgebildet)
  const partners = (list: readonly DiffLesson[], idx: number) => {
    const c = list[idx]!.couplingId;
    return c === null ? [] : list.flatMap((l, k) => (k !== idx && l.couplingId === c ? [k] : []));
  };
  const sameCoupling = (i: number, j: number) => {
    const pa = partners(before, i).map((k) => pairOfBefore.get(k) ?? -1 - k);
    const pb = partners(after, j);
    return pa.length === pb.length && pa.every((x) => pb.includes(x));
  };

  const entries: DiffEntry[] = [];
  for (const [i, j] of pairOfBefore) {
    const changes = changedFields(before[i]!, after[j]!);
    if (!sameCoupling(i, j)) changes.push("coupling");
    entries.push({ kind: changes.length ? "changed" : "unchanged", before: before[i]!, after: after[j]!, changes });
  }
  before.forEach((a, i) => {
    if (!pairOfBefore.has(i)) entries.push({ kind: "removed", before: a, after: null, changes: [] });
  });
  after.forEach((b, j) => {
    if (!pairOfAfter.has(j)) entries.push({ kind: "added", before: null, after: b, changes: [] });
  });
  const at = (e: DiffEntry) => (e.after ?? e.before)!;
  const order: Record<DiffKind, number> = { removed: 0, changed: 1, added: 2, unchanged: 3 };
  entries.sort((x, y) => at(x).weekday - at(y).weekday || at(x).periodNr - at(y).periodNr || order[x.kind] - order[y.kind] || at(x).groupId.localeCompare(at(y).groupId) || at(x).id.localeCompare(at(y).id));

  const counts: Record<DiffKind, number> = { unchanged: 0, changed: 0, added: 0, removed: 0 };
  const byTeacher = new Map<string, DiffEntry[]>();
  const byGroup = new Map<string, DiffEntry[]>();
  const add = (m: Map<string, DiffEntry[]>, k: string | null | undefined, e: DiffEntry) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.includes(e)) list.push(e);
    m.set(k, list);
  };
  for (const e of entries) {
    counts[e.kind]++;
    if (e.kind === "unchanged") continue;
    add(byTeacher, e.before?.teacherId, e);
    add(byTeacher, e.after?.teacherId, e);
    add(byGroup, e.before?.groupId, e);
    add(byGroup, e.after?.groupId, e);
  }
  return { entries, counts, byTeacher, byGroup };
}

// ---------------------------------------------------------------- Lader

/** Eine Seite des Vergleichs: Quelle und der Tag, an dem ihr Wochenplan gilt. */
export interface DiffSide {
  source: PlanSource;
  refYmd: string;
  /** Beschriftung („Gültiger Plan“, „Entwurf 2.0 „Ab 01.02.2027““) */
  label: string;
}

/** Wochenplan einer Seite am Stichtag (Entwurf: mit Herkunft). */
export async function diffLessons(db: Db, side: Pick<DiffSide, "source" | "refYmd">): Promise<DiffLesson[]> {
  const t = lessonCols(side.source);
  const rows = await db
    .select({
      id: t.id,
      groupId: t.groupId,
      subjectId: t.subjectId,
      teacherId: t.teacherId,
      roomId: t.roomId,
      weekday: t.weekday,
      periodNr: t.periodNr,
      week: t.week,
      couplingId: t.couplingId,
    })
    .from(t)
    .where(activeOnWhere(side.source, side.refYmd))
    .orderBy(asc(t.weekday), asc(t.periodNr), asc(t.id));
  if (side.source.kind !== "draft" || !rows.length) return rows;
  const origins = await draftOrigins(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, originLessonId: origins.get(r.id) ?? null }));
}

/** Namen für die Anzeige des Vergleichs. */
export interface DiffNames {
  groups: Map<string, { name: string; kind: string }>;
  subjects: Map<string, string>;
  teachers: Map<string, { code: string | null; name: string }>;
}

export async function diffNames(db: Db): Promise<DiffNames> {
  const [g, s, t] = await Promise.all([
    db.select({ id: groups.id, name: groups.name, kind: groups.kind }).from(groups),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")),
  ]);
  return {
    groups: new Map(g.map((x) => [x.id, { name: x.name, kind: x.kind }])),
    subjects: new Map(s.map((x) => [x.id, x.name])),
    teachers: new Map(t.map((x) => [x.id, { code: x.code, name: x.name }])),
  };
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const fmt = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/** Seite einer Version: Entwürfe an ihrem Stichtag, veröffentlichte wie in der Versionsliste (heute bzw. ihr letzter Tag). */
export function versionSide(v: TimetablePlanVersion, todayYmd: string): DiffSide {
  const source = versionSource(v, todayYmd);
  const refYmd = source.kind === "live" ? source.refYmd : (v.validFrom ?? todayYmd);
  const kind = source.kind === "draft" ? "Entwurf" : v.status === "gueltig" ? "Gültige Version" : "Version";
  return { source, refYmd, label: `${kind} ${versionNumber(v)} „${v.name}“` };
}

export type DiffResult = { ok: true; before: DiffSide; after: DiffSide; diff: PlanDiff; version: TimetablePlanVersion } | { ok: false; problem: string };

/**
 * Vergleich einer Version mit dem gültigen Plan an ihrem Stichtag (`otherId` leer) oder mit einer anderen Version desselben Schuljahrs.
 * „Vorher“ ist der gültige Plan bzw. die andere Version, „nachher“ die gewählte Version.
 */
export async function loadPlanDiff(db: Db, versionId: string, otherId: string | null, todayYmd: string): Promise<DiffResult> {
  const v = await getVersion(db, versionId);
  if (!v) return { ok: false, problem: "Die Version gibt es nicht (mehr)." };
  const after = versionSide(v, todayYmd);
  let before: DiffSide;
  if (otherId) {
    const o = await getVersion(db, otherId);
    if (!o) return { ok: false, problem: "Die Vergleichsversion gibt es nicht (mehr)." };
    if (o.schoolYearId !== v.schoolYearId) return { ok: false, problem: "Die Versionen gehören zu verschiedenen Schuljahren." };
    if (o.id === v.id) return { ok: false, problem: "Eine Version lässt sich nicht mit sich selbst vergleichen." };
    before = versionSide(o, todayYmd);
  } else {
    before = { source: { kind: "live", refYmd: after.refYmd }, refYmd: after.refYmd, label: `Gültiger Plan am ${fmt(after.refYmd)}` };
  }
  const [a, b] = await Promise.all([diffLessons(db, before), diffLessons(db, after)]);
  return { ok: true, before, after, diff: planDiff(a, b), version: v };
}

/** Versionen, mit denen sich eine Version vergleichen lässt: desselben Schuljahrs, nicht verworfen, nicht sie selbst (neueste zuerst). */
export async function comparableVersions(db: Db, v: Pick<TimetablePlanVersion, "id" | "schoolYearId">): Promise<TimetablePlanVersion[]> {
  return db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, v.schoolYearId), ne(timetablePlanVersions.status, "verworfen"), ne(timetablePlanVersions.id, v.id)))
    .orderBy(desc(timetablePlanVersions.major), desc(timetablePlanVersions.minor), desc(timetablePlanVersions.createdAt), desc(timetablePlanVersions.id));
}
