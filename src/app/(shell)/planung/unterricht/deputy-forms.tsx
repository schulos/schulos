"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { obligationFromPercent } from "@/modules/stundenplan/deputat-rechnung";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const parseNum = (raw: string) => (raw.trim() ? Number(raw.replace("%", "").trim().replace(",", ".")) : Number.NaN);

/**
 * Pflichtstunden; SP3-DEP: Teilzeit-Anteil als Rechenhilfe (Vorgabe × Anteil, übernehmbar) und abweichende Pflicht ab dem 2. Halbjahr
 * (`term2From` = Beginn, sonst entfällt das Feld).
 */
export function ObligationForm({
  action,
  value,
  percent,
  term2,
  term2From,
  fallback,
}: {
  action: Action;
  value: string;
  percent: string;
  term2: string;
  term2From: string | null;
  fallback: number;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const [pct, setPct] = useState(v.employmentPercent ?? percent);
  const p = parseNum(pct);
  const computed = Number.isFinite(p) && p > 0 && p <= 100 ? obligationFromPercent(fallback, p) : null;
  return (
    // key über den gespeicherten Wert: React 19 setzt Formulare nach der Action zurück
    <form key={`${value}|${percent}|${term2}|${JSON.stringify(state.values ?? null)}`} action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Pflichtstunden" hint={`leer = Vorgabe der Schulform (${num.format(fallback)}) bzw. aus dem Anteil`} error={fe.obligation} className="w-64">
          <Input name="obligation" inputMode="decimal" defaultValue={v.obligation ?? value} placeholder={num.format(fallback)} />
        </Field>
        <Field label="Teilzeit-Anteil in %" hint="optional, Rechenhilfe" error={fe.employmentPercent} className="w-48">
          <Input name="employmentPercent" inputMode="decimal" defaultValue={pct} onChange={(e) => setPct(e.target.value)} />
        </Field>
        {term2From && (
          <Field label="Pflicht ab 2. Halbjahr" hint={`ab ${term2From}; leer = wie oben`} error={fe.obligationTerm2} className="w-56">
            <Input name="obligationTerm2" inputMode="decimal" defaultValue={v.obligationTerm2 ?? term2} />
          </Field>
        )}
        <Button type="submit" disabled={pending}>
          Pflichtstunden speichern
        </Button>
      </div>
      {computed !== null && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>
            Rechenhilfe: {num.format(fallback)} × {num.format(p)} % = <strong className="text-ink">{num.format(computed)} Std.</strong> (auf halbe Stunden gerundet)
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={(e) => {
              const input = e.currentTarget.form?.elements.namedItem("obligation");
              if (input instanceof HTMLInputElement) input.value = num.format(computed);
            }}
          >
            In Pflichtstunden übernehmen
          </Button>
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Gespeichert.
        </p>
      )}
    </form>
  );
}

/** SP2-04: Tagesregel der Lehrkraft – beide Felder optional, leer = keine Grenze. */
export function TeacherDayRuleForm({ action, maxPerDay, maxDays }: { action: Action; maxPerDay: string; maxDays: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form key={`${maxPerDay}|${maxDays}|${JSON.stringify(state.values ?? null)}`} action={formAction} aria-label="Tagesregel" className="flex flex-wrap items-end gap-3">
      <Field label="Höchstens Stunden am Tag" hint="leer = keine Grenze" error={fe.maxPerDay} className="w-56">
        <Input name="maxPerDay" type="number" min={1} max={20} step={1} defaultValue={v.maxPerDay ?? maxPerDay} />
      </Field>
      <Field label="Höchstens Anwesenheitstage" hint="je Woche, z. B. Teilzeit; leer = keine Grenze" error={fe.maxDays} className="w-64">
        <Input name="maxDays" type="number" min={1} max={5} step={1} defaultValue={v.maxDays ?? maxDays} />
      </Field>
      <Button type="submit" disabled={pending}>
        Tagesregel speichern
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
    </form>
  );
}

/** Ermäßigung/Anrechnung hinzufügen; SP3-DEP: optional „gültig ab/bis“ im Schuljahr (`min`/`max`). */
export function ReductionForm({ action, reasons, min, max, term2From }: { action: Action; reasons: { value: string; label: string }[]; min: string; max: string; term2From: string | null }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_2fr_1fr_1fr_auto] lg:items-end">
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
      <Field label="Stunden" error={fe.hours}>
        <Input name="hours" inputMode="decimal" defaultValue={v.hours ?? ""} required />
      </Field>
      <Field label="Ergänzung" hint="keine Gesundheitsangaben" error={fe.note}>
        <Input name="note" maxLength={80} defaultValue={v.note ?? ""} />
      </Field>
      <Field label="gültig ab" hint={term2From ? `leer = ganzes Schuljahr; 2. Hj ab ${term2From}` : "leer = ab Schuljahresbeginn"} error={fe.validFrom}>
        <Input name="validFrom" type="date" min={min} max={max} defaultValue={v.validFrom ?? ""} />
      </Field>
      <Field label="gültig bis" hint="leer = bis Schuljahresende" error={fe.validUntil}>
        <Input name="validUntil" type="date" min={min} max={max} defaultValue={v.validUntil ?? ""} />
      </Field>
      <Button type="submit" disabled={pending}>
        Hinzufügen
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-6">
          {state.error}
        </p>
      )}
    </form>
  );
}
