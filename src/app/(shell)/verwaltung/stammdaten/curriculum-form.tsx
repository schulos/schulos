"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";

interface Props {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  grades: { level: number; code: string }[];
  subjects: { id: string; name: string; color: string }[];
  /** gespeicherte Stunden je „Jahrgang-Fach“ */
  hours: Record<string, number>;
}

export function CurriculumForm({ action, grades, subjects, hours }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const initial = (g: number, s: string) => state.values?.[`h-${g}-${s}`] ?? (hours[`${g}-${s}`] ? String(hours[`${g}-${s}`]) : "");
  // Summen live mitrechnen, damit man beim Tippen die Wochenstunden je Jahrgang sieht
  const [draft, setDraft] = useState<Record<string, string>>({});
  const value = (g: number, s: string) => draft[`${g}-${s}`] ?? initial(g, s);
  const sum = (g: number) => subjects.reduce((n, s) => n + (Number(value(g, s.id)) || 0), 0);
  return (
    <form
      key={JSON.stringify([state.values ?? null, hours])}
      action={formAction}
      onSubmit={() => setDraft({})}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="grades" value={grades.map((g) => g.level).join(",")} />
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase">
          <thead>
            <tr>
              <th className="text-left">Fach</th>
              {grades.map((g) => (
                <th key={g.level} className="w-20 text-center">
                  {/^\d+$/.test(g.code) ? `Jg. ${g.code}` : g.code}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {subjects.map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap">
                  <span aria-hidden className="mr-2 inline-block size-2.5 rounded-full align-middle" style={{ backgroundColor: s.color }} />
                  <span className="font-medium">{s.id}</span> <span className="text-muted">{s.name}</span>
                </td>
                {grades.map((g) => {
                  const k = `h-${g.level}-${s.id}`;
                  return (
                    <td key={g.level} className="text-center">
                      <input
                        type="number"
                        min={0}
                        max={12}
                        inputMode="numeric"
                        name={k}
                        defaultValue={initial(g.level, s.id)}
                        onChange={(e) => setDraft((d) => ({ ...d, [`${g.level}-${s.id}`]: e.target.value }))}
                        aria-label={`${s.name}, ${/^\d+$/.test(g.code) ? `Jahrgang ${g.code}` : g.code}`}
                        aria-invalid={fe[k] ? true : undefined}
                        className="h-9 w-14 rounded-lg border border-border bg-surface text-center tabular-nums aria-invalid:border-danger"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="font-semibold">
              <td>Wochenstunden</td>
              {grades.map((g) => (
                <td key={g.level} className="text-center tabular-nums" data-testid={`sum-${g.level}`}>
                  {sum(g.level)}
                </td>
              ))}
            </tr>
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
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Stundentafel speichern
        </Button>
      </div>
    </form>
  );
}
