"use client";

import { Zap } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import type { PollState } from "@/core/notifications/bus";
import { answerQuickPollAction, endQuickPollAction, startQuickPollAction } from "@/modules/umfragen/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Field, Input, Select } from "@schulos/ui/field";
import { Progress } from "@schulos/ui/misc";
import { useLive } from "../_shell/live";

export type QuickPoll = PollState & { answered: boolean; canEnd: boolean };

const MINUTES = [1, 2, 5, 10, 15, 30, 60];
const MIN = 5;
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

function StartForm({ groupId }: { groupId: string }) {
  const [state, formAction, pending] = useActionState(startQuickPollAction.bind(null, groupId), {} as FormState);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["Ja", "Nein", "", ""]);
  const [minutes, setMinutes] = useState("5");
  const fe = state.fieldErrors ?? {};
  return (
    <details className="rounded-xl border border-border px-3 py-2">
      <summary className="cursor-pointer py-1 font-medium">Schnellumfrage starten</summary>
      <form action={formAction} className="flex flex-col gap-3 pt-2">
        <Field label="Frage" error={fe.question}>
          <Input name="question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} required />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Antwortknöpfe</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((o, i) => (
              <Input key={i} name="option" aria-label={`Antwort ${i + 1}`} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} maxLength={60} />
            ))}
          </div>
          {fe.options && <p className="text-sm text-danger">{fe.options}</p>}
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Dauer">
            <Select name="minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} {m === 1 ? "Minute" : "Minuten"}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={pending}>
            <Zap aria-hidden /> Starten
          </Button>
        </div>
        <p className="text-xs text-muted">Immer anonym; die Verteilung erscheint ab {MIN} Antworten.</p>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </form>
    </details>
  );
}

function Poll({ poll, onAnswered }: { poll: QuickPoll; onAnswered: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Wer die Umfrage beenden darf (Leitung/Personal), verfolgt das Ergebnis und stimmt nicht mit ab
  const answerable = poll.open && !poll.answered && !poll.canEnd;
  return (
    <section aria-label={`Schnellumfrage: ${poll.question}`} className="flex flex-col gap-3 rounded-xl border border-accent bg-accent-soft/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{poll.question}</p>
        <p className="text-xs text-muted" role="status">
          {poll.total} {poll.total === 1 ? "Antwort" : "Antworten"} · {poll.open ? `bis ${timeFmt.format(new Date(poll.closesAt))}` : "beendet"}
        </p>
      </div>
      {answerable ? (
        <div className="flex flex-wrap gap-2">
          {poll.options.map((o, i) => (
            <Button
              key={i}
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const err = await answerQuickPollAction(poll.id, i);
                  if (err) setError(err);
                  else onAnswered();
                })
              }
            >
              {o}
            </Button>
          ))}
        </div>
      ) : poll.counts ? (
        <ul className="flex flex-col gap-2">
          {poll.options.map((o, i) => {
            const c = poll.counts![i] ?? 0;
            const pct = poll.counted ? Math.round((c / poll.counted) * 100) : 0;
            return (
              <li key={i} className="flex flex-col gap-1">
                <span className="flex justify-between gap-2 text-sm">
                  <span>{o}</span>
                  <span className="text-muted tabular-nums">
                    {c} · {pct} %
                  </span>
                </span>
                <Progress value={pct} label={`${o}: ${c} von ${poll.counted}`} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {poll.answered ? "Danke! " : ""}Das Ergebnis erscheint ab {MIN} Antworten.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {poll.open && poll.canEnd && (
        <div>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => start(() => endQuickPollAction(poll.id))}>
            Beenden
          </Button>
        </div>
      )}
    </section>
  );
}

/** Schnellumfragen einer Gruppe – im Kursraum und im Gruppenchat, live über den SSE-Kanal. */
export function QuickPolls({
  groupId,
  initial,
  canStart,
  className,
  empty,
}: {
  groupId: string;
  initial: QuickPoll[];
  canStart: boolean;
  className?: string;
  /** Anzeige, solange nichts läuft (sonst nichts) */
  empty?: React.ReactNode;
}) {
  const [polls, setPolls] = useState(initial);
  useLive((m) => {
    if (m.type !== "poll" || m.poll.groupId !== groupId) return;
    setPolls((cur) => {
      const old = cur.find((p) => p.id === m.poll.id);
      const next: QuickPoll = { ...m.poll, answered: old?.answered ?? false, canEnd: old?.canEnd ?? canStart };
      return old ? cur.map((p) => (p.id === next.id ? next : p)) : [...cur, next];
    });
  });
  // bleibt eingebunden, auch wenn gerade nichts läuft – eine live gestartete Umfrage erscheint dann sofort
  if (polls.length === 0 && !canStart) return empty ?? null;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {polls.map((p) => (
        <Poll key={p.id} poll={p} onAnswered={() => setPolls((cur) => cur.map((x) => (x.id === p.id ? { ...x, answered: true } : x)))} />
      ))}
      {canStart && <StartForm key={polls.length} groupId={groupId} />}
    </div>
  );
}
