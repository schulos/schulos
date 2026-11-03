"use client";

import { useActionState } from "react";
import { setDayMenusAction } from "@/modules/ganztag/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input } from "@schulos/ui/field";

const NUMBERS = [1, 2, 3, 4];

function Status({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p role="status" className="text-sm text-muted">
        {state.message}
      </p>
    );
  return null;
}

/** GT-11: Menüs eines Tages – Menü 1 … 4 mit Kurzbeschreibung, leer = kein Menü. */
export function DayMenuForm({ date, label, menus, orders }: { date: string; label: string; menus: { number: number; title: string }[]; orders: Record<number, number> }) {
  const [state, action, pending] = useActionState(setDayMenusAction.bind(null, date), {} as FormState);
  const v = state.values;
  const title = (n: number) => menus.find((m) => m.number === n)?.title ?? "";
  return (
    <form key={state.ok ? `ok-${state.message}` : "form"} action={action} aria-label={`Speiseplan ${label}`} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {NUMBERS.map((n) => (
          <Field key={n} label={`Menü ${n}`} error={state.fieldErrors?.[`m${n}`]} hint={orders[n] ? (orders[n] === 1 ? "1 Anmeldung" : `${orders[n]} Anmeldungen`) : undefined}>
            <Input name={`m${n}`} maxLength={80} defaultValue={v?.[`m${n}`] ?? title(n)} placeholder={n === 1 ? "z. B. Nudeln mit Tomatensoße" : undefined} />
          </Field>
        ))}
      </div>
      <FieldActions>
        <Button type="submit" variant="secondary" disabled={pending}>
          Speichern
        </Button>
      </FieldActions>
      <Status state={state} />
    </form>
  );
}
