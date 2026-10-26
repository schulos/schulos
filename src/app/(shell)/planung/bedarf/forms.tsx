"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import type { GradeForecast } from "@/modules/stundenplan/fachbedarf";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

interface Option {
  value: string;
  label: string;
}

/** SP2-12: Klassenzahl je Jahrgang im nächsten Schuljahr – leer = Vorschlag „rücken auf“. */
export function ForecastGradesForm({ action, grades }: { action: Action; grades: GradeForecast[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form key={grades.map((g) => `${g.grade}:${g.custom ?? ""}`).join("|")} action={formAction} aria-label="Klassen je Jahrgang" className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {grades.map((g) => (
          <Field key={g.grade} label={`Jahrgang ${g.grade}`} hint={`heute ${g.current}, Vorschlag ${g.suggested}`} error={fe[`g${g.grade}`]}>
            <Input name={`g${g.grade}`} type="number" min={0} max={30} step={1} placeholder={String(g.suggested)} defaultValue={state.values?.[`g${g.grade}`] ?? g.custom?.toString() ?? ""} />
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Klassenzahlen speichern
        </Button>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
        {state.error && !Object.keys(fe).length && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

/** SP2-12: Abgang (Lehrkraft) oder Zugang (Fächer) – Datum + Stunden, ohne Begründung. */
export function StaffChangeForm({ action, teachers, subjects, defaultDate }: { action: Action; teachers: Option[]; subjects: Option[]; defaultDate: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const [kind, setKind] = useState(v.kind ?? "abgang");
  return (
    <form key={JSON.stringify(state.values ?? null) + String(state.ok ?? "")} action={formAction} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr_1fr_auto]">
        <Field label="Art" error={fe.kind}>
          <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="abgang">Abgang</option>
            <option value="zugang">Zugang</option>
          </Select>
        </Field>
        {kind === "abgang" ? (
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
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Fächer der neuen Lehrkraft</span>
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
              <legend className="sr-only">Fächer der neuen Lehrkraft</legend>
              {subjects.map((s) => (
                <label key={s.value} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="subjectIds" value={s.value} className="size-4 accent-[var(--accent)]" />
                  {s.label}
                </label>
              ))}
            </fieldset>
            {fe.subjectIds && <span className="text-xs text-danger">{fe.subjectIds}</span>}
          </div>
        )}
        <Field label="ab" error={fe.effectiveOn}>
          <Input type="date" name="effectiveOn" defaultValue={v.effectiveOn ?? defaultDate} required />
        </Field>
        <Field label="Stunden" hint={kind === "abgang" ? "die wegfallen" : "Deputat"} error={fe.hours}>
          <Input name="hours" inputMode="decimal" defaultValue={v.hours ?? ""} required />
        </Field>
        <FieldActions>
          <Button type="submit" disabled={pending}>
            Eintragen
          </Button>
        </FieldActions>
      </div>
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Eingetragen.
        </p>
      )}
    </form>
  );
}
