// SP3-03 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1, §3.1, §5, F-10-3/F-10-4): Prüfung und Freigabe einer Planversion, Kommentare und die
// Lehrkräfte-Vorschau „Mein Plan ab …“. Status: entwurf → pruefung (Planung) → freigegeben (Schulleitung, `stundenplan.review`);
// „Zurück an die Planung“ setzt aus pruefung/freigegeben wieder `entwurf` (Freigabe verfällt). Bearbeitet wird nur im Status `entwurf`
// (`requireWritable`). Veröffentlichen ist SP3-04 – eine freigegebene Version bleibt bis dahin freigegeben.
// Kein Vier-Augen-Zwang (F-10-3): wer `manage` und `review` hat, darf den eigenen Entwurf freigeben; das Audit vermerkt es.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, periods, subjects, timetableDraftLessons, timetablePlanComments, timetablePlanVersions, users } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { getVersion, OPEN_STATUSES, STATUS_LABELS, versionNumber } from "./planversionen";
import type { PlanCommentTarget, PlanVersionStatus, TimetablePlanComment, TimetablePlanVersion } from "./schema";

export const COMMENT_MAX = 500;

/** Status, in denen die Prüfung (`review`) eine Version sieht: ab „in Prüfung“ (§5), dazu die veröffentlichten. */
export const REVIEW_VISIBLE = ["pruefung", "freigegeben", "gueltig", "archiviert"] as const satisfies readonly PlanVersionStatus[];
/** Status, in denen die Lehrkräfte-Vorschau wirkt (Schalter an): nur in Prüfung und freigegeben – nie im Entwurf. */
export const PREVIEW_STATUSES = ["pruefung", "freigegeben"] as const satisfies readonly PlanVersionStatus[];

export const TARGET_LABELS: Record<PlanCommentTarget, string> = { version: "ganze Version", teacher: "Lehrkraft", group: "Klasse/Kurs", slot: "Stunde" };

/** Wer schaut auf eine Version? Rechte der Person (die Action liest sie aus der Sitzung, Tests setzen sie direkt). */
export interface Viewer {
  userId: string;
  manage: boolean;
  review: boolean;
}

const has = (list: readonly string[], s: string) => list.includes(s);

/** Darf die Person die Version (Status, Inhalt, Kommentare) sehen? Planung alle, Prüfung ab „in Prüfung“, sonst niemand. */
export function canSeeVersion(viewer: Viewer, v: Pick<TimetablePlanVersion, "status">): boolean {
  if (viewer.manage) return true;
  return viewer.review && has(REVIEW_VISIBLE, v.status);
}

/** Darf die Person (Planung/Prüfung) einen Kommentar schreiben? Planung in offenen Entwürfen, Prüfung in Prüfung/freigegeben. */
export function canComment(viewer: Viewer, v: Pick<TimetablePlanVersion, "status">): boolean {
  if (viewer.manage && has(OPEN_STATUSES, v.status)) return true;
  return viewer.review && has(PREVIEW_STATUSES, v.status);
}

/** Welche Statuswechsel sind für die Person gerade möglich? (für die Knöpfe – die Services prüfen selbst) */
export function allowedTransitions(viewer: Viewer, v: Pick<TimetablePlanVersion, "status">): { submit: boolean; approve: boolean; giveBack: boolean } {
  return {
    submit: viewer.manage && v.status === "entwurf",
    approve: viewer.review && v.status === "pruefung",
    giveBack: (viewer.manage || viewer.review) && has(PREVIEW_STATUSES, v.status),
  };
}

async function loadVersion(db: Db, versionId: string): Promise<TimetablePlanVersion> {
  const v = await getVersion(db, versionId);
  if (!v) throw new ValidationError({ version: "Die Version gibt es nicht (mehr)" });
  return v;
}

/** Statuswechsel mit Vorbedingung im UPDATE (gleichzeitige Klicks: nur einer gewinnt). */
async function transition(db: Db, v: TimetablePlanVersion, from: readonly PlanVersionStatus[], set: Partial<typeof timetablePlanVersions.$inferInsert>) {
  const [done] = await db
    .update(timetablePlanVersions)
    .set(set)
    .where(and(eq(timetablePlanVersions.id, v.id), inArray(timetablePlanVersions.status, [...from])))
    .returning();
  if (!done) throw new ValidationError({ version: "Die Version wurde inzwischen geändert – Seite neu laden" });
  return done;
}

