"use client";

import { useActionState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { saveOfficeHoursAction, type OfficeHoursState } from "./actions";

export function OfficeHoursForm({ current, max }: { current: string; max: number }) {
  const [state, action, pending] = useActionState<OfficeHoursState, FormData>(saveOfficeHoursAction, {});
  return (
    <form key={JSON.stringify(state.values ?? null)} action={action} aria-label="Sprechzeiten und Raum" className="flex flex-col gap-3">
      <Field label="Sprechzeiten und Raum" hint="Erscheint im Adressbuch für Schüler:innen und Eltern, z. B. „Di + Do 9–12 Uhr, Raum A 0.14“. Leer = keine Angabe.">
        <Input name="officeHours" defaultValue={state.values?.officeHours ?? current} maxLength={max} autoComplete="off" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Speichern"}
        </Button>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            {state.ok}
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
