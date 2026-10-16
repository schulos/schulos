// Schnellumfrage (P3-05): eine Frage mit Antwortknöpfen an eine Gruppe, immer anonym, live über den SSE-Kanal.
// Gestartet von der Leitung (bzw. Personal in der Gruppe) im Kursraum oder Gruppenchat; endet nach Zeit oder von Hand.
// Gespeichert wie jede Umfrage (umfragen_* mit quick = true) – Löschfristen, Auskunft und Anonymität gelten unverändert.
import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, surveyAnswers, surveyParticipation, surveyQuestions, surveyResponses, surveys, surveyTargets } from "@/core/db/schema";
import { publish, type PollState } from "@/core/notifications/bus";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { countedOf, countedResponseIds, submitResponse } from "./teilnahme";

const STAFF = ["lehrkraft", "verwaltung", "admin"];
export const QUICK_MINUTES = [1, 2, 5, 10, 15, 30, 60] as const;

/** Starten darf die Leitung der Gruppe oder Personal, das Mitglied ist (wie beim Gruppenkalender). */
export function canStartQuickPoll(viewer: PermissionSet, groupId: string): boolean {
  return viewer.leaderOf.has(groupId) || (STAFF.includes(viewer.role) && viewer.memberOf.has(groupId));
}

export interface QuickPollInput {
  question: string;
  options: string[];
  minutes: number;
}

async function pollRow(db: Db, pollId: string) {
  const [row] = await db
    .select({ id: surveys.id, opensAt: surveys.opensAt, closesAt: surveys.closesAt, quick: surveys.quick, groupId: surveyTargets.groupId })
    .from(surveys)
    .innerJoin(surveyTargets, eq(surveyTargets.surveyId, surveys.id))
    .where(eq(surveys.id, pollId));
  return row?.quick && row.groupId ? { ...row, groupId: row.groupId } : null;
}

/** Stand einer Schnellumfrage: Anzahl immer, Verteilung in Fünferschritten (anonym, siehe teilnahme.ts). */
export async function pollState(db: Db, pollId: string, now = new Date()): Promise<PollState | null> {
  const row = await pollRow(db, pollId);
  if (!row) return null;
  const [q] = await db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, pollId));
  const [{ n }] = (await db.select({ n: count() }).from(surveyResponses).where(eq(surveyResponses.surveyId, pollId))) as [{ n: number }];
  let counts: number[] | null = null;
  const ids = await countedResponseIds(db, pollId, n);
  if (ids.length) {
    const answers = await db
      .select({ choices: surveyAnswers.choices })
      .from(surveyAnswers)
      .where(and(eq(surveyAnswers.questionId, q!.id), inArray(surveyAnswers.responseId, ids)));
    counts = q!.options.map((_, i) => answers.filter((a) => a.choices?.includes(i)).length);
  }
  return {
    id: pollId,
    groupId: row.groupId,
    question: q!.text,
    options: q!.options,
    closesAt: row.closesAt.toISOString(),
    open: row.closesAt > now,
    total: n,
    counted: countedOf(n),
    counts,
  };
}

async function broadcast(db: Db, state: PollState) {
  const members = await db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, state.groupId));
  for (const m of members) publish(m.id, { type: "poll", poll: state });
}

export async function startQuickPoll(db: Db, viewer: PermissionSet, groupId: string, input: QuickPollInput, now = new Date()): Promise<string> {
  if (!canStartQuickPoll(viewer, groupId)) throw new ForbiddenError("umfragen.quick");
  const question = input.question.trim();
  const options = input.options.map((o) => o.trim()).filter(Boolean);
  const errors: Record<string, string> = {};
  if (!question) errors.question = "Frage fehlt";
  else if (question.length > 300) errors.question = "Höchstens 300 Zeichen";
  if (options.length < 2) errors.options = "Mindestens zwei Antworten";
  else if (options.length > 6) errors.options = "Höchstens sechs Antworten";
  else if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) errors.options = "Antworten doppelt";
  else if (options.some((o) => o.length > 60)) errors.options = "Antworten höchstens 60 Zeichen";
  if (!(QUICK_MINUTES as readonly number[]).includes(input.minutes)) errors.minutes = "Ungültige Dauer";
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const id = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(surveys)
      .values({ authorId: viewer.userId, title: question.slice(0, 140), anonymous: true, quick: true, opensAt: now, closesAt: new Date(now.getTime() + input.minutes * 60_000) })
      .returning({ id: surveys.id });
    await tx.insert(surveyTargets).values({ surveyId: s!.id, groupId });
    await tx.insert(surveyQuestions).values({ surveyId: s!.id, position: 0, kind: "single", text: question, options, required: true });
    return s!.id;
  });
  await broadcast(db, (await pollState(db, id, now))!);
  return id;
}

/** Laufende Schnellumfragen einer Gruppe (für Mitglieder) samt „schon geantwortet“. */
export async function activeQuickPolls(db: Db, viewer: PermissionSet, groupId: string, now = new Date()) {
  if (!viewer.memberOf.has(groupId)) return [];
  const rows = await db
    .select({ id: surveys.id })
    .from(surveys)
    .innerJoin(surveyTargets, eq(surveyTargets.surveyId, surveys.id))
    .where(and(eq(surveys.quick, true), eq(surveyTargets.groupId, groupId), gt(surveys.closesAt, now)))
    .orderBy(asc(surveys.opensAt));
  if (rows.length === 0) return [];
  const done = new Set(
    (
      await db
        .select({ id: surveyParticipation.surveyId })
        .from(surveyParticipation)
        .where(and(eq(surveyParticipation.userId, viewer.userId), inArray(surveyParticipation.surveyId, rows.map((r) => r.id))))
    ).map((r) => r.id),
  );
  const states = await Promise.all(rows.map((r) => pollState(db, r.id, now)));
  return states.filter((s): s is PollState => !!s).map((s) => ({ ...s, answered: done.has(s.id), canEnd: canStartQuickPoll(viewer, s.groupId) }));
}

export async function answerQuickPoll(db: Db, viewer: PermissionSet, pollId: string, choice: number, now = new Date()): Promise<void> {
  const [q] = await db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, pollId));
  if (!q || !(await pollRow(db, pollId))) throw new ForbiddenError("umfragen.answer");
  await submitResponse(db, viewer, pollId, { [q.id]: { choices: [choice] } }, now);
  await broadcast(db, (await pollState(db, pollId, now))!);
}

/** Von Hand beenden: Leitung bzw. Personal der Gruppe. */
export async function endQuickPoll(db: Db, viewer: PermissionSet, pollId: string, now = new Date()): Promise<void> {
  const row = await pollRow(db, pollId);
  if (!row || !canStartQuickPoll(viewer, row.groupId)) throw new ForbiddenError("umfragen.quick");
  // Ende muss nach dem Beginn liegen (Prüfregel) – auch wenn direkt nach dem Start beendet wird
  if (row.closesAt > now) await db.update(surveys).set({ closesAt: new Date(Math.max(now.getTime(), row.opensAt.getTime() + 1)) }).where(eq(surveys.id, pollId));
  await broadcast(db, (await pollState(db, pollId, now))!);
}