const wrongStatus = (v: TimetablePlanVersion, what: string) =>
  new ValidationError({ version: `Version ${versionNumber(v)} ist ${STATUS_LABELS[v.status]} – ${what}` });

// ---------------------------------------------------------------- Status

/** Planung (`manage`): Entwurf zur Prüfung geben. Danach ist er nur noch lesbar, bis er zurück an die Planung geht. */
export async function submitForReview(db: Db, viewer: Viewer, versionId: string, now = new Date()): Promise<TimetablePlanVersion> {
  if (!viewer.manage) throw new ValidationError({ version: "Zur Prüfung geben darf nur die Stundenplanung" });
  const v = await loadVersion(db, versionId);
  if (v.status !== "entwurf") throw wrongStatus(v, "nur ein Entwurf lässt sich zur Prüfung geben");
  const lessons = await db.$count(timetableDraftLessons, eq(timetableDraftLessons.versionId, v.id));
  if (!lessons) throw new ValidationError({ version: "Der Entwurf hat noch keine Stunden" });
  const done = await transition(db, v, ["entwurf"], { status: "pruefung", submittedBy: viewer.userId, submittedAt: now, approvedBy: null, approvedAt: null });
  await audit(db, viewer.userId, "stundenplan.plan.submit", v.id, { version: versionNumber(v), lessons });
  return done;
}

/**
 * Prüfung (`review`): Version freigeben. Ohne Vier-Augen-Zwang (F-10-3) – gab dieselbe Person sie zur Prüfung (bzw. legte sie an), steht
 * `self: true` im Audit, und die Versionskarte nennt „selbst freigegeben“.
 */
export async function approveVersion(db: Db, viewer: Viewer, versionId: string, now = new Date()): Promise<TimetablePlanVersion> {
  if (!viewer.review) throw new ValidationError({ version: "Freigeben darf nur, wer Planentwürfe prüft (Schulleitung)" });
  const v = await loadVersion(db, versionId);
  if (v.status !== "pruefung") throw wrongStatus(v, "freigeben lässt sich nur eine Version in Prüfung");
  const done = await transition(db, v, ["pruefung"], { status: "freigegeben", approvedBy: viewer.userId, approvedAt: now });
  const self = v.submittedBy === viewer.userId || v.createdBy === viewer.userId;
  const open = await db.$count(timetablePlanComments, and(eq(timetablePlanComments.versionId, v.id), sql`${timetablePlanComments.resolvedAt} is null`));
  await audit(db, viewer.userId, "stundenplan.plan.approve", v.id, { version: versionNumber(v), self, openComments: open });
  return done;
}

/**
 * „Zurück an die Planung“: aus `pruefung` (Prüfung gibt zurück) oder `freigegeben` (Freigabe zurücknehmen – Prüfung oder Planung) wieder
 * `entwurf`. Die Freigabe verfällt bei jeder Rückkehr, die Kommentare bleiben. Optional mit einem Kommentar an die ganze Version.
 */
export async function returnToPlanning(db: Db, viewer: Viewer, versionId: string, note?: string | null, now = new Date()): Promise<TimetablePlanVersion> {
  if (!viewer.manage && !viewer.review) throw new ValidationError({ version: "Keine Berechtigung" });
  const v = await loadVersion(db, versionId);
  if (!has(PREVIEW_STATUSES, v.status)) throw wrongStatus(v, "zurück an die Planung geht nur eine Version in Prüfung oder freigegeben");
  const body = note?.trim() ? cleanBody(note) : null;
  const done = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const out = await transition(t, v, PREVIEW_STATUSES, { status: "entwurf", approvedBy: null, approvedAt: null });
    if (body) await t.insert(timetablePlanComments).values({ versionId: v.id, authorId: viewer.userId, targetKind: "version", body, createdAt: now });
    return out;
  });
  await audit(db, viewer.userId, "stundenplan.plan.return", v.id, { version: versionNumber(v), from: v.status, by: viewer.review ? "review" : "manage", note: Boolean(body) });
  return done;
}

