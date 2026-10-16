"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Option = { value: string; label: string };

export function AreaForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form key={JSON.stringify(state.values ?? null) + String(state.ok ?? "")} action={formAction} aria-label="Bereich anlegen" className="flex flex-wrap items-end gap-3">
      <Field label="Neuer Bereich" error={state.fieldErrors?.name} className="w-64">
        <Input name="name" maxLength={60} defaultValue={state.values?.name ?? ""} placeholder="z. B. Bushaltestelle" required />
      </Field>
      <Button type="submit" disabled={pending}>
        Bereich anlegen
      </Button>
    </form>
  );
}

export function DutyForm({ action, areas, weekdays, breaks, teachers }: { action: Action; areas: Option[]; weekdays: Option[]; breaks: Option[]; teachers: Option[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null) + String(state.ok ?? "")} action={formAction} aria-label="Aufsicht einteilen" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
      <Field label="Bereich" error={fe.areaId}>
        <Select name="areaId" defaultValue={v.areaId ?? ""} required>
          <option value="">Bereich wählen</option>
          {areas.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Tag" error={fe.weekday}>
        <Select name="weekday" defaultValue={v.weekday ?? ""} required>
          <option value="">Tag wählen</option>
          {weekdays.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Pause" error={fe.afterPeriod}>
        <Select name="afterPeriod" defaultValue={v.afterPeriod ?? ""} required>
          <option value="">Pause wählen</option>
          {breaks.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Lehrkraft" error={fe.teacherId}>
        <Select name="teacherId" defaultValue={v.teacherId ?? ""} required>
          <option value="">Lehrkraft wählen</option>
          {teachers.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="primary" disabled={pending}>
        Einteilen
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-5">
          {state.error}
        </p>
      )}
    </form>
  );
}
