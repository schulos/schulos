"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Option = { value: string; label: string };

/** Raum sperren: Zeitraum, optional nur einzelne Stunden, Grund. */
export function RoomBlockForm({
  action,
  rooms,
  periods,
  reasons,
  today,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  rooms: Option[];
  periods: Option[];
  reasons: Option[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form
      key={JSON.stringify(state.values ?? null) + String(state.ok ?? "")}
      action={formAction}
      aria-label="Raum sperren"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
    >
      <Field label="Raum" error={fe.roomId}>
        <Select name="roomId" defaultValue={v.roomId ?? ""} required>
          <option value="">Raum wählen</option>
          {rooms.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="von Tag" error={fe.startsOn}>
        <Input type="date" name="startsOn" defaultValue={v.startsOn ?? today} required />
      </Field>
      <Field label="bis Tag" hint="leer = nur ein Tag" error={fe.endsOn}>
        <Input type="date" name="endsOn" defaultValue={v.endsOn ?? ""} />
      </Field>
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
      <Field label="ab Stunde" hint="leer = ganzer Tag" error={fe.fromPeriod}>
        <Select name="fromPeriod" defaultValue={v.fromPeriod ?? ""}>
          <option value="">ganzer Tag</option>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="bis Stunde" error={fe.toPeriod}>
        <Select name="toPeriod" defaultValue={v.toPeriod ?? ""}>
          <option value="">ganzer Tag</option>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ergänzung" error={fe.note}>
        <Input name="note" maxLength={80} defaultValue={v.note ?? ""} placeholder="z. B. Abiturklausur Mathe" />
      </Field>
      <Button type="submit" variant="primary" disabled={pending}>
        Raum sperren
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-4">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-2 lg:col-span-4">
          Raum gesperrt.
        </p>
      )}
    </form>
  );
}
