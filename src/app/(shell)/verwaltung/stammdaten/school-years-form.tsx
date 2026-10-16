"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Input } from "@schulos/ui/field";

interface Row {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  term2StartsOn: string | null;
  isCurrent: boolean;
  groups: number;
}

export function SchoolYearsForm({ action, years }: { action: (prev: FormState, form: FormData) => Promise<FormState>; years: Row[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  const current = state.values ? v.current : years.find((y) => y.isCurrent)?.id;
  const err = (k: string) => fe[k] && <span className="block text-xs text-danger">{fe[k]}</span>;
  const date = (name: string, label: string, value: string) => (
    <>
      <Input type="date" name={name} defaultValue={v[name] ?? value} aria-label={label} aria-invalid={fe[name] ? true : undefined} className="h-9" />
      {err(name)}
    </>
  );
  return (
    <form key={JSON.stringify([state.values ?? null, years])} action={formAction} className="flex flex-col gap-4">
      <button type="submit" name="intent" value="save" className="sr-only" tabIndex={-1} aria-hidden>
        Speichern
      </button>
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase">
          <thead>
            <tr>
              <th className="w-20">Aktuell</th>
              <th className="w-36">Name</th>
              <th>Beginn</th>
              <th>2. Halbjahr ab</th>
              <th>Ende</th>
              <th className="w-24 text-right">Gruppen</th>
              <th className="w-14">
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y.id}>
                <td>
                  <input type="radio" name="current" value={y.id} defaultChecked={current === y.id} aria-label={`${y.name} ist das aktuelle Schuljahr`} className="size-4 accent-[var(--accent)]" />
                </td>
                <td>
                  <Input name={`name-${y.id}`} defaultValue={v[`name-${y.id}`] ?? y.name} aria-label={`Name ${y.name}`} aria-invalid={fe[`name-${y.id}`] ? true : undefined} className="h-9" />
                  {err(`name-${y.id}`)}
                </td>
                <td>{date(`start-${y.id}`, `Beginn ${y.name}`, y.startsOn)}</td>
                <td>{date(`term2-${y.id}`, `2. Halbjahr ${y.name}`, y.term2StartsOn ?? "")}</td>
                <td>{date(`end-${y.id}`, `Ende ${y.name}`, y.endsOn)}</td>
                <td className="text-right tabular-nums text-muted">{y.groups}</td>
                <td>
                  <Button
                    type="submit"
                    name="intent"
                    value={`delete:${y.id}`}
                    variant="ghost"
                    size="icon"
                    className="size-9 text-danger"
                    disabled={pending || y.isCurrent || y.groups > 0}
                    aria-label={`${y.name} löschen`}
                    title={y.isCurrent ? "Aktuelles Schuljahr" : y.groups > 0 ? "Hat noch Gruppen" : undefined}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">Neue Klassen, Kurse und AGs gehören zum aktuellen Schuljahr. Das Folgejahr übernimmt die Daten des letzten Schuljahres plus ein Jahr – Beginn, Halbjahreswechsel und Ende bitte prüfen.</p>
      {fe.current && (
        <p role="alert" className="text-sm text-danger">
          {fe.current}
        </p>
      )}
      {state.error && !fe.current && (
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
          Schuljahre speichern
        </Button>
        <Button type="submit" name="intent" value="add" disabled={pending}>
          Folgejahr anlegen
        </Button>
      </div>
    </form>
  );
}
