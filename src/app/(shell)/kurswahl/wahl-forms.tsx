"use client";

import { useActionState } from "react";
import { listAfter } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Option = { value: string; label: string };

const rank = (i: number) => ["1. Wunsch", "2. Wunsch", "3. Wunsch"][i] ?? `${i + 1}. Wunsch`;

/** Feldname der Wünsche je Platz: 1. Platz „choice“ (wie bisher), weitere „choice-2“ … (P4-67) */
export const choiceField = (place: number) => (place === 1 ? "choice" : `choice-${place}`);

/**
 * Wünsche wählen (1.–3. Priorität). Mit `students` trägt die Verwaltung für eine Person ein (Wahlbogen auf Papier).
 * P4-67 Mehrfachwahl: `courses` = Mindest-/Höchstzahl der Kurse – je Kurs ein Block mit eigenen Wünschen; Kurse über der
 * Mindestzahl dürfen leer bleiben.
 */
export function ChoiceForm({
  action,
  need,
  offers,
  initial,
  submitLabel,
  label,
  students,
  courses = { min: 1, max: 1 },
  initialPlaces,
}: {
  action: Action;
  need: number;
  offers: Option[];
  initial: string[];
  submitLabel: string;
  label: string;
  students?: Option[];
  courses?: { min: number; max: number };
  /** P4-67: Wünsche aller Plätze (1. zuerst); ohne Angabe nur `initial` für den 1. Platz */
  initialPlaces?: string[][];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const start = initialPlaces ?? [initial];
  const chosenAt = (place: number) => (state.ok ? (start[place - 1] ?? []) : listAfter(state.values, choiceField(place), start[place - 1] ?? []));
  const chosen = chosenAt(1);
  const wishes = (place: number, required: boolean) =>
    Array.from({ length: need }, (_, i) => (
      <Field key={i} label={rank(i)}>
        <Select name={choiceField(place)} defaultValue={chosenAt(place)[i] ?? ""} required={required}>
          <option value="">{required ? "Bitte wählen" : "– kein weiterer Kurs –"}</option>
          {offers.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    ));
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label={label} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {students && (
          <Field label="Schüler:in" error={state.fieldErrors?.studentId} className="sm:col-span-full">
            <Select name="studentId" defaultValue={state.ok ? "" : (state.values?.studentId ?? "")} required>
              <option value="">Bitte wählen</option>
              {students.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {courses.max === 1 &&
          Array.from({ length: need }, (_, i) => (
            <Field key={i} label={rank(i)}>
              <Select name="choice" defaultValue={chosen[i] ?? ""} required>
                <option value="">Bitte wählen</option>
                {offers.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
      </div>
      {courses.max > 1 && (
        <>
          <p className="text-sm text-muted">
            {courses.min === courses.max ? `Wähle ${courses.max} Kurse` : `Wähle ${courses.min} bis ${courses.max} Kurse`} – für jeden Kurs eigene Wünsche. Du bekommst
            keinen Kurs doppelt.
          </p>
          {Array.from({ length: courses.max }, (_, p) => (
            <fieldset key={p} aria-label={`Kurs ${p + 1}`} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-3">
              <legend className="px-1 text-sm font-medium">
                Kurs {p + 1}
                {p + 1 > courses.min && <span className="font-normal text-muted"> (freiwillig)</span>}
              </legend>
              {wishes(p + 1, p + 1 <= courses.min)}
            </fieldset>
          ))}
        </>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Gespeichert – die Wahl ist abgegeben.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Ein Knopf, der eine Action ohne Felder auslöst (Bestätigen, Erinnern) und das Ergebnis anzeigt; „%n“ im Text = values.sent. */
export function ActionButton({ action, label, doneText, variant = "primary" }: { action: (prev: FormState) => Promise<FormState>; label: string; doneText: string; variant?: "primary" | "secondary" }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {label}
      </Button>
      {state.ok && (
        <p role="status" className="text-sm text-success">
          {doneText.replace("%n", state.values?.sent ?? "")}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