/** Planung: Lehrkräfte-Vorschau „Mein Plan ab …“ ein-/ausschalten (Vorgabe aus, F-10-4). Wirkt nur in Prüfung und freigegeben. */
export async function setTeacherPreview(db: Db, viewer: Viewer, versionId: string, on: boolean): Promise<TimetablePlanVersion> {
  if (!viewer.manage) throw new ValidationError({ version: "Die Vorschau schaltet nur die Stundenplanung" });
  const v = await loadVersion(db, versionId);
  if (!has(OPEN_STATUSES, v.status)) throw wrongStatus(v, "die Vorschau gibt es nur für Entwürfe");
  const done = await transition(db, v, OPEN_STATUSES, { teacherPreview: on });
  if (v.teacherPreview !== on) await audit(db, viewer.userId, "stundenplan.plan.preview", v.id, { version: versionNumber(v), on });
  return done;
}

/** Versionen in Prüfung bzw. freigegeben (alle Schuljahre, älteste Einreichung zuerst) – Übersicht der Schulleitung. */
export async function reviewQueue(db: Db): Promise<TimetablePlanVersion[]> {
  return db
    .select()
    .from(timetablePlanVersions)
    .where(inArray(timetablePlanVersions.status, [...PREVIEW_STATUSES]))
    .orderBy(asc(timetablePlanVersions.submittedAt), asc(timetablePlanVersions.id));
}

// ---------------------------------------------------------------- Kommentare

export interface CommentInput {
  targetKind: PlanCommentTarget;
  teacherId?: string | null;
  groupId?: string | null;
  weekday?: number | null;
  periodNr?: number | null;
  body: string;
}

function cleanBody(raw: string): string {
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (!body) throw new ValidationError({ body: "Text eingeben" });
  if (body.length > COMMENT_MAX) throw new ValidationError({ body: `Höchstens ${COMMENT_MAX} Zeichen` });
  return body;
}

/** Bezug prüfen: Lehrkraft/Gruppe/Stunde muss im Entwurf vorkommen (keine Kommentare an beliebige Konten). */
async function cleanTarget(db: Db, v: TimetablePlanVersion, input: CommentInput): Promise<Pick<typeof timetablePlanComments.$inferInsert, "targetKind" | "teacherId" | "groupId" | "weekday" | "periodNr">> {
  const inDraft = (cond: ReturnType<typeof eq>) => db.$count(timetableDraftLessons, and(eq(timetableDraftLessons.versionId, v.id), cond));
  switch (input.targetKind) {
    case "version":
      return { targetKind: "version", teacherId: null, groupId: null, weekday: null, periodNr: null };
    case "teacher":
      if (!input.teacherId || !(await inDraft(eq(timetableDraftLessons.teacherId, input.teacherId)))) throw new ValidationError({ teacherId: "Lehrkraft aus dem Entwurf wählen" });
      return { targetKind: "teacher", teacherId: input.teacherId, groupId: null, weekday: null, periodNr: null };
    case "group":
      if (!input.groupId || !(await inDraft(eq(timetableDraftLessons.groupId, input.groupId)))) throw new ValidationError({ groupId: "Klasse oder Kurs aus dem Entwurf wählen" });
      return { targetKind: "group", teacherId: null, groupId: input.groupId, weekday: null, periodNr: null };
    case "slot": {
      const wd = Number(input.weekday);
      const nr = Number(input.periodNr);
      if (!Number.isInteger(wd) || wd < 0 || wd > 4) throw new ValidationError({ weekday: "Wochentag wählen" });
      const [p] = await db.select({ nr: periods.nr }).from(periods).where(eq(periods.nr, nr));
      if (!Number.isInteger(nr) || !p) throw new ValidationError({ periodNr: "Stunde wählen" });
      if (input.groupId && !(await inDraft(eq(timetableDraftLessons.groupId, input.groupId)))) throw new ValidationError({ groupId: "Klasse oder Kurs aus dem Entwurf wählen" });
      return { targetKind: "slot", teacherId: input.teacherId ?? null, groupId: input.groupId || null, weekday: wd, periodNr: nr };
    }
    default:
      throw new ValidationError({ targetKind: "Bezug wählen" });
  }
}

export interface CommentTargets {
  teachers: { id: string; label: string }[];
  groups: { id: string; label: string }[];
  periods: { nr: number; label: string }[];
}

