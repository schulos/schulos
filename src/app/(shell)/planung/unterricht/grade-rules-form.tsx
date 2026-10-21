"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Input } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export interface GradeRuleRow {
  grade: number;
  maxPerDay: string;
  afternoonsPerWeek: string;
  lunchAfterPeriod: string;
  /** Wirkung im Zeitraster, z. B. „Mittagspause liegt im Zeitraster (nach der 6. Stunde)“ */
  effect: string;
}

/** SP2-03: Tagesgrenzen und Ganztag je Jahrgang – leer = keine Grenze. */
export function GradeRulesForm({ action, rows, periodCount }: { action: Action; rows: GradeRuleRow[]; periodCount: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = (k: string, fallback: string) => state.values?.[k] ?? fallback;
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="flex flex-col gap-4">
      <Table>
        <caption className="sr-only">Tagesgrenzen und Ganztag je Jahrgang</caption>
        <thead>
          <tr>
            <th>Jahrgang</th>
            <th>Stunden je Tag höchstens</th>
            <th>Mittag nach der … Stunde</th>
            <th>Nachmittage je Woche höchstens</th>
            <th>Wirkung</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.grade}>
              <th scope="row">{r.grade}</th>
              <td>
                <Input
                  type="number"
                  name={`max_${r.grade}`}
                  min={1}
                  max={periodCount}
                  defaultValue={v(`max_${r.grade}`, r.maxPerDay)}
                  aria-label={`Jahrgang ${r.grade}: Stunden je Tag höchstens`}
                  aria-invalid={fe[`max_${r.grade}`] ? true : undefined}
                  className="w-24"
                />
              </td>
              <td>
                <Input
                  type="number"
                  name={`lunch_${r.grade}`}
                  min={1}
                  max={Math.max(1, periodCount - 1)}
                  defaultValue={v(`lunch_${r.grade}`, r.lunchAfterPeriod)}
                  aria-label={`Jahrgang ${r.grade}: Mittag nach der … Stunde`}
                  aria-invalid={fe[`lunch_${r.grade}`] ? true : undefined}
                  className="w-24"
                />
              </td>
              <td>
                <Input
                  type="number"
                  name={`pm_${r.grade}`}
                  min={0}
                  max={5}
                  defaultValue={v(`pm_${r.grade}`, r.afternoonsPerWeek)}
                  aria-label={`Jahrgang ${r.grade}: Nachmittage je Woche höchstens`}
                  aria-invalid={fe[`pm_${r.grade}`] ? true : undefined}
                  className="w-24"
                />
              </td>
              <td className="text-sm text-muted">{r.effect}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {Object.keys(fe).length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-sm text-danger">
          {Object.entries(fe).map(([k, msg]) => (
            <li key={k}>{msg}</li>
          ))}
        </ul>
      )}
      {state.error && !Object.keys(fe).length && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Tagesgrenzen speichern"}
        </Button>
      </div>
    </form>
  );
}
