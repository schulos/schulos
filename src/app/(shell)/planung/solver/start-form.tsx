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
  sources = [],
  defaultSource,
  liveSource,
  modes = {},
  scopes = {},
  passChoices = [],
  defaultPasses = 5,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  presets: Record<string, Record<WeightKey, number>>;
  presetLabels: Record<string, string>;
  efforts: Record<string, string>;
  defaultSeed: number;
  /** es wartet oder rechnet schon ein Lauf */
  busy: boolean;
  /** SP3-02: Plan, gegen den gerechnet wird – „Gültiger Plan“ und offene Entwürfe (Wert = Versions-id) */
  sources?: { value: string; label: string }[];
  defaultSource?: string;
  /** Wert von „Gültiger Plan“ im Wähler – dort gibt es kein „ab Entwurf verbessern“ */
  liveSource?: string;
  /** SQ-02: Vorgehen (neu planen / ab aktuellem Entwurf verbessern) und Umfang des Warmstarts */
  modes?: Record<string, string>;
  scopes?: Record<string, string>;
  /** SQ-03: Auswahl der Durchgänge im Mehrfachlauf */
  passChoices?: readonly number[];
  defaultPasses?: number;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const [preset, setPreset] = useState(v.preset ?? "ausgewogen");
  // Ausgangswerte der eigenen Gewichte: die zuletzt gewählte Voreinstellung
  const [base, setBase] = useState<Record<WeightKey, number>>(presets[v.preset ?? "ausgewogen"] ?? presets.ausgewogen!);
  const shown = preset === "eigene" ? null : presets[preset];
  const [source, setSource] = useState(v.versionId ?? defaultSource ?? sources[0]?.value ?? "");
  const [mode, setMode] = useState(v.mode ?? "neu");
  const [kind, setKind] = useState(v.lauf ?? "einzel");
  const inDraft = sources.length > 1 && source !== liveSource;
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
        {passChoices.length > 0 && (
          <Field label="Läufe" hint="„Mehrfachlauf“ rechnet mehrere Durchgänge nacheinander und behält den besten" error={fe.lauf}>
            <Select name="lauf" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="einzel">Einzellauf</option>
              <option value="mehrfach">Mehrfachlauf</option>
            </Select>
          </Field>
        )}
        {passChoices.length > 0 && kind === "mehrfach" && (
          <Field
            label="Durchgänge"
            hint={inDraft && mode === "entwurf" ? "Kette: jeder Durchgang startet vom besten bisherigen Ergebnis" : "Startwerte fortlaufend ab dem gewählten; der beste Durchgang bleibt"}
            error={fe.passes}
          >
            <Select name="passes" defaultValue={v.passes ?? String(defaultPasses)}>
              {passChoices.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
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
        <Field label="Lehraufträge am" hint="leer = heute, im Entwurf sein Stichtag; z. B. Beginn des 2. Halbjahrs" error={fe.refYmd}>
          <Input type="date" name="refYmd" defaultValue={v.refYmd ?? ""} />
        </Field>
        {sources.length > 1 && (
          <Field label="Planen im" hint="fixierte Stunden und Stunden ohne Lehrauftrag kommen aus diesem Plan" error={fe.versionId} className="sm:col-span-2">
            <Select name="versionId" value={source} onChange={(e) => setSource(e.target.value)}>
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {inDraft && Object.keys(modes).length > 0 && (
          <Field label="Vorgehen" hint="„verbessern“ startet von den Stunden des Entwurfs und ändert nur, was besser wird; fixierte Stunden bleiben" error={fe.mode} className="sm:col-span-2">
            <Select name="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              {Object.entries(modes).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {inDraft && mode === "entwurf" && Object.keys(scopes).length > 0 && (
          <Field label="Ändern dürfen" hint="„nur schwache Bereiche“: Stunden, die nichts kosten (keine Hohlstunde, kein Wunsch verletzt …), bleiben, wo sie sind" error={fe.scope} className="sm:col-span-2">
            <Select name="scope" defaultValue={v.scope ?? "alle"}>
              {Object.entries(scopes).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}
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
