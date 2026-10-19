"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

/** Q5-10: Eingabefenster für Lehrkräfte (erster und letzter Tag). */
export function WindowForm({ action, opensOn, closesOn }: { action: (prev: FormState, form: FormData) => Promise<FormState>; opensOn: string; closesOn: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Eingabefenster" className="grid gap-3 sm:grid-cols-[12rem_12rem_auto] sm:items-end">
      <Field label="Erster Tag" error={fe.opensOn}>
        <Input type="date" name="opensOn" defaultValue={v.opensOn ?? opensOn} required />
      </Field>
      <Field label="Letzter Tag" error={fe.closesOn}>
        <Input type="date" name="closesOn" defaultValue={v.closesOn ?? closesOn} required />
      </Field>
      <Button type="submit" variant="primary" disabled={pending}>
        Fenster speichern
      </Button>
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-3">
          Gespeichert. Beginnt das Fenster heute, haben alle Lehrkräfte einen Gong bekommen.
        </p>
      )}
      {state.error && !Object.keys(fe).length && (
        <p role="alert" className="text-sm text-danger sm:col-span-3">
          {state.error}
        </p>
      )}
    </form>
  );
}
