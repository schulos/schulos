// Umfragen (P3-03): anlegen, bearbeiten, Zielgruppen, Sichtbarkeit. Teilnehmen und Auswertung folgen in P3-04.
import { and, asc, count, desc, eq, gt, inArray, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import {
  groupMembers,
  groups,
  QUESTION_KINDS,
  ROLES,
  surveyParticipation,
  surveyQuestions,
  surveyResponses,
  surveys,
  surveyTargets,
  users,
  type QuestionKind,
  type Role,
} from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { childIdsQuery, guardianRecipients, isSelfResponsible } from "@/core/school/majority";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { de } from "@/core/db/sort";

export const canCreate = (p: PermissionSet) => hasPermission(p, "umfragen.create");
export const canManage = (p: PermissionSet) => hasPermission(p, "umfragen.manage");

export const KIND_LABELS: Record<QuestionKind, string> = {
  single: "Einfachauswahl",
  multi: "Mehrfachauswahl",
  scale: "Skala 1–5",
  text: "Freitext",
};
export const MAX_QUESTIONS = 30;
export const MAX_OPTIONS = 12;

export interface QuestionInput {
  kind: QuestionKind;
  text: string;
  options: string[];
  required: boolean;
}

export interface TargetInput {
  roles: Role[];
  groups: { groupId: string; parents: boolean }[];
}

export interface SurveyInput {
  title: string;
  description: string;
  anonymous: boolean;
  opensAt: Date;
  closesAt: Date;
  targets: TargetInput;
  questions: QuestionInput[];
  /** Zielgruppe per Gong benachrichtigen (nur beim Anlegen) */
  notify?: boolean;
}

export type SurveyStatus = "geplant" | "offen" | "beendet";
export function statusOf(s: { opensAt: Date; closesAt: Date }, now = new Date()): SurveyStatus {
  if (now < s.opensAt) return "geplant";
  return now < s.closesAt ? "offen" : "beendet";
}

/** Prüft Eingaben; normalisiert Texte und Optionen (getrimmt, leere Optionen raus). */
export function normalize(input: SurveyInput, now = new Date(), creating = true): SurveyInput {
  const errors: Record<string, string> = {};
  const title = input.title.trim();
  if (!title) errors.title = "Titel fehlt";
  else if (title.length > 140) errors.title = "Höchstens 140 Zeichen";
  if (input.description.length > 5000) errors.description = "Höchstens 5000 Zeichen";
  if (Number.isNaN(input.opensAt.getTime())) errors.opensAt = "Beginn fehlt";
  if (Number.isNaN(input.closesAt.getTime())) errors.closesAt = "Ende fehlt";
  else if (input.closesAt <= input.opensAt) errors.closesAt = "Ende muss nach dem Beginn liegen";
  else if (creating && input.closesAt <= now) errors.closesAt = "Ende liegt in der Vergangenheit";
  if (input.targets.roles.some((r) => !ROLES.includes(r) || r === "admin")) errors.targets = "Unbekannte Zielgruppe";
  if (input.targets.roles.length === 0 && input.targets.groups.length === 0) errors.targets = "Bitte mindestens eine Zielgruppe wählen";

  const questions = input.questions.map((q) => ({
    kind: q.kind,
    text: q.text.trim(),
    options: q.kind === "single" || q.kind === "multi" ? q.options.map((o) => o.trim()).filter(Boolean) : [],
    required: q.required,
  }));
  if (questions.length === 0) errors.questions = "Bitte mindestens eine Frage anlegen";
  else if (questions.length > MAX_QUESTIONS) errors.questions = `Höchstens ${MAX_QUESTIONS} Fragen`;
  questions.forEach((q, i) => {
    const n = `Frage ${i + 1}`;
    if (!QUESTION_KINDS.includes(q.kind)) errors.questions ??= `${n}: unbekannte Art`;
    else if (!q.text) errors.questions ??= `${n}: Fragetext fehlt`;
    else if (q.text.length > 500) errors.questions ??= `${n}: höchstens 500 Zeichen`;
    else if ((q.kind === "single" || q.kind === "multi") && q.options.length < 2) errors.questions ??= `${n}: mindestens zwei Antwortmöglichkeiten`;
    else if (q.options.length > MAX_OPTIONS) errors.questions ??= `${n}: höchstens ${MAX_OPTIONS} Antwortmöglichkeiten`;
    else if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) errors.questions ??= `${n}: Antwortmöglichkeiten doppelt`;
    else if (q.options.some((o) => o.length > 200)) errors.questions ??= `${n}: Antwortmöglichkeit zu lang (höchstens 200 Zeichen)`;
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const seen = new Set<string>();
  const groupTargets = input.targets.groups.filter((g) => {
    const k = `${g.groupId}:${g.parents}`;
    return !seen.has(k) && seen.add(k);
  });
  return { ...input, title, description: input.description.trim(), questions, targets: { roles: [...new Set(input.targets.roles)], groups: groupTargets } };
}

/** Gruppen, die Ersteller:innen als Zielgruppe wählen können: Personal alle (nicht archiviert), sonst eigene. */
export async function targetableGroups(db: Db, actor: PermissionSet) {
  const staff = ["lehrkraft", "verwaltung", "admin"].includes(actor.role);
  const rows = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, archivedAt: groups.archivedAt })
    .from(groups)
    .where(staff ? undefined : inArray(groups.id, [...actor.memberOf, "__none__"]))
    .orderBy(asc(groups.kind), asc(groups.gradeLevel), de(groups.name));
  return rows.filter((g) => !g.archivedAt).map(({ id, name, kind }) => ({ id, name, kind }));
}

