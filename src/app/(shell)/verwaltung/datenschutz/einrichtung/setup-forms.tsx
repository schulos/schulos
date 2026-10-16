"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Select, Textarea } from "@schulos/ui/field";

function Result({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        Gespeichert.
      </p>
    );
  return null;
}

/** Schritt 1 (DS-12): Bestätigung als Verantwortliche. */
export function ConfirmForm({ action, text }: { action: (prev: FormState, form: FormData) => Promise<FormState>; text: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label="Bestätigung als Verantwortliche" className="flex flex-col gap-3">
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="confirm" className="mt-1 size-4 shrink-0" />
        <span>{text}</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          Bestätigen
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

/** Schritt 2 (DS-12): Status und Bemerkung zu einem Punkt der DSB-Checkliste. */
export function TopicForm({
  action,
  title,
  status,
  note,
  statuses,
  max,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  title: string;
  status: string;
  note: string;
  statuses: { value: string; label: string }[];
  max: number;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label={`Status: ${title}`} className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)_auto] md:items-end">
      <Field label="Status">
        <Select name="status" defaultValue={status}>
          <option value="offen">offen</option>
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Bemerkung" hint="z. B. Ergebnis der Rücksprache mit der DSB – keine Daten von Schüler:innen" error={state.fieldErrors?.note}>
        <Textarea name="note" defaultValue={note} rows={1} maxLength={max} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Speichern
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}
