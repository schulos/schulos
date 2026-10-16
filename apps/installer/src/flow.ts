// Ablauf des Installers (INSTALLATION.md §1 Schritt 2): erst alle Fragen, dann Prüfung des Backupservers, dann die
// Zusammenfassung. Rein – die TUI (tui/) zeigt nur an und leitet Tasten weiter.
import { applies, checkValue, coerce, resolve } from "./answers";
import { QUESTION_BY_ID, QUESTIONS, type Answers, type InstallContext, type Question, type Value } from "./questions";

/** „alle“: jede Frage zeigen (vorbelegt) · „fehlende“: nur, was fehlt oder ungültig ist (mit schulos-install.yaml, nach Änderungen) */
export type Mode = "alle" | "fehlende";

export interface Step {
  question: Question;
  /** Antwort bzw. Vorgabe, mit der das Feld vorbelegt wird */
  value: Value | undefined;
}

/** Fragen in Reihenfolge, die bei diesen Antworten gelten – Vorgaben früherer Fragen zählen mit. */
export function visibleSteps(answers: Answers, ctx: InstallContext): Step[] {
  const merged: Answers = {};
  const out: Step[] = [];
  for (const q of QUESTIONS) {
    if (!applies(q, merged, ctx)) continue;
    const v = answers[q.id] ?? q.default?.(merged, ctx);
    out.push({ question: q, value: v });
    if (v !== undefined) merged[q.id] = v;
  }
  return out;
}

/** Nächste zu stellende Frage nach `afterId` (null = von vorn); null, wenn alle durch sind. */
export function nextStep(answers: Answers, ctx: InstallContext, mode: Mode, afterId: string | null): Step | null {
  const steps = visibleSteps(answers, ctx);
  const order = (id: string) => QUESTIONS.findIndex((q) => q.id === id);
  const start = afterId === null ? -1 : order(afterId);
  const r = mode === "fehlende" ? resolve(answers, ctx) : null;
  const open = r ? new Set([...r.missing, ...r.errors.map((e) => e.id)]) : null;
  return steps.find((s) => order(s.question.id) > start && (!open || open.has(s.question.id))) ?? null;
}

export type Submit = { ok: true; answers: Answers; warning: string | null } | { ok: false; error: string };

/** Eingabe zu einer Frage übernehmen: Typ, Prüfung im Zusammenhang der bisherigen Antworten, Hinweis. */
export function submitAnswer(q: Question, raw: Value, answers: Answers, ctx: InstallContext): Submit {
  const c = coerce(q, raw);
  if (!c.ok) return { ok: false, error: c.error };
  const v = c.value;
  const rest = { ...answers };
  delete rest[q.id];
  if (v === "" || (Array.isArray(v) && v.length === 0)) {
    if (q.optional) return { ok: true, answers: rest, warning: null };
    return { ok: false, error: q.kind === "disks" ? "Mindestens eine Platte wählen (Leertaste)" : "Bitte ausfüllen" };
  }
  // Zusammenhang: die gültigen früheren Antworten samt Vorgaben
  const before = resolve(rest, ctx).answers;
  const error = checkValue(q, v, before, ctx);
  if (error) return { ok: false, error };
  return { ok: true, answers: { ...rest, [q.id]: v }, warning: q.warn?.(v, before, ctx) ?? null };
}

/** Vor der Zusammenfassung: Backupserver erreichbar und Code gültig? (Hauptsystem mit „jetzt koppeln“ bzw. „aus Backup“) */
export function backupCheckFor(answers: Answers, ctx: InstallContext): { url: string; code: string } | null {
  const a = resolve(answers, ctx).answers;
  if (a.role !== "main" || (a["backup.mode"] !== "pair" && a.instance !== "restore-backup")) return null;
  const url = a["backup.url"];
  const code = a["backup.code"];
  return typeof url === "string" && typeof code === "string" ? { url, code } : null;
}

export function question(id: string): Question {
  const q = QUESTION_BY_ID.get(id);
  if (!q) throw new Error(`Unbekannte Frage ${id}`);
  return q;
}