async function checkGroups(db: Db, actor: PermissionSet, input: SurveyInput) {
  if (input.targets.groups.length === 0) return;
  const allowed = new Set((await targetableGroups(db, actor)).map((g) => g.id));
  if (input.targets.groups.some((g) => !allowed.has(g.groupId))) throw new ValidationError({ targets: "Diese Gruppe kannst du nicht wählen" });
}

/**
 * Gruppen, für die man als „Eltern der Gruppe“ angesprochen ist: Eltern – Gruppen ihrer minderjährigen Kinder; eigenständige
 * (volljährige) Schüler:innen – ihre eigenen Gruppen (Q5-05: Eltern-Umfragen gehen an die Person selbst, nicht an die Eltern).
 */
async function childGroups(db: Db, viewer: PermissionSet): Promise<string[]> {
  if (viewer.role === "schueler") return (await isSelfResponsible(db, viewer.userId)) ? [...viewer.memberOf] : [];
  if (viewer.role !== "eltern") return [];
  const rows = await db
    .select({ g: groupMembers.groupId })
    .from(groupMembers)
    .where(inArray(groupMembers.userId, childIdsQuery(db, viewer.userId, "act")));
  return [...new Set(rows.map((r) => r.g))];
}

/** Bedingung „Umfrage richtet sich an den Betrachter“ über umfragen_targets. */
async function targetedCondition(db: Db, viewer: PermissionSet): Promise<SQL> {
  const conds: SQL[] = [eq(surveyTargets.role, viewer.role)];
  if (viewer.memberOf.size) conds.push(and(inArray(surveyTargets.groupId, [...viewer.memberOf]), eq(surveyTargets.parents, false))!);
  const kids = await childGroups(db, viewer);
  if (kids.length) conds.push(and(inArray(surveyTargets.groupId, kids), eq(surveyTargets.parents, true))!);
  return or(...conds)!;
}

async function targetedSurveyIds(db: Db, viewer: PermissionSet, ids?: string[]): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ id: surveyTargets.surveyId })
    .from(surveyTargets)
    .where(and(await targetedCondition(db, viewer), ids ? inArray(surveyTargets.surveyId, ids.length ? ids : ["__none__"]) : undefined));
  return new Set(rows.map((r) => r.id));
}

/** Alle Personen, an die sich eine Umfrage richtet (aktive Konten) – für Erinnerungen und „x von y“. */
export async function resolveAudience(db: Db, surveyId: string): Promise<string[]> {
  const targets = await db.select().from(surveyTargets).where(eq(surveyTargets.surveyId, surveyId));
  const ids = new Set<string>();
  const roles = targets.flatMap((t) => (t.role ? [t.role] : []));
  const memberGroups = targets.filter((t) => t.groupId && !t.parents).map((t) => t.groupId!);
  const parentGroups = targets.filter((t) => t.groupId && t.parents).map((t) => t.groupId!);
  if (roles.length) (await db.select({ id: users.id }).from(users).where(and(inArray(users.role, roles), eq(users.status, "active")))).forEach((r) => ids.add(r.id));
  if (memberGroups.length) {
    const rows = await db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(inArray(groupMembers.groupId, memberGroups), eq(users.status, "active")));
    rows.forEach((r) => ids.add(r.id));
  }
  if (parentGroups.length) {
    // Q5-05: Eltern minderjähriger Schüler:innen bzw. die eigenständige Person selbst
    const students = await db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(inArray(groupMembers.groupId, parentGroups), eq(users.role, "schueler")));
    const parents = await guardianRecipients(db, students.map((r) => r.id), { withInformed: false });
    if (parents.length) (await db.select({ id: users.id }).from(users).where(and(inArray(users.id, parents), eq(users.status, "active")))).forEach((r) => ids.add(r.id));
  }
  return [...ids];
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function writeChildren(db: Db | Tx, surveyId: string, input: SurveyInput, questions: boolean) {
  await db.delete(surveyTargets).where(eq(surveyTargets.surveyId, surveyId));
  const targets = [
    ...input.targets.roles.map((role) => ({ surveyId, role })),
    ...input.targets.groups.map((g) => ({ surveyId, groupId: g.groupId, parents: g.parents })),
  ];
  if (targets.length) await db.insert(surveyTargets).values(targets);
  if (!questions) return;
  await db.delete(surveyQuestions).where(eq(surveyQuestions.surveyId, surveyId));
  await db.insert(surveyQuestions).values(input.questions.map((q, position) => ({ surveyId, position, ...q })));
}

