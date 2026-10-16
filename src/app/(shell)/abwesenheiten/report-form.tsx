"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

const ABSENCE_REASON_OPTIONS = [
  { value: "krank", label: "krank" },
  { value: "sonstiges", label: "sonstiger Grund" },
] as const;

export function ReportForm({
  action,
  students,
  today,
  submitLabel,
  successText,
  channel,
  reasons = ABSENCE_REASON_OPTIONS,
  hint = "Bitte keine Diagnose oder Details angeben – der Grund reicht für die Entschuldigung.",
  minDate,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  students: { id: string; label: string }[];
  today: string;
  submitLabel: string;
  successText: string;
  /** „telefon“: Sekretariatsweg (Status „gemeldet“, Gong an die Klassenleitung) */
  channel?: "telefon";
  /** Auswahl der Gründe (Beurlaubung Q5-16: eigene Liste) */
  reasons?: readonly { value: string; label: string }[];
  hint?: string;
  /** frühester wählbarer Tag (Beurlaubung: heute) */
  minDate?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v: Record<string, string> = { studentId: students.length === 1 ? students[0]!.id : "", fromDate: today, toDate: today, reason: reasons[0]!.value, ...state.values };
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state)} action={formAction} className="grid gap-4 sm:grid-cols-2">
      {channel && <input type="hidden" name="channel" value={channel} />}
      {students.length === 1 ? (
        <input type="hidden" name="studentId" value={students[0]!.id} />
      ) : (
        <Field label="Schüler:in" error={fe.studentId} className="sm:col-span-2">
          <Select name="studentId" defaultValue={v.studentId} required>
            <option value="">Bitte wählen</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Erster Tag" error={fe.fromDate}>
        <Input type="date" name="fromDate" defaultValue={v.fromDate} min={minDate} required />
      </Field>
      <Field label="Letzter Tag" error={fe.toDate}>
        <Input type="date" name="toDate" defaultValue={v.toDate} min={minDate} required />
      </Field>
      <fieldset className="flex flex-col gap-2 sm:col-span-2">
        <legend className="text-sm font-medium">Grund</legend>
        <div className="flex flex-wrap gap-4">
          {reasons.map((r) => (
            <label key={r.value} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="reason" value={r.value} defaultChecked={v.reason === r.value} className="size-4 accent-[var(--accent)]" /> {r.label}
            </label>
          ))}
        </div>
        <span className="text-xs text-muted">{hint}</span>
      </fieldset>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-2">
          {successText}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Senden …" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
