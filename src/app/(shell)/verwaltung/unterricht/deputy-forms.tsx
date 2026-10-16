"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function ObligationForm({ action, value, fallback }: { action: Action; value: string; fallback: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values?.obligation ?? value;
  return (
    // key über den gespeicherten Wert: React 19 setzt Formulare nach der Action zurück
    <form key={`${value}|${JSON.stringify(state.values ?? null)}`} action={formAction} className="flex flex-wrap items-end gap-3">
      <Field label="Pflichtstunden" hint={`leer = Vorgabe der Schulform (${fallback})`} error={state.fieldErrors?.obligation} className="w-56">
        <Input name="obligation" inputMode="decimal" defaultValue={v} placeholder={fallback} />
      </Field>
      <Button type="submit" disabled={pending}>
        Pflichtstunden speichern
      </Button>
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Gespeichert.
        </p>
      )}
    </form>
  );
}

export function ReductionForm({ action, reasons }: { action: Action; reasons: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end">
      <Field label="Grund" error={fe.reason}>
        <Select name="reason" defaultValue={v.reason ?? ""} required>
          <option value="">Grund wählen</option>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Stunden" error={fe.hours}>
        <Input name="hours" inputMode="decimal" defaultValue={v.hours ?? ""} required />
      </Field>
      <Field label="Ergänzung" hint="keine Gesundheitsangaben" error={fe.note}>
        <Input name="note" maxLength={80} defaultValue={v.note ?? ""} />
      </Field>
      <Button type="submit" disabled={pending}>
        Hinzufügen
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-4">
          {state.error}
        </p>
      )}
    </form>
  );
}