export async function createSurvey(db: Db, actor: PermissionSet, raw: SurveyInput, now = new Date()): Promise<string> {
  if (!canCreate(actor)) throw new ForbiddenError("umfragen.create");
  const input = normalize(raw, now);
  await checkGroups(db, actor, input);
  const id = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(surveys)
      .values({ authorId: actor.userId, title: input.title, description: input.description, anonymous: input.anonymous, opensAt: input.opensAt, closesAt: input.closesAt })
      .returning({ id: surveys.id });
    await writeChildren(tx, s!.id, input, true);
    return s!.id;
  });
  if (input.notify) {
    const audience = (await resolveAudience(db, id)).filter((u) => u !== actor.userId);
    const when = input.opensAt > now ? `ab ${new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", timeZone: "Europe/Berlin" }).format(input.opensAt)}` : "jetzt";
    await notify(db, audience, { moduleId: "umfragen", title: `Umfrage: ${input.title}`, body: `Teilnahme ${when} möglich`, href: `/umfragen/${id}` });
  }
  return id;
}

/** Bearbeiten/Löschen erlaubt? Schnellumfragen lassen sich nicht bearbeiten (immer anonym, Ziel fest an der Gruppe). */
async function editable(db: Db, actor: PermissionSet, id: string, opts: { quick?: boolean } = {}) {
  const [s] = await db.select().from(surveys).where(eq(surveys.id, id));
  if (!s || !canEdit(actor, s) || (s.quick && !opts.quick)) throw new ForbiddenError("umfragen.create");
  return s;
}

const targetKeys = (rows: { role: string | null; groupId: string | null; parents: boolean }[]) =>
  rows
    .map((t) => (t.role ? `r:${t.role}` : `g:${t.groupId}:${t.parents}`))
    .sort()
    .join("|");

export function canEdit(actor: PermissionSet, s: { authorId: string | null }) {
  return canManage(actor) || (canCreate(actor) && s.authorId === actor.userId);
}

/**
 * Bearbeiten: Titel, Beschreibung und Zeitraum immer; Fragen und „anonym“ nur, solange es keine Antworten gibt – sonst
 * passten Antworten nicht mehr zu den Fragen bzw. das Anonymitätsversprechen bräche. Zielgruppen anonymer Umfragen
 * ebenfalls nur ohne Antworten: sonst ließe sich eine einzelne Person gezielt dazunehmen und ihre Antwort herausrechnen.
 * Die Zahl der Antworten wird unter Sperre der Umfrage gelesen (Teilnahme sperrt dieselbe Zeile), damit eine gleichzeitig
 * eingehende Antwort nicht mit den Fragen gelöscht wird.
 */
export async function updateSurvey(db: Db, actor: PermissionSet, id: string, raw: SurveyInput, now = new Date()): Promise<void> {
  const survey = await editable(db, actor, id);
  const input = normalize(raw, now, false);
  await checkGroups(db, actor, input);
  await db.transaction(async (tx) => {
    await tx.select({ id: surveys.id }).from(surveys).where(eq(surveys.id, id)).for("update");
    const [{ n: responses }] = (await tx.select({ n: count() }).from(surveyResponses).where(eq(surveyResponses.surveyId, id))) as [{ n: number }];
    if (responses > 0 && input.anonymous !== survey.anonymous) throw new ValidationError({ anonymous: "Es gibt schon Antworten – anonym/namentlich lässt sich nicht mehr ändern" });
    if (responses > 0 && survey.anonymous) {
      const current = await tx.select().from(surveyTargets).where(eq(surveyTargets.surveyId, id));
      const next = [
        ...input.targets.roles.map((role) => ({ role, groupId: null, parents: false })),
        ...input.targets.groups.map((g) => ({ role: null, groupId: g.groupId, parents: g.parents })),
      ];
      if (targetKeys(current) !== targetKeys(next)) throw new ValidationError({ targets: "Es gibt schon Antworten – bei anonymen Umfragen lassen sich die Zielgruppen nicht mehr ändern" });
    }
    await tx.update(surveys).set({ title: input.title, description: input.description, anonymous: input.anonymous, opensAt: input.opensAt, closesAt: input.closesAt }).where(eq(surveys.id, id));
    await writeChildren(tx, id, input, responses === 0);
  });
}

