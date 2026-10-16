"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

interface Option {
  value: string;
  label: string;
}

export function ExamForm({
  action,
  groups,
  subjects,
  periods,
  canOverride,
  defaultDate,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  groups: (Option & { subjectId: string | null; course: boolean })[];
  subjects: Option[];
  periods: Option[];
  canOverride: boolean;
  defaultDate: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v: Record<string, string> = { kind: "klassenarbeit", periodFrom: "1", periodTo: "2", date: defaultDate, ...state.values };
  const [groupId, setGroupId] = useState(v.groupId ?? "");
  const group = groups.find((g) => g.value === groupId);
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state)} action={formAction} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Klasse/Kurs" error={fe.groupId}>
        <Select name="groupId" value={groupId} onChange={(e) => setGroupId(e.target.value)} required>
          <option value="">Bitte wählen</option>
          {groups.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Fach" error={fe.subjectId}>
        {/* Kurse haben ihr Fach schon – Vorbelegung, ändert sich mit der Gruppe */}
        <Select key={groupId} name="subjectId" defaultValue={v.subjectId ?? group?.subjectId ?? ""} required>
          <option value="">Fach wählen</option>
          {subjects.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Art" error={fe.kind}>
        <Select key={`k${groupId}`} name="kind" defaultValue={state.values?.kind ?? (group?.course ? "klausur" : "klassenarbeit")}>
          <option value="klassenarbeit">Klassenarbeit</option>
          <option value="klausur">Klausur</option>
          <option value="test">Test</option>
        </Select>
      </Field>
      <Field label="Bezeichnung" error={fe.title}>
        <Input name="title" defaultValue={v.title} placeholder="z. B. 2. Klassenarbeit" required />
      </Field>
      <Field label="Datum" error={fe.date} className="sm:col-span-2 lg:col-span-2">
        <Input type="date" name="date" defaultValue={v.date} required />
      </Field>
      <Field label="von Stunde" error={fe.periodFrom}>
        <Select name="periodFrom" defaultValue={v.periodFrom}>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="bis Stunde">
        <Select name="periodTo" defaultValue={v.periodTo}>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      {canOverride && (
        <label className="flex min-h-11 items-center gap-2 sm:col-span-full">
          <input type="checkbox" name="override" defaultChecked={v.override === "on"} className="size-4 accent-[var(--accent)]" /> Ausnahme von den Regeln genehmigen (höchstens 1 am Tag, 3 pro Woche)
        </label>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          Eingetragen – die Schüler:innen sind benachrichtigt.
        </p>
      )}
      <div className="sm:col-span-full">
        <Button type="submit" variant="primary" disabled={pending}>
          Arbeit eintragen
        </Button>
      </div>
    </form>
  );
}