/** Auswahl für den Bezug eines Kommentars: Lehrkräfte und Klassen/Kurse des Entwurfs, Stunden des Zeitrasters. */
export async function commentTargets(db: Db, versionId: string): Promise<CommentTargets> {
  const [ts, gs, ps] = await Promise.all([
    db
      .selectDistinct({ id: users.id, code: users.shortCode, name: users.name })
      .from(timetableDraftLessons)
      .innerJoin(users, eq(users.id, timetableDraftLessons.teacherId))
      .where(eq(timetableDraftLessons.versionId, versionId)),
    db
      .selectDistinct({ id: groups.id, name: groups.name })
      .from(timetableDraftLessons)
      .innerJoin(groups, eq(groups.id, timetableDraftLessons.groupId))
      .where(eq(timetableDraftLessons.versionId, versionId)),
    db.select({ nr: periods.nr, startsAt: periods.startsAt }).from(periods).orderBy(asc(periods.nr)),
  ]);
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "de", { numeric: true });
  return {
    teachers: ts.map((t) => ({ id: t.id, label: t.code ? `${t.code} – ${t.name}` : t.name })).sort(byLabel),
    groups: gs.map((g) => ({ id: g.id, label: g.name })).sort(byLabel),
    periods: ps.map((p) => ({ nr: p.nr, label: `${p.nr}. Stunde (${p.startsAt})` })),
  };
}

/** Kommentar der Planung oder Prüfung an eine Version (Bezug: Version, Lehrkraft, Klasse/Kurs, Stunde). */
export async function addComment(db: Db, viewer: Viewer, versionId: string, input: CommentInput, now = new Date()): Promise<TimetablePlanComment> {
  const v = await loadVersion(db, versionId);
  if (!canSeeVersion(viewer, v)) throw new ValidationError({ version: "Die Version gibt es nicht (mehr)" });
  if (!canComment(viewer, v)) throw wrongStatus(v, viewer.manage ? "kommentieren lassen sich nur offene Entwürfe" : "kommentieren lässt sich eine Version in Prüfung oder freigegeben");
  const body = cleanBody(input.body);
  const target = await cleanTarget(db, v, input);
  const [c] = await db.insert(timetablePlanComments).values({ versionId: v.id, authorId: viewer.userId, body, createdAt: now, ...target }).returning();
  await audit(db, viewer.userId, "stundenplan.plan.comment", v.id, { version: versionNumber(v), target: target.targetKind });
  return c!;
}

/** Planung: Kommentar erledigen bzw. wieder öffnen. */
export async function resolveComment(db: Db, viewer: Viewer, commentId: string, resolved: boolean, now = new Date()): Promise<TimetablePlanComment> {
  if (!viewer.manage) throw new ValidationError({ comment: "Erledigen darf nur die Stundenplanung" });
  const [c] = await db.select().from(timetablePlanComments).where(eq(timetablePlanComments.id, commentId));
  if (!c) throw new ValidationError({ comment: "Den Kommentar gibt es nicht (mehr)" });
  const [done] = await db
    .update(timetablePlanComments)
    .set(resolved ? { resolvedBy: viewer.userId, resolvedAt: now } : { resolvedBy: null, resolvedAt: null })
    .where(eq(timetablePlanComments.id, c.id))
    .returning();
  await audit(db, viewer.userId, resolved ? "stundenplan.plan.comment_resolve" : "stundenplan.plan.comment_reopen", c.versionId, { comment: c.id });
  return done!;
}

export interface CommentView {
  comment: TimetablePlanComment;
  authorName: string | null;
  resolvedByName: string | null;
  /** Bezug als Text („Lehrkraft BRA“, „Klasse 7b“, „Mo 3. Stunde · Klasse 7b“) */
  targetText: string;
}

const WEEKDAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr"] as const;

