"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export interface BandFormValues {
  name: string;
  hours: string;
  doubleLessons: string;
}

/** SP2-01: Band anlegen/ändern – Name, Wochen- und Doppelstunden (gelten für alle Lehraufträge im Band). */
export function BandForm({ action, deleteAction, initial, back }: { action: Action; deleteAction?: () => Promise<void>; initial: BandFormValues; back: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v: Record<string, string> = { ...initial, ...state.values };
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
      <Field label="Name des Bands" hint="z. B. „Religion/Philosophie 7“ – keine Personen nennen" error={fe.name}>
        <Input name="name" maxLength={60} defaultValue={v.name} required />
      </Field>
      <Field label="Wochenstunden" error={fe.hours}>
        <Input type="number" name="hours" min={1} max={12} defaultValue={v.hours} required />
      </Field>
      <Field label="Doppelstunden je Woche" hint="0 = Einzelstunden" error={fe.doubleLessons}>
        <Input type="number" name="doubleLessons" min={0} max={6} defaultValue={v.doubleLessons} />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-3">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Band speichern"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={back}>Abbrechen</Link>
        </Button>
        {deleteAction && (
          <Button type="submit" formAction={deleteAction} formNoValidate variant="danger" className="ml-auto">
            Band löschen
          </Button>
        )}
      </div>
    </form>
  );
}

/** Lehrauftrag ins Band aufnehmen (er übernimmt Wochen- und Doppelstunden des Bands). */
export function BandMemberForm({ action, options }: { action: Action; options: { label: string; options: { value: string; label: string }[] }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <Field label="Lehrauftrag aufnehmen" hint="übernimmt Wochen- und Doppelstunden des Bands" error={state.fieldErrors?.assignmentId ?? state.fieldErrors?.bandId}>
        <Select name="assignmentId" defaultValue="" required>
          <option value="">Lehrauftrag wählen</option>
          {options.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>
        Aufnehmen
      </Button>
    </form>
  );
}
