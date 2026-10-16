"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

export interface EventFormValues {
  calendar: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** „YYYY-MM-DDTHH:MM" */
  start: string;
  end: string;
  repeatUntil: string;
}

export function EventForm({
  action,
  calendars,
  initial,
  submitLabel,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  calendars: { key: string; label: string }[];
  initial: EventFormValues;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [allDay, setAllDay] = useState(initial.allDay);
  const [repeat, setRepeat] = useState(!!initial.repeatUntil);
  const fe = state.fieldErrors ?? {};
  // nach einem Fehler mit den eingegebenen Werten neu aufbauen (key) – React setzt das Formular sonst zurück (TD-02)
  const v = state.values;

  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <Field label="Titel" error={fe.title} className="sm:col-span-2">
        <Input name="title" defaultValue={v?.title ?? initial.title} required />
      </Field>
      <Field label="Kalender" error={fe.calendar}>
        <Select name="calendar" defaultValue={v?.calendar ?? initial.calendar}>
          {calendars.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ort">
        <Input name="location" defaultValue={v?.location ?? initial.location} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 sm:col-span-2">
        <input type="checkbox" name="allDay" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="size-4 accent-[var(--accent)]" /> Ganztägig
      </label>
      {allDay ? (
        <>
          <Field label="Erster Tag" error={fe.start}>
            <Input type="date" name="startDate" defaultValue={v?.startDate ?? initial.start.slice(0, 10)} required />
          </Field>
          <Field label="Letzter Tag" error={fe.end}>
            <Input type="date" name="endDate" defaultValue={v?.endDate ?? initial.end.slice(0, 10)} required />
          </Field>
        </>
      ) : (
        <>
          <Field label="Beginn" error={fe.start}>
            <Input type="datetime-local" name="start" defaultValue={v?.start ?? initial.start} required />
          </Field>
          <Field label="Ende" error={fe.end}>
            <Input type="datetime-local" name="end" defaultValue={v?.end ?? initial.end} required />
          </Field>
        </>
      )}
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" name="repeat" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} className="size-4 accent-[var(--accent)]" /> Jede Woche wiederholen
      </label>
      {repeat ? (
        <Field label="Wiederholen bis" error={fe.repeatWeeklyUntil}>
          <Input type="date" name="repeatUntil" defaultValue={v?.repeatUntil ?? initial.repeatUntil} required />
        </Field>
      ) : (
        <div />
      )}
      <Field label="Beschreibung" className="sm:col-span-2">
        <Textarea name="description" defaultValue={v?.description ?? initial.description} rows={4} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : submitLabel}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
