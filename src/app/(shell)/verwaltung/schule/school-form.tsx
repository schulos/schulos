"use client";

import { useActionState, useState } from "react";
import { formInfo, formsForState, gradeTemplate, isSchoolForm, isStateCode, levelTemplate, LEVEL_LABELS, STATES, type SchoolForm, type StateCode } from "@/core/school/catalog";
import { releaseNote } from "@/core/school/freigabe";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export interface SchoolFormValues {
  name: string;
  number: string;
  color: string;
  state: StateCode;
  form: SchoolForm;
  oberstufe: boolean;
  abitur: "g8" | "g9";
}

export function SchoolForm({ action, initial }: { action: (prev: FormState, form: FormData) => Promise<FormState>; initial: SchoolFormValues }) {
  const [state, formAction, pending] = useActionState(action, {});
  const sv = state.values ?? {};
  const [st, setSt] = useState<StateCode>(isStateCode(sv.state) ? sv.state : initial.state);
  const [form, setForm] = useState<SchoolForm>(isSchoolForm(sv.form) ? sv.form : initial.form);
  const [oberstufe, setOberstufe] = useState(sv.oberstufe !== undefined ? sv.oberstufe === "on" : initial.oberstufe);
  const [abitur, setAbitur] = useState<"g8" | "g9">(sv.abitur === "g8" ? "g8" : sv.abitur === "g9" ? "g9" : initial.abitur);
  const fe = state.fieldErrors ?? {};
  const info = formInfo(form);
  const profile = { state: st, form, oberstufe, abitur };
  const grades = gradeTemplate(profile);
  const levels = levelTemplate(profile);
  const hasOberstufe = grades.some((g) => g.stage === "oberstufe");

  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name der Schule" error={fe.name} className="sm:col-span-2">
          <Input name="name" defaultValue={sv.name ?? initial.name} required />
        </Field>
        <Field label="Schulnummer" hint="optional, amtliche Nummer" error={fe.number}>
          <Input name="number" defaultValue={sv.number ?? initial.number} />
        </Field>
        <Field label="Schulfarbe" error={fe.color}>
          <Input name="color" type="color" defaultValue={sv.color ?? initial.color} className="h-11 w-24 p-1" />
        </Field>
        <Field label="Bundesland" error={fe.state} hint={releaseNote(st) ? undefined : "SchulOS ist derzeit nur für Nordrhein-Westfalen freigegeben."}>
          <Select name="state" value={st} onChange={(e) => setSt(e.target.value as StateCode)}>
            {STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        {releaseNote(st) && (
          <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm sm:col-span-2">
            {releaseNote(st)}
          </p>
        )}
        <Field label="Schulform" error={fe.form}>
          <Select name="form" value={form} onChange={(e) => setForm(e.target.value as SchoolForm)}>
            {formsForState(st).map((f) => (
              <option key={f.form} value={f.form}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        {info.oberstufe === "optional" && (
          <label className="flex min-h-11 items-center gap-2 sm:col-span-2">
            <input type="checkbox" name="oberstufe" checked={oberstufe} onChange={(e) => setOberstufe(e.target.checked)} className="size-4 accent-[var(--accent)]" /> mit gymnasialer Oberstufe
          </label>
        )}
        {info.oberstufe === "immer" && <input type="hidden" name="oberstufe" value="on" />}
        {hasOberstufe && (
          <Field label="Abitur nach" error={fe.abitur}>
            <Select name="abitur" value={abitur} onChange={(e) => setAbitur(e.target.value === "g8" ? "g8" : "g9")}>
              <option value="g9">13 Jahren (G9)</option>
              <option value="g8">12 Jahren (G8)</option>
            </Select>
          </Field>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger sm:col-span-2">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-sm text-success sm:col-span-2">
            Gespeichert.
          </p>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={pending}>
            Speichern
          </Button>
        </div>
      </div>

      <aside aria-label="Vorschau" className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-4 text-sm">
        <h2 className="font-semibold">Daraus ergibt sich</h2>
        <div>
          <span className="text-muted">Jahrgänge</span>
          <p className="font-medium">{grades.map((g) => g.code).join(" · ")}</p>
        </div>
        {(levels.sek1.length > 0 || levels.oberstufe.length > 0) && (
          <div>
            <span className="text-muted">Kursniveaus</span>
            <p className="font-medium">{[...levels.sek1, ...levels.oberstufe].map((l) => `${l} (${LEVEL_LABELS[l]})`).join(", ")}</p>
          </div>
        )}
        <p className="text-xs text-muted">Vorbelegung – Jahrgänge, Niveaus und Stundentafeln lassen sich in den Stammdaten anpassen.</p>
      </aside>
    </form>
  );
}
