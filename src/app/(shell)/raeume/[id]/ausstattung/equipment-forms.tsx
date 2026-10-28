"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/**
 * RS-05: Ausstattung eintragen – Typeahead über den schulweiten Katalog (`datalist`); ein neuer Name wird beim Speichern in den
 * Katalog aufgenommen und ist danach für alle Räume wählbar.
 */
export function AddEquipmentForm({ action, catalog, nameMax, quantityMax }: { action: Action; catalog: string[]; nameMax: number; quantityMax: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label="Ausstattung eintragen" className="flex flex-col gap-3">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Ausstattung eingetragen.
        </p>
      )}
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_7rem_auto]">
        <Field label="Ausstattung" hint="Vorschläge aus dem Katalog – Neues wird beim ersten Eintrag aufgenommen" error={fe.name}>
          <Input name="name" list="ausstattung-katalog" autoComplete="off" maxLength={nameMax} required defaultValue={v?.name ?? ""} />
        </Field>
        <Field label="Menge" error={fe.quantity}>
          <Input name="quantity" type="number" inputMode="numeric" min={1} max={quantityMax} defaultValue={v?.quantity ?? "1"} />
        </Field>
        <Button type="submit" variant="primary" disabled={pending}>
          Eintragen
        </Button>
      </div>
      <datalist id="ausstattung-katalog">
        {catalog.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </form>
  );
}

export interface EquipmentRow {
  typeId: string;
  name: string;
  quantity: number;
}

/** Mengen der vorhandenen Ausstattung in einem Formular; 0 entfernt. */
export function QuantitiesForm({ action, items, quantityMax }: { action: Action; items: EquipmentRow[]; quantityMax: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values;
  return (
    <form key={JSON.stringify([v ?? null, items])} action={formAction} aria-label="Mengen" className="flex flex-col gap-3">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Mengen gespeichert.
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((it) => (
          <li key={it.typeId}>
            <Field label={it.name} error={state.fieldErrors?.[`menge.${it.typeId}`]}>
              <Input
                name={`menge.${it.typeId}`}
                type="number"
                inputMode="numeric"
                min={0}
                max={quantityMax}
                required
                defaultValue={v ? (v[`menge.${it.typeId}`] ?? "") : String(it.quantity)}
              />
            </Field>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Menge 0 entfernt die Ausstattung vom Raum; der Katalogeintrag bleibt für andere Räume.</p>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          Mengen speichern
        </Button>
      </div>
    </form>
  );
}
