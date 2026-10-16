"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Textarea } from "@schulos/ui/field";

export interface TextField {
  key: string;
  label: string;
  hint: string;
  max: number;
  value: string;
}

/** Angaben der Schule für Datenschutzhinweise und VVT. */
export function TextsForm({ action, fields }: { action: (prev: FormState, form: FormData) => Promise<FormState>; fields: TextField[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form action={formAction} aria-label="Angaben der Schule" className="flex flex-col gap-4">
      {fields.map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint} error={fe[f.key]}>
          <Textarea name={f.key} defaultValue={v[f.key] ?? f.value} rows={f.key === "extra" ? 8 : 3} maxLength={f.max} />
        </Field>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          Speichern
        </Button>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