export async function deleteSurvey(db: Db, actor: PermissionSet, id: string): Promise<void> {
  await editable(db, actor, id, { quick: true });
  await db.delete(surveys).where(eq(surveys.id, id));
}

export interface SurveyListItem {
  id: string;
  title: string;
  anonymous: boolean;
  opensAt: Date;
  closesAt: Date;
  status: SurveyStatus;
  participated: boolean;
  responses?: number;
}

const listSelect = { id: surveys.id, title: surveys.title, anonymous: surveys.anonymous, opensAt: surveys.opensAt, closesAt: surveys.closesAt };

/** Offene Umfragen, die sich an den Betrachter richten, mit „schon teilgenommen“. */
export async function listForParticipant(db: Db, viewer: PermissionSet, now = new Date()): Promise<SurveyListItem[]> {
  const rows = await db
    .select(listSelect)
    .from(surveys)
    // Schnellumfragen erscheinen im Kursraum und im Gruppenchat, nicht in den Listen
    .where(and(lte(surveys.opensAt, now), gt(surveys.closesAt, now), eq(surveys.quick, false)))
    .orderBy(asc(surveys.closesAt));
  const targeted = await targetedSurveyIds(db, viewer, rows.map((r) => r.id));
  const mine = rows.filter((r) => targeted.has(r.id));
  const done = mine.length
    ? new Set(
        (
          await db
            .select({ id: surveyParticipation.surveyId })
            .from(surveyParticipation)
            .where(and(eq(surveyParticipation.userId, viewer.userId), inArray(surveyParticipation.surveyId, mine.map((r) => r.id))))
        ).map((r) => r.id),
      )
    : new Set<string>();
  return mine.map((r) => ({ ...r, status: statusOf(r, now), participated: done.has(r.id) }));
}

/** Eigene Umfragen (mit `umfragen.manage` alle) samt Zahl der Antworten. */
export async function listOwn(db: Db, viewer: PermissionSet, now = new Date()): Promise<SurveyListItem[]> {
  if (!canCreate(viewer) && !canManage(viewer)) return [];
  const rows = await db
    .select(listSelect)
    .from(surveys)
    .where(and(eq(surveys.quick, false), canManage(viewer) ? undefined : eq(surveys.authorId, viewer.userId)))
    .orderBy(desc(surveys.closesAt));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ id: surveyResponses.surveyId, n: count() })
    .from(surveyResponses)
    .where(inArray(surveyResponses.surveyId, rows.map((r) => r.id)))
    .groupBy(surveyResponses.surveyId);
  return rows.map((r) => ({ ...r, status: statusOf(r, now), participated: false, responses: counts.find((c) => c.id === r.id)?.n ?? 0 }));
}

/** Eine Umfrage, wenn der Betrachter sie sehen darf (Zielgruppe, Autor:in oder `umfragen.manage`). */
export async function getSurvey(db: Db, viewer: PermissionSet, id: string, now = new Date()) {
  const [s] = await db.select().from(surveys).where(eq(surveys.id, id));
  if (!s) return null;
  const targeted = (await targetedSurveyIds(db, viewer, [id])).has(id);
  const edit = canEdit(viewer, s);
  if (!targeted && !edit) return null;
  const [questions, targets, [participation], [responses], [author]] = await Promise.all([
    db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, id)).orderBy(asc(surveyQuestions.position)),
    db
      .select({ role: surveyTargets.role, groupId: surveyTargets.groupId, parents: surveyTargets.parents, groupName: groups.name })
      .from(surveyTargets)
      .leftJoin(groups, eq(groups.id, surveyTargets.groupId))
      .where(eq(surveyTargets.surveyId, id)),
    db.select().from(surveyParticipation).where(and(eq(surveyParticipation.surveyId, id), eq(surveyParticipation.userId, viewer.userId))),
    db.select({ n: count() }).from(surveyResponses).where(eq(surveyResponses.surveyId, id)),
    s.authorId ? db.select({ name: users.name }).from(users).where(eq(users.id, s.authorId)) : Promise.resolve([]),
  ]);
  return {
    survey: s,
    authorName: author?.name ?? null,
    status: statusOf(s, now),
    questions,
    targets: {
      roles: targets.flatMap((t) => (t.role ? [t.role] : [])),
      groups: targets.flatMap((t) => (t.groupId ? [{ groupId: t.groupId, parents: t.parents }] : [])),
      labels: targets.map((t) => (t.role ? ROLE_LABELS[t.role] : t.parents ? `Eltern ${t.groupName ?? "?"}` : (t.groupName ?? "?"))),
    },
    targeted,
    participated: !!participation,
    responses: responses?.n ?? 0,
    canEdit: edit,
  };
}
