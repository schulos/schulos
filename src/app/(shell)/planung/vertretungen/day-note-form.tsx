"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

/** VT-01: Tagesmitteilung anlegen – kurzer Text ohne Personen, an alle oder nur an Beschäftigte. */
export function DayNoteForm({ action, date }: { action: (prev: FormState, form: FormData) => Promise<FormState>; date: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Tagesmitteilung hinzufügen" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="date" value={date} />
      <Field label="Mitteilung" error={fe.body} className="min-w-64 flex-1">
        <Input name="body" key={state.ok ? "leer" : "eingabe"} defaultValue={state.ok ? "" : state.values?.body} placeholder="z. B. 6. Stunde Schulversammlung in der Aula – keine Personen nennen" maxLength={300} required />
      </Field>
      <Field label="Für" error={fe.audience}>
        <Select name="audience" defaultValue={state.values?.audience ?? "alle"}>
          <option value="alle">alle</option>
          <option value="beschaeftigte">nur Beschäftigte</option>
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Speichern …" : "Hinzufügen"}
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
