"use client";

import { useActionState, useState } from "react";
import type { QuestionKind } from "@/modules/umfragen/schema";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Textarea } from "@schulos/ui/field";

interface Question {
  id: string;
  kind: QuestionKind;
  text: string;
  options: string[];
  required: boolean;
}

const SCALE = ["gar nicht", "wenig", "teils", "eher", "voll und ganz"];

/** Teilnahme an einer Umfrage. Zustand kontrolliert, damit nach einem Fehler nichts verloren geht (React 19 setzt Formulare zurück). */
export function AnswerForm({ action, questions, anonymous }: { action: (prev: FormState, form: FormData) => Promise<FormState>; questions: Question[]; anonymous: boolean }) {
  const [state, formAction, pending] = useActionState(action, {});
  const [choices, setChoices] = useState<Record<string, number[]>>({});
  const [scales, setScales] = useState<Record<string, number>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const fe = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {anonymous && (
        <p className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Diese Umfrage ist anonym: Deine Antworten werden ohne deinen Namen und nur mit dem Datum gespeichert. Gespeichert wird getrennt nur, dass du teilgenommen hast.
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {questions.map((q, i) => {
          const error = fe[`q:${q.id}`];
          const legend = `${i + 1}. ${q.text}`;
          return (
            <li key={q.id}>
              <fieldset aria-invalid={error ? true : undefined} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4 aria-[invalid=true]:border-danger">
                <legend className="sr-only">{legend}</legend>
                <p aria-hidden className="font-medium">
                  {legend}
                  {!q.required && <span className="font-normal text-muted"> (freiwillig)</span>}
                </p>
                {(q.kind === "single" || q.kind === "multi") &&
                  q.options.map((o, j) => {
                    const on = (choices[q.id] ?? []).includes(j);
                    return (
                      <label key={j} className="flex min-h-10 cursor-pointer items-center gap-2">
                        <input
                          type={q.kind === "single" ? "radio" : "checkbox"}
                          name={`c:${q.id}`}
                          value={j}
                          checked={on}
                          onChange={() =>
                            setChoices((cur) => {
                              const list = cur[q.id] ?? [];
                              return { ...cur, [q.id]: q.kind === "single" ? [j] : on ? list.filter((x) => x !== j) : [...list, j] };
                            })
                          }
                          className="size-4 accent-[var(--accent)]"
                        />
                        {o}
                      </label>
                    );
                  })}
                {q.kind === "scale" && (
                  <div className="flex flex-wrap gap-2">
                    {[1, 2, 3, 4, 5].map((v) => (
                      <label key={v} className="flex min-h-11 min-w-16 cursor-pointer flex-col items-center justify-center rounded-xl border border-border px-2 py-1 has-checked:border-accent has-checked:bg-accent-soft">
                        <input type="radio" name={`s:${q.id}`} value={v} checked={scales[q.id] === v} onChange={() => setScales((cur) => ({ ...cur, [q.id]: v }))} className="sr-only" />
                        <span className="font-semibold">{v}</span>
                        <span className="text-xs text-muted">{SCALE[v - 1]}</span>
                      </label>
                    ))}
                  </div>
                )}
                {q.kind === "text" && (
                  <>
                    <Textarea name={`t:${q.id}`} aria-label={q.text} value={texts[q.id] ?? ""} onChange={(e) => setTexts((cur) => ({ ...cur, [q.id]: e.target.value }))} maxLength={2000} rows={3} />
                    {anonymous && <p className="text-xs text-muted">Bitte keine Namen nennen.</p>}
                  </>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Senden …" : "Antworten senden"}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
