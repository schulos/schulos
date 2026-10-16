"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

/** Löschsperre für eine Person (Benutzername) oder eine Gruppe. */
export function HoldForm({
  action,
  groups,
  until,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  groups: { value: string; label: string }[];
  until: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form
      key={JSON.stringify(state.values ?? null) + String(state.ok ?? "")}
      action={formAction}
      aria-label="Löschsperre anlegen"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_10rem_auto] lg:items-end"
    >
      <Field label="Person (Benutzername)" error={fe.username ?? fe.target}>
        <Input name="username" defaultValue={v.username ?? ""} placeholder="z. B. lea.schaefer" />
      </Field>
      <Field label="oder Gruppe">
        <Select name="groupId" defaultValue={v.groupId ?? ""}>
          <option value="">–</option>
          {groups.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Begründung" hint="z. B. Widerspruchsverfahren, Rechtsstreit" error={fe.reason}>
        <Input name="reason" maxLength={200} defaultValue={v.reason ?? ""} required />
      </Field>
      <Field label="Gilt bis" error={fe.until}>
        <Input type="date" name="until" defaultValue={v.until ?? until} required />
      </Field>
      <Button type="submit" disabled={pending}>
        Sperre anlegen
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-5">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-2 lg:col-span-5">
          Sperre angelegt.
        </p>
      )}
    </form>
  );
}
