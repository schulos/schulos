// Umfragen (P3-04): teilnehmen, auswerten, CSV, Erinnerung an Nicht-Teilnehmende.
// Anonym: Antworten ohne Personenbezug und nur mit Tag; Ergebnisse erst ab MIN_ANONYMOUS Antworten; Freitexte und
// CSV-Zeilen sortiert statt in Eingangsreihenfolge (sonst ließe sich die Reihenfolge mit der Teilnahme abgleichen).
// Ergebnisse anonymer Umfragen wachsen nur in Fünferschritten (Review 2026-10-10): würde jede Antwort sofort eingerechnet,
// verriete die Differenz vorher/nachher, was die gerade antwortende Person gewählt hat.
// Grenze: Wer direkt auf die Datenbank zugreift (Superuser), kann Teilnahme und Antwort über Systemspalten derselben
// Transaktion verknüpfen – die Anonymität gilt gegenüber allen Nutzenden der Plattform (DATENSCHUTZ.md §5).
import { csvCell } from "@/core/csv";
import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { surveyAnswers, surveyParticipation, surveyResponses, surveys, users, type QuestionKind } from "@/core/db/schema";
import { audit } from "@/core/audit";
import { notify } from "@/core/notifications";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { getSurvey, resolveAudience } from "./service";

/** CSV-Zelle (gemeinsamer Helfer src/core/csv.ts) – hier weiter exportiert für bestehende Aufrufer. */
export { csvCell };

export const MIN_ANONYMOUS = 5;
export const MAX_TEXT = 2000;
const collator = new Intl.Collator("de");

/** Wie viele Antworten eine anonyme Auswertung einrechnet: nur volle Fünferschritte. */
export function countedOf(total: number): number {
  return Math.floor(total / MIN_ANONYMOUS) * MIN_ANONYMOUS;
}

/** Die eingerechneten Antworten einer anonymen Umfrage: die ersten ⌊n/5⌋·5 nach Eingang. */
export async function countedResponseIds(db: Db, surveyId: string, total: number): Promise<string[]> {
  const n = countedOf(total);
  if (n === 0) return [];
  const rows = await db.select({ id: surveyResponses.id }).from(surveyResponses).where(eq(surveyResponses.surveyId, surveyId)).orderBy(asc(surveyResponses.seq)).limit(n);
  return rows.map((r) => r.id);
}

export interface AnswerInput {
  choices?: number[];
  scale?: number;
  text?: string;
}

interface QuestionLike {
  id: string;
  kind: QuestionKind;
  text: string;
  options: string[];
  required: boolean;
}

