"use client";

import { useActionState } from "react";
import type { FeedFormState } from "@/modules/kalender/abo-actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

/** Q5-15: Abo-Link anlegen; der Link erscheint genau einmal (gespeichert wird nur sein Hash). */
export function FeedForm({
  action,
  calendars,
  disabled,
}: {
  action: (prev: FeedFormState, form: FormData) => Promise<FeedFormState>;
  calendars: { key: string; label: string }[];
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} aria-label="Abo-Link anlegen" className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
        <Field label="Kalender" error={state.fieldErrors?.calendar}>
          <Select name="calendar" defaultValue="personal">
            {calendars.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bezeichnung" hint="z. B. „Handy“ – damit Sie den Link später wiederfinden" error={state.fieldErrors?.label}>
          <Input name="label" maxLength={60} required />
        </Field>
        <Button type="submit" variant="primary" disabled={pending || disabled}>
          Link anlegen
        </Button>
      </form>
      {state.error && !state.fieldErrors?.label && !state.fieldErrors?.calendar && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.url && (
        <div role="status" className="flex flex-col gap-2 rounded-card border border-border bg-surface-2 p-4 text-sm">
          <p className="font-medium">Abo-Link angelegt – jetzt kopieren, er wird nur dieses eine Mal angezeigt:</p>
          <Input readOnly value={state.url} aria-label="Abo-Link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
          <p className="text-muted">
            In der Kalender-App „Kalender abonnieren“ bzw. „Abonnement hinzufügen“ wählen und den Link einfügen. Wer den Link kennt, sieht die Termine
            dieses Kalenders – nicht weitergeben.
          </p>
        </div>
      )}
    </div>
  );
}