async function describeTargets(db: Db, rows: TimetablePlanComment[]): Promise<Map<string, string>> {
  const teacherIds = [...new Set(rows.map((r) => r.teacherId).filter((x): x is string => Boolean(x)))];
  const groupIds = [...new Set(rows.map((r) => r.groupId).filter((x): x is string => Boolean(x)))];
  const [ts, gs] = await Promise.all([
    teacherIds.length ? db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(inArray(users.id, teacherIds)) : [],
    groupIds.length ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds)) : [],
  ]);
  const tName = new Map(ts.map((t) => [t.id, t.code ? `${t.code} – ${t.name}` : t.name]));
  const gName = new Map(gs.map((g) => [g.id, g.name]));
  const out = new Map<string, string>();
  for (const r of rows) {
    const parts: string[] = [];
    if (r.targetKind === "version") parts.push("ganze Version");
    if (r.targetKind === "slot") parts.push(`${WEEKDAY_NAMES[r.weekday ?? 0]} ${r.periodNr}. Stunde`);
    if (r.targetKind === "teacher" || (r.targetKind === "slot" && r.teacherId)) parts.push(r.teacherId ? `Lehrkraft ${tName.get(r.teacherId) ?? ""}`.trim() : "Lehrkraft (Konto gelöscht)");
    if (r.targetKind === "group" || (r.targetKind === "slot" && r.groupId)) parts.push(r.groupId ? (gName.get(r.groupId) ?? "Klasse/Kurs") : "Klasse/Kurs (gelöscht)");
    out.set(r.id, parts.join(" · "));
  }
  return out;
}

async function viewsOf(db: Db, rows: TimetablePlanComment[]): Promise<CommentView[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.authorId, r.resolvedBy]).filter((x): x is string => Boolean(x)))];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  const targets = await describeTargets(db, rows);
  return rows.map((c) => ({
    comment: c,
    authorName: c.authorId ? (names.get(c.authorId) ?? null) : null,
    resolvedByName: c.resolvedBy ? (names.get(c.resolvedBy) ?? null) : null,
    targetText: targets.get(c.id) ?? "",
  }));
}

/** Namen der Handelnden (eingereicht/freigegeben von) für Versionskarte und Prüfseite. */
export async function actorNames(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!list.length) return new Map();
  return new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list))).map((u) => [u.id, u.name]));
}

/** „selbst freigegeben“: dieselbe Person hat eingereicht bzw. angelegt und freigegeben (kein Vier-Augen-Zwang, F-10-3). */
export const selfApproved = (v: Pick<TimetablePlanVersion, "approvedBy" | "submittedBy" | "createdBy">) =>
  v.approvedBy !== null && (v.approvedBy === v.submittedBy || v.approvedBy === v.createdBy);

/** Kommentare einer Version für Planung/Prüfung (offene zuerst, je ältester zuerst). Ohne Sichtrecht: leer. */
export async function listComments(db: Db, viewer: Viewer, v: TimetablePlanVersion): Promise<CommentView[]> {
  if (!canSeeVersion(viewer, v)) return [];
  const rows = await db
    .select()
    .from(timetablePlanComments)
    .where(eq(timetablePlanComments.versionId, v.id))
    .orderBy(sql`${timetablePlanComments.resolvedAt} is not null`, asc(timetablePlanComments.createdAt), asc(timetablePlanComments.id));
  return viewsOf(db, rows);
}

/** Zahl offener Kommentare je Version (Versionskarte). */
export async function openCommentCounts(db: Db, versionIds: string[]): Promise<Map<string, number>> {
  if (!versionIds.length) return new Map();
  const rows = await db
    .select({ id: timetablePlanComments.versionId, n: sql<number>`count(*)::int` })
    .from(timetablePlanComments)
    .where(and(inArray(timetablePlanComments.versionId, versionIds), sql`${timetablePlanComments.resolvedAt} is null`))
    .groupBy(timetablePlanComments.versionId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

// ---------------------------------------------------------------- Lehrkräfte-Vorschau „Mein Plan ab …“

/** Versionen, deren Vorschau die Lehrkraft gerade sehen darf: Schalter an, Status in Prüfung/freigegeben (neueste zuerst). */
export async function previewVersions(db: Db): Promise<TimetablePlanVersion[]> {
  return db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.teacherPreview, true), inArray(timetablePlanVersions.status, [...PREVIEW_STATUSES])))
    .orderBy(asc(timetablePlanVersions.validFrom), asc(timetablePlanVersions.major), asc(timetablePlanVersions.minor), asc(timetablePlanVersions.createdAt), asc(timetablePlanVersions.id));
}

export interface PreviewLesson {
  id: string;
  weekday: number;
  periodNr: number;
  week: "all" | "A" | "B";
  subjectName: string;
  subjectColor: string | null;
  groupName: string;
  roomId: string | null;
  validFrom: string;
  validUntil: string | null;
}

