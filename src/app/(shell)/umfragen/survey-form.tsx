"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useActionState, useState } from "react";
import type { Role } from "@/core/roles";
import type { FormState } from "@/modules/verwaltung/actions";
import type { QuestionKind } from "@/modules/umfragen/schema";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

const KINDS: { kind: QuestionKind; label: string }[] = [
  { kind: "single", label: "Einfachauswahl" },
  { kind: "multi", label: "Mehrfachauswahl" },
  { kind: "scale", label: "Skala 1–5" },
  { kind: "text", label: "Freitext" },
];
const TARGET_ROLES: { role: Role; label: string }[] = [
  { role: "schueler", label: "Schüler:innen" },
  { role: "lehrkraft", label: "Lehrkräfte" },
  { role: "eltern", label: "Eltern" },
  { role: "personal", label: "Personal" },
  { role: "beratung", label: "Beratung" },
  { role: "verwaltung", label: "Verwaltung" },
];

export interface QuestionDraft {
  kind: QuestionKind;
  text: string;
  options: string[];
  required: boolean;
}

export interface SurveyFormValues {
  title: string;
  description: string;
  anonymous: boolean;
  opensAt: string;
  closesAt: string;
  roles: Role[];
  groups: { groupId: string; parents: boolean }[];
  questions: QuestionDraft[];
}

const newQuestion = (kind: QuestionKind = "single"): QuestionDraft => ({ kind, text: "", options: kind === "single" || kind === "multi" ? ["", ""] : [], required: true });

/**
 * Baukasten für Umfragen. Alle Felder sind kontrolliert (useState): React 19 setzt Formulare nach einer Server Action
 * zurück, kontrollierter Zustand bleibt dabei erhalten – so gehen nach einem Validierungsfehler keine Fragen verloren.
 */