/** Prüft die Antworten gegen die Fragen; liefert nur beantwortete Fragen (leere freiwillige fallen weg). */
export function checkAnswers(questions: QuestionLike[], raw: Record<string, AnswerInput>) {
  const errors: Record<string, string> = {};
  const out: { questionId: string; choices: number[] | null; scale: number | null; text: string | null }[] = [];
  for (const q of questions) {
    const a = raw[q.id] ?? {};
    const key = `q:${q.id}`;
    if (q.kind === "single" || q.kind === "multi") {
      const choices = [...new Set(a.choices ?? [])];
      if (choices.some((c) => !Number.isInteger(c) || c < 0 || c >= q.options.length)) errors[key] = "Ungültige Auswahl";
      else if (q.kind === "single" && choices.length > 1) errors[key] = "Bitte nur eine Antwort wählen";
      else if (choices.length === 0) {
        if (q.required) errors[key] = "Bitte eine Antwort wählen";
      } else out.push({ questionId: q.id, choices: choices.sort((x, y) => x - y), scale: null, text: null });
    } else if (q.kind === "scale") {
      if (a.scale === undefined) {
        if (q.required) errors[key] = "Bitte einen Wert wählen";
      } else if (!Number.isInteger(a.scale) || a.scale < 1 || a.scale > 5) errors[key] = "Wert zwischen 1 und 5";
      else out.push({ questionId: q.id, choices: null, scale: a.scale, text: null });
    } else {
      const text = (a.text ?? "").trim();
      if (!text) {
        if (q.required) errors[key] = "Bitte eine Antwort schreiben";
      } else if (text.length > MAX_TEXT) errors[key] = `Höchstens ${MAX_TEXT} Zeichen`;
      else out.push({ questionId: q.id, choices: null, scale: null, text });
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/** Teilnahme: einmal je Person, nur während die Umfrage offen ist und sie sich an den Betrachter richtet. */
export async function submitResponse(db: Db, viewer: PermissionSet, surveyId: string, raw: Record<string, AnswerInput>, now = new Date()): Promise<void> {
  const data = await getSurvey(db, viewer, surveyId, now);
  if (!data?.targeted) throw new ForbiddenError("umfragen.answer");
  if (data.status !== "offen") throw new ValidationError({ survey: data.status === "geplant" ? "Die Umfrage hat noch nicht begonnen" : "Die Umfrage ist beendet" });
  const answers = checkAnswers(data.questions, raw);
  const respondentId = data.survey.anonymous ? null : viewer.userId;
  await db.transaction(async (tx) => {
    // Sperre teilt sich mit „Bearbeiten“: dort werden Fragen nur ersetzt, solange es sicher keine Antwort gibt
    await tx.select({ id: surveys.id }).from(surveys).where(eq(surveys.id, surveyId)).for("share");
    // Teilnahme zuerst: der Primärschlüssel verhindert doppelte Antworten auch bei gleichzeitigen Anfragen
    const inserted = await tx.insert(surveyParticipation).values({ surveyId, userId: viewer.userId }).onConflictDoNothing().returning();
    if (inserted.length === 0) throw new ValidationError({ survey: "Du hast an dieser Umfrage schon teilgenommen" });
    const [response] = await tx.insert(surveyResponses).values({ surveyId, respondentId, day: toBerlinDate(now) }).returning({ id: surveyResponses.id });
    if (answers.length) await tx.insert(surveyAnswers).values(answers.map((a) => ({ ...a, responseId: response!.id, respondentId })));
  });
}

export interface QuestionResult {
  id: string;
  kind: QuestionKind;
  text: string;
  answered: number;
  /** Auswahl: Anzahl je Option */
  options?: { label: string; count: number }[];
  /** Skala: Anzahl je Wert 1–5 und Mittelwert */
  scale?: { counts: number[]; average: number | null };
  /** Freitext (namentlich mit Namen), sortiert */
  texts?: { text: string; name?: string }[];
}

/** Auswertung für Autor:in und `umfragen.manage`; anonyme Umfragen unter MIN_ANONYMOUS Antworten ohne Ergebnisse. */
export async function results(db: Db, viewer: PermissionSet, surveyId: string, now = new Date()) {
  const data = await getSurvey(db, viewer, surveyId, now);
  if (!data?.canEdit) throw new ForbiddenError("umfragen.create");
  const [audience, participants] = await Promise.all([
    resolveAudience(db, surveyId),
    db.select({ id: surveyParticipation.userId }).from(surveyParticipation).where(eq(surveyParticipation.surveyId, surveyId)),
  ]);
  const anonymous = data.survey.anonymous;
  const counted = anonymous ? countedOf(data.responses) : data.responses;
  const base = {
    survey: data.survey,
    total: data.responses,
    counted,
    audience: audience.length,
    participants: participants.length,
    open: audience.filter((a) => a !== viewer.userId && !participants.some((p) => p.id === a)).length,
  };
  if (anonymous && counted === 0) return { ...base, hidden: true as const, questions: [] as QuestionResult[] };
  const ids = anonymous ? await countedResponseIds(db, surveyId, data.responses) : null;

  const rows = await db
    .select({ questionId: surveyAnswers.questionId, choices: surveyAnswers.choices, scale: surveyAnswers.scale, text: surveyAnswers.text, name: users.name })
    .from(surveyAnswers)
    .innerJoin(surveyResponses, eq(surveyResponses.id, surveyAnswers.responseId))
    .leftJoin(users, eq(users.id, surveyAnswers.respondentId))
    .where(ids ? inArray(surveyAnswers.responseId, ids) : eq(surveyResponses.surveyId, surveyId));
  const questions = data.questions.map((q): QuestionResult => {
    const mine = rows.filter((r) => r.questionId === q.id);
    const r: QuestionResult = { id: q.id, kind: q.kind, text: q.text, answered: mine.length };
    if (q.kind === "single" || q.kind === "multi") r.options = q.options.map((label, i) => ({ label, count: mine.filter((m) => m.choices?.includes(i)).length }));
    else if (q.kind === "scale") {
      const counts = [1, 2, 3, 4, 5].map((v) => mine.filter((m) => m.scale === v).length);
      const sum = mine.reduce((s, m) => s + (m.scale ?? 0), 0);
      r.scale = { counts, average: mine.length ? Math.round((sum / mine.length) * 10) / 10 : null };
    } else
      r.texts = mine
        .map((m) => ({ text: m.text ?? "", ...(data.survey.anonymous ? {} : { name: m.name ?? "Gelöschtes Konto" }) }))
        .sort((a, b) => collator.compare(a.text, b.text));
    return r;
  });
  return { ...base, hidden: false as const, questions };
}


/** CSV (Semikolon, UTF-8 mit BOM für Tabellenprogramme): je Antwort eine Zeile; namentlich mit Name und Tag. */
export async function resultsCsv(db: Db, viewer: PermissionSet, surveyId: string, now = new Date()): Promise<{ name: string; body: string }> {
  const res = await results(db, viewer, surveyId, now);
  if (res.hidden) throw new ValidationError({ survey: `Ergebnisse gibt es erst ab ${MIN_ANONYMOUS} Antworten` });
  const data = (await getSurvey(db, viewer, surveyId, now))!;
  const ids = data.survey.anonymous ? await countedResponseIds(db, surveyId, res.total) : null;
  const responses = await db
    .select({ id: surveyResponses.id, day: surveyResponses.day, name: users.name })
    .from(surveyResponses)
    .leftJoin(users, eq(users.id, surveyResponses.respondentId))
    .where(ids ? inArray(surveyResponses.id, ids) : eq(surveyResponses.surveyId, surveyId));
  const answers = responses.length
    ? await db
        .select()
        .from(surveyAnswers)
        .where(inArray(surveyAnswers.responseId, responses.map((r) => r.id)))
    : [];
  const named = !data.survey.anonymous;
  const header = [...(named ? ["Name", "Tag"] : []), ...data.questions.map((q) => q.text)];
  const lines = responses.map((r) => [
    ...(named ? [r.name ?? "Gelöschtes Konto", r.day] : []),
    ...data.questions.map((q) => {
      const a = answers.find((x) => x.responseId === r.id && x.questionId === q.id);
      if (!a) return "";
      if (a.choices) return a.choices.map((i) => q.options[i] ?? "?").join(", ");
      if (a.scale !== null) return String(a.scale);
      return a.text ?? "";
    }),
  ]);
  // anonym: sortiert, nicht in Eingangsreihenfolge
  if (!named) lines.sort((a, b) => collator.compare(a.join("\u0000"), b.join("\u0000")));
  const body = "﻿" + [header, ...lines].map((l) => l.map(csvCell).join(";")).join("\r\n") + "\r\n";
  const slug = data.survey.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "umfrage";
  return { name: `umfrage-${slug}.csv`, body };
}

/** Gong an alle, die noch nicht teilgenommen haben (Teilnahme-Tabelle – funktioniert auch bei anonymen Umfragen). */
export async function remindNonParticipants(db: Db, viewer: PermissionSet, surveyId: string, now = new Date()): Promise<number> {
  const data = await getSurvey(db, viewer, surveyId, now);
  if (!data?.canEdit) throw new ForbiddenError("umfragen.create");
  if (data.status !== "offen") throw new ValidationError({ survey: "Erinnern geht nur, solange die Umfrage offen ist" });
  const done = new Set(
    (await db.select({ id: surveyParticipation.userId }).from(surveyParticipation).where(eq(surveyParticipation.surveyId, surveyId))).map((r) => r.id),
  );
  const open = (await resolveAudience(db, surveyId)).filter((id) => !done.has(id) && id !== viewer.userId);
  if (open.length) {
    await notify(db, open, { moduleId: "umfragen", title: `Erinnerung: ${data.survey.title}`, body: "Die Umfrage wartet noch auf deine Antwort", href: `/umfragen/${surveyId}` });
  }
  await audit(db, viewer.userId, "umfragen.remind", surveyId, { count: open.length });
  return open.length;
}
