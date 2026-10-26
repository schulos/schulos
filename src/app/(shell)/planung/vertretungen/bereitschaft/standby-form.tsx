"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";

type Option = { value: string; label: string };

/** SP2-07: Bereitschaft eintragen (Lehrkraft, Wochentag, Stunde). */
export function StandbyForm({
  action,
  schoolYearId,
  teachers,
  weekdays,
  periods,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  schoolYearId: string;
  teachers: Option[];
  weekdays: Option[];
  periods: Option[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Bereitschaft eintragen" className="grid gap-3 sm:grid-cols-[1fr_10rem_10rem_auto] sm:items-end">
      <input type="hidden" name="schoolYearId" value={schoolYearId} />
      <Field label="Lehrkraft" error={fe.teacherId}>
        <Select name="teacherId" defaultValue={v.teacherId ?? ""} required>
          <option value="">Lehrkraft wählen</option>
          {teachers.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Wochentag" error={fe.weekday}>
        <Select name="weekday" defaultValue={v.weekday ?? "0"}>
          {weekdays.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Stunde" error={fe.periodNr}>
        <Select name="periodNr" defaultValue={v.periodNr ?? periods[0]?.value}>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Eintragen …" : "Eintragen"}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          Bereitschaft eingetragen.
        </p>
      )}
    </form>
  );
}