export function SurveyForm({
  action,
  initial,
  groups,
  submitLabel,
  showNotify,
  questionsLocked,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial: SurveyFormValues;
  groups: { id: string; name: string }[];
  submitLabel: string;
  showNotify: boolean;
  /** Es gibt schon Antworten: Fragen und anonym/namentlich bleiben fest */
  questionsLocked: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [v, setV] = useState(initial);
  const [notify, setNotify] = useState(true);
  const fe = state.fieldErrors ?? {};
  const set = <K extends keyof SurveyFormValues>(k: K, val: SurveyFormValues[K]) => setV((cur) => ({ ...cur, [k]: val }));
  const setQ = (i: number, q: Partial<QuestionDraft>) => set("questions", v.questions.map((x, j) => (j === i ? { ...x, ...q } : x)));
  const move = (i: number, d: -1 | 1) => {
    const qs = [...v.questions];
    [qs[i], qs[i + d]] = [qs[i + d]!, qs[i]!];
    set("questions", qs);
  };
  const nameOf = (id: string) => groups.find((g) => g.id === id)?.name ?? id;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Field label="Titel" error={fe.title}>
        <Input name="title" value={v.title} onChange={(e) => set("title", e.target.value)} maxLength={140} required />
      </Field>
      <Field label="Beschreibung" hint="Optional, Markdown" error={fe.description}>
        <Textarea name="description" value={v.description} onChange={(e) => set("description", e.target.value)} rows={3} />
      </Field>

      <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-4" disabled={questionsLocked}>
        <legend className="px-1 text-sm font-medium">Antworten</legend>
        <label className="flex min-h-10 items-start gap-2">
          <input type="radio" name="anonymous" value="anonym" checked={v.anonymous} onChange={() => set("anonymous", true)} className="mt-1 size-4 accent-[var(--accent)]" />
          <span>
            <span className="font-medium">Anonym</span>
            <span className="block text-sm text-muted">Antworten ohne Namen und nur mit Datum gespeichert; Ergebnisse erst ab 5 Antworten.</span>
          </span>
        </label>
        <label className="flex min-h-10 items-start gap-2">
          <input type="radio" name="anonymous" value="named" checked={!v.anonymous} onChange={() => set("anonymous", false)} className="mt-1 size-4 accent-[var(--accent)]" />
          <span>
            <span className="font-medium">Namentlich</span>
            <span className="block text-sm text-muted">Du siehst, wer wie geantwortet hat.</span>
          </span>
        </label>
        {questionsLocked && <input type="hidden" name="anonymous" value={v.anonymous ? "anonym" : "named"} />}
        {fe.anonymous && <p className="text-sm text-danger">{fe.anonymous}</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Beginn" error={fe.opensAt}>
          <Input type="datetime-local" name="opensAt" value={v.opensAt} onChange={(e) => set("opensAt", e.target.value)} required />
        </Field>
        <Field label="Ende" error={fe.closesAt}>
          <Input type="datetime-local" name="closesAt" value={v.closesAt} onChange={(e) => set("closesAt", e.target.value)} required />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Für wen?</legend>
        <div className="flex flex-wrap gap-2">
          {TARGET_ROLES.map(({ role, label }) => {
            const on = v.roles.includes(role);
            return (
              <label key={role} className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 has-checked:border-accent has-checked:bg-accent-soft">
                <input
                  type="checkbox"
                  name="targetRole"
                  value={role}
                  checked={on}
                  onChange={() => set("roles", on ? v.roles.filter((x) => x !== role) : [...v.roles, role])}
                  className="size-4 accent-[var(--accent)]"
                />
                alle {label}
              </label>
            );
          })}
        </div>
        <Select
          aria-label="Gruppe hinzufügen"
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && !v.groups.some((g) => g.groupId === id && !g.parents)) set("groups", [...v.groups, { groupId: id, parents: false }]);
          }}
        >
          <option value="">Gruppe hinzufügen …</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        {v.groups.length > 0 && (
          <ul className="flex flex-col gap-2">
            {v.groups.map((g, i) => (
              <li key={`${g.groupId}:${g.parents}`} className="flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft py-1 pr-1 pl-3 text-sm text-accent-ink">
                <input type="hidden" name="targetGroup" value={g.parents ? `${g.groupId}:eltern` : g.groupId} />
                <span className="font-medium">{nameOf(g.groupId)}</span>
                <Select
                  aria-label={`Wer in ${nameOf(g.groupId)}?`}
                  value={g.parents ? "eltern" : "mitglieder"}
                  onChange={(e) => set("groups", v.groups.map((x, j) => (j === i ? { ...x, parents: e.target.value === "eltern" } : x)))}
                  className="h-9 w-auto"
                >
                  <option value="mitglieder">Mitglieder</option>
                  <option value="eltern">Eltern der Schüler:innen</option>
                </Select>
                <button
                  type="button"
                  aria-label={`${nameOf(g.groupId)} entfernen`}
                  className="ml-auto grid size-8 place-items-center rounded-full hover:bg-surface"
                  onClick={() => set("groups", v.groups.filter((_, j) => j !== i))}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {fe.targets && <p className="text-sm text-danger">{fe.targets}</p>}
      </fieldset>

      <section aria-labelledby="fragen" className="flex flex-col gap-3">
        <h2 id="fragen" className="text-base font-semibold">
          Fragen
        </h2>
        {questionsLocked && <p className="text-sm text-muted">Es gibt schon Antworten – die Fragen lassen sich nicht mehr ändern.</p>}
        <input type="hidden" name="questions" value={JSON.stringify(v.questions)} />
        <ol className="flex flex-col gap-3">
          {v.questions.map((q, i) => (
            <li key={i}>
              <fieldset disabled={questionsLocked} aria-label={`Frage ${i + 1}`} className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={`Frage ${i + 1}`} className="min-w-0 flex-1">
                    <Input value={q.text} onChange={(e) => setQ(i, { text: e.target.value })} maxLength={500} />
                  </Field>
                  <Field label="Art">
                    <Select
                      value={q.kind}
                      onChange={(e) => {
                        const kind = e.target.value as QuestionKind;
                        const choice = kind === "single" || kind === "multi";
                        setQ(i, { kind, options: choice ? (q.options.length >= 2 ? q.options : ["", ""]) : [] });
                      }}
                    >
                      {KINDS.map((k) => (
                        <option key={k.kind} value={k.kind}>
                          {k.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {(q.kind === "single" || q.kind === "multi") && (
                  <ul className="flex flex-col gap-2">
                    {q.options.map((o, j) => (
                      <li key={j} className="flex items-center gap-2">
                        <Input
                          aria-label={`Frage ${i + 1}, Antwort ${j + 1}`}
                          value={o}
                          onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })}
                          maxLength={200}
                        />
                        <Button type="button" variant="ghost" size="sm" aria-label={`Antwort ${j + 1} entfernen`} onClick={() => setQ(i, { options: q.options.filter((_, k) => k !== j) })}>
                          <X aria-hidden />
                        </Button>
                      </li>
                    ))}
                    <li>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setQ(i, { options: [...q.options, ""] })}>
                        <Plus aria-hidden /> Antwort
                      </Button>
                    </li>
                  </ul>
                )}
                {q.kind === "scale" && <p className="text-sm text-muted">1 = gar nicht … 5 = voll und ganz</p>}
                {q.kind === "text" && v.anonymous && <p className="text-sm text-muted">Hinweis für Teilnehmende: „Bitte keine Namen nennen.“</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <label className="mr-auto flex min-h-10 items-center gap-2 text-sm">
                    <input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} className="size-4 accent-[var(--accent)]" /> Pflichtfrage
                  </label>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Frage ${i + 1} nach oben`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Frage ${i + 1} nach unten`} disabled={i === v.questions.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Frage ${i + 1} entfernen`} onClick={() => set("questions", v.questions.filter((_, j) => j !== i))}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
        {!questionsLocked && (
          <div>
            <Button type="button" onClick={() => set("questions", [...v.questions, newQuestion()])}>
              <Plus aria-hidden /> Frage hinzufügen
            </Button>
          </div>
        )}
        {fe.questions && (
          <p role="alert" className="text-sm text-danger">
            {fe.questions}
          </p>
        )}
      </section>

      {showNotify && (
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" name="notify" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-4 accent-[var(--accent)]" /> Zielgruppe per Gong benachrichtigen
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : submitLabel}
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
