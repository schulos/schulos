"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input, Select } from "@schulos/ui/field";
import { WEIGHT_FIELDS, type WeightKey } from "./status";

export function SolverStartForm({
  action,
  presets,
  presetLabels,
  efforts,
  defaultSeed,
  busy,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  presets: Record<string, Record<WeightKey, number>>;
  presetLabels: Record<string, string>;
  efforts: Record<string, string>;
  defaultSeed: number;
  /** es wartet oder rechnet schon ein Lauf */
  busy: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const [preset, setPreset] = useState(v.preset ?? "ausgewogen");
  // Ausgangswerte der eigenen Gewichte: die zuletzt gewählte Voreinstellung
  const [base, setBase] = useState<Record<WeightKey, number>>(presets[v.preset ?? "ausgewogen"] ?? presets.ausgewogen!);
  const shown = preset === "eigene" ? null : presets[preset];
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Lauf starten" className="flex flex-col gap-4">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Bezeichnung" hint="optional, z. B. „Variante Mo frei“ – keine Personen nennen" error={fe.label} className="sm:col-span-2">
          <Input name="label" maxLength={120} defaultValue={v.label ?? ""} />
        </Field>
        <Field label="Gründlichkeit" error={fe.effort}>
          <Select name="effort" defaultValue={v.effort ?? "normal"}>
            {Object.entries(efforts).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Startwert" hint="anderer Wert = andere Lösung" error={fe.seed}>
          <Input type="number" name="seed" min={1} max={999999} step={1} required defaultValue={v.seed ?? defaultSeed} />
        </Field>
        <Field label="Gewichtung" hint="was der Solver wie stark vermeidet" error={fe.preset} className="sm:col-span-2">
          <Select
            name="preset"
            value={preset}
            onChange={(e) => {
              if (e.target.value === "eigene" && presets[preset]) setBase(presets[preset]!);
              setPreset(e.target.value);
            }}
          >
            {Object.entries(presetLabels).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Lehraufträge am" hint="leer = heute; z. B. Beginn des 2. Halbjahrs" error={fe.refYmd}>
          <Input type="date" name="refYmd" defaultValue={v.refYmd ?? ""} />
        </Field>
        <FieldActions className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Wird angelegt …" : "Plan berechnen"}
          </Button>
          {busy && <span className="text-sm text-muted">Es rechnet schon ein Lauf – ein neuer wartet und startet danach automatisch.</span>}
        </FieldActions>
      </div>
      {shown && (
        <p className="text-sm text-muted">
          Gewichte „{presetLabels[preset]}“: {WEIGHT_FIELDS.map((f) => `${f.label} ${shown[f.key]}`).join(" · ")}
        </p>
      )}
      {preset === "eigene" && (
        <fieldset className="grid gap-4 rounded-card border border-border p-4 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="px-1 text-sm font-semibold">Eigene Gewichte (0 bis 1000)</legend>
          {WEIGHT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint} error={fe[`weights.${f.key}`]}>
              <Input
                type="number"
                name={`w_${f.key}`}
                min={f.key === "lateFrom" ? 1 : 0}
                max={1000}
                step={f.key === "lateFrom" ? 1 : "any"}
                required
                defaultValue={v[`w_${f.key}`] ?? base[f.key]}
              />
            </Field>
          ))}
        </fieldset>
      )}
    </form>
  );
}