export interface TeacherPreview {
  version: Pick<TimetablePlanVersion, "id" | "major" | "minor" | "name" | "status" | "validFrom">;
  lessons: PreviewLesson[];
}

/**
 * Vorschau „Mein Plan ab …“ (F-10-4, §5): **nur die eigenen Stunden** der Lehrkraft im Entwurf – die Abfrage filtert auf `teacher_id`, es
 * gibt keine anderen Lehrkräfte, keine Kommentare anderer, keine Diagnose. Ohne eingeschalteten Schalter oder außerhalb von Prüfung/
 * freigegeben: `null` (wie „gibt es nicht“).
 */
export async function teacherPreview(db: Db, teacherId: string, versionId: string): Promise<TeacherPreview | null> {
  const [v] = await db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, versionId));
  if (!v || !v.teacherPreview || !has(PREVIEW_STATUSES, v.status)) return null;
  const rows = await db
    .select({
      id: timetableDraftLessons.id,
      weekday: timetableDraftLessons.weekday,
      periodNr: timetableDraftLessons.periodNr,
      week: timetableDraftLessons.week,
      subjectName: subjects.name,
      subjectColor: subjects.color,
      groupName: groups.name,
      roomId: timetableDraftLessons.roomId,
      validFrom: timetableDraftLessons.validFrom,
      validUntil: timetableDraftLessons.validUntil,
    })
    .from(timetableDraftLessons)
    .innerJoin(subjects, eq(subjects.id, timetableDraftLessons.subjectId))
    .innerJoin(groups, eq(groups.id, timetableDraftLessons.groupId))
    .where(and(eq(timetableDraftLessons.versionId, v.id), eq(timetableDraftLessons.teacherId, teacherId)))
    .orderBy(asc(timetableDraftLessons.weekday), asc(timetableDraftLessons.periodNr), asc(groups.name), asc(timetableDraftLessons.id));
  return { version: { id: v.id, major: v.major, minor: v.minor, name: v.name, status: v.status, validFrom: v.validFrom }, lessons: rows };
}

/** Eigene Kommentare der Lehrkraft zu einer Version (aus der Vorschau) – nie die anderer. */
export async function ownComments(db: Db, userId: string, versionId: string): Promise<CommentView[]> {
  const rows = await db
    .select()
    .from(timetablePlanComments)
    .where(and(eq(timetablePlanComments.versionId, versionId), eq(timetablePlanComments.authorId, userId)))
    .orderBy(asc(timetablePlanComments.createdAt), asc(timetablePlanComments.id));
  return viewsOf(db, rows);
}

/**
 * Rückmeldung einer Lehrkraft aus der Vorschau an die Planung: nur bei sichtbarer Vorschau, Bezug ist die eigene Person (ganz) oder eine
 * Stunde des eigenen Plans (Wochentag + Stunde, mit der eigenen Kennung).
 */
export async function addPreviewComment(db: Db, teacherId: string, versionId: string, input: { weekday?: number | null; periodNr?: number | null; body: string }, now = new Date()): Promise<TimetablePlanComment> {
  const preview = await teacherPreview(db, teacherId, versionId);
  if (!preview) throw new ValidationError({ version: "Diese Vorschau ist nicht (mehr) freigeschaltet" });
  const body = cleanBody(input.body);
  let target: Pick<typeof timetablePlanComments.$inferInsert, "targetKind" | "weekday" | "periodNr"> = { targetKind: "teacher", weekday: null, periodNr: null };
  if (input.weekday !== null && input.weekday !== undefined && input.periodNr !== null && input.periodNr !== undefined) {
    const own = preview.lessons.some((l) => l.weekday === input.weekday && l.periodNr === input.periodNr);
    if (!own) throw new ValidationError({ slot: "Stunde aus deinem Plan wählen" });
    target = { targetKind: "slot", weekday: input.weekday, periodNr: input.periodNr };
  }
  const [c] = await db.insert(timetablePlanComments).values({ versionId, authorId: teacherId, teacherId, fromPreview: true, body, createdAt: now, ...target }).returning();
  await audit(db, teacherId, "stundenplan.plan.preview_comment", versionId, { version: versionNumber(preview.version), target: target.targetKind });
  return c!;
}
