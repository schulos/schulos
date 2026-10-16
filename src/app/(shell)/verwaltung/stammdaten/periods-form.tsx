"use client";

import { Fragment, useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";

interface Row {
  nr: number;
  startsAt: string;
  endsAt: string;
  /** Pause davor in Minuten */
  breakBefore: number | null;
}

export function PeriodsForm({ action, periods }: { action: (prev: FormState, form: FormData) => Promise<FormState>; periods: Row[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  const last = periods.at(-1);
  return (
    <form key={JSON.stringify([state.values ?? null, periods])} action={formAction} className="flex flex-col gap-4">
      <button type="submit" name="intent" value="save" className="sr-only" tabIndex={-1} aria-hidden>
        Speichern
      </button>
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase">
          <thead>
            <tr>
              <th className="w-24">Stunde</th>
              <th className="w-40">Beginn</th>
              <th className="w-40">Ende</th>
              <th>Dauer</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => {
              const s = v[`start-${p.nr}`] ?? p.startsAt;
              const e = v[`end-${p.nr}`] ?? p.endsAt;
              return (
                <Fragment key={p.nr}>
                  {p.breakBefore !== null && p.breakBefore >= 10 && (
                    <tr>
                      <td colSpan={4} className="bg-surface-2/60 py-1.5! text-xs text-muted">
                        Pause · {p.breakBefore} Minuten
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td className="font-semibold tabular-nums">{p.nr}.</td>
                    <td>
                      <Input type="time" name={`start-${p.nr}`} defaultValue={s} aria-label={`Beginn ${p.nr}. Stunde`} aria-invalid={fe[`start-${p.nr}`] ? true : undefined} required className="h-9" />
                      {fe[`start-${p.nr}`] && <span className="block text-xs text-danger">{fe[`start-${p.nr}`]}</span>}
                    </td>
                    <td>
                      <Input type="time" name={`end-${p.nr}`} defaultValue={e} aria-label={`Ende ${p.nr}. Stunde`} aria-invalid={fe[`end-${p.nr}`] ? true : undefined} required className="h-9" />
                      {fe[`end-${p.nr}`] && <span className="block text-xs text-danger">{fe[`end-${p.nr}`]}</span>}
                    </td>
                    <td className="tabular-nums text-muted">{duration(s, e)}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Gespeichert.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" variant="primary" disabled={pending}>
          Zeitraster speichern
        </Button>
        <Button type="submit" name="intent" value="add" disabled={pending}>
          Stunde anhängen
        </Button>
        {last && (
          <Button type="submit" name="intent" value="remove" variant="ghost" className="text-danger" disabled={pending}>
            {last.nr}. Stunde entfernen
          </Button>
        )}
      </div>
    </form>
  );
}

function duration(start: string, end: string): string {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const d = m(end) - m(start);
  return Number.isFinite(d) && d > 0 ? `${d} min` : "–";
}

/** Zeitraster aus einer Vorlage übernehmen (überzählige Stunden nur, wenn unverplant) */
export function TimeGridForm({ action, grids, suggested }: { action: (prev: FormState, form: FormData) => Promise<FormState>; grids: { id: string; name: string }[]; suggested: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select name="grid" defaultValue={state.values?.grid ?? suggested} aria-label="Zeitraster-Vorlage" className="h-9 w-auto">
          {grids.map((g) => (
            <option key={g.id} value={g.id}>
              {g.id === suggested ? `${g.name} – Vorschlag für die Schulform` : g.name}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" disabled={pending}>
          Vorlage übernehmen
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
