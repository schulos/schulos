"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";

const OPTIONS = [
  { value: "x", label: "gesperrt" },
  { value: "-3", label: "−3" },
  { value: "-2", label: "−2" },
  { value: "-1", label: "−1" },
  { value: "0", label: "egal" },
  { value: "1", label: "+1" },
  { value: "2", label: "+2" },
  { value: "3", label: "+3" },
];

/** Farbe je Wert: gesperrt rot, ungünstig gelb, erwünscht grün. */
const tone = (v: string) => (v === "x" ? "bg-danger-soft text-danger" : Number(v) < 0 ? "bg-warn-soft text-warn" : Number(v) > 0 ? "bg-success-soft text-success" : "bg-surface");

/** Zeitwünsche als Raster Wochentag × Stunde, jedes Feld ein Auswahlfeld. */
export function PrefGrid({
  action,
  weekdays,
  periods,
  initial,
  title,
  readOnly = false,
  locked = [],
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  weekdays: string[];
  periods: { nr: number; label: string }[];
  /** `${wd}-${nr}` → „-3“…„3“ | „x“ */
  initial: Record<string, string>;
  title: string;
  /** nur anzeigen (z. B. Eingabefenster geschlossen) */
  readOnly?: boolean;
  /** Slots mit einer Vorgabe der Planung – für die Lehrkraft nicht änderbar (GATE-4f C-07) */
  locked?: string[];
}) {
  const fixed = new Set(locked);
  const [state, formAction, pending] = useActionState(action, {});
  const value = (k: string) => state.values?.[`c-${k}`] ?? initial[k] ?? "0";
  return (
    <form key={JSON.stringify([initial, state.values ?? null])} action={formAction} aria-label={`Zeitwünsche ${title}`} className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Zeitwünsche {title}</caption>
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted uppercase">Stunde</th>
              {weekdays.map((d) => (
                <th key={d} className="px-2 py-2 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.nr} className="border-t border-border">
                <td className="px-3 py-1.5 whitespace-nowrap">{p.label}</td>
                {weekdays.map((d, wd) => {
                  const k = `${wd}-${p.nr}`;
                  return (
                    <td key={d} className="px-1.5 py-1.5">
                      <PrefSelect
                        name={`c-${k}`}
                        initial={fixed.has(k) ? (initial[k] ?? "0") : value(k)}
                        label={`${d} ${p.nr}. Stunde${fixed.has(k) ? " (Vorgabe der Stundenplanung)" : ""}`}
                        disabled={readOnly || fixed.has(k)}
                        locked={fixed.has(k)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={cn("flex flex-wrap items-center gap-3", readOnly && "hidden")}>
        <Button type="submit" variant="primary" disabled={pending}>
          Zeitwünsche speichern
        </Button>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

const base = "h-9 w-full min-w-20 rounded-lg border border-border px-2 text-sm font-medium outline-none focus:border-accent";

function PrefSelect({ name, initial, label, disabled, locked }: { name: string; initial: string; label: string; disabled?: boolean; locked?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <select
      name={name}
      value={v}
      onChange={(e) => setV(e.target.value)}
      aria-label={label}
      title={locked ? "Vorgabe der Stundenplanung" : undefined}
      data-locked={locked || undefined}
      disabled={disabled}
      className={cn(base, tone(v), disabled && "opacity-80", locked && "border-dashed")}
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
