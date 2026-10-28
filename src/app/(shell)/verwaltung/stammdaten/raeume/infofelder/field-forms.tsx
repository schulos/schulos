"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export interface InfoFieldValues {
  label: string;
  visibility: "alle" | "personal";
  sortOrder: number;
}

/** RS-03: Infofeld anlegen bzw. ändern (Bezeichnung, Sichtbarkeit, Reihenfolge). */
export function InfoFieldForm({ action, initial, submitLabel, name }: { action: Action; initial?: InfoFieldValues; submitLabel: string; name: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values;
  const fe = state.fieldErrors ?? {};
  // React setzt das Formular nach der Action zurück; nach einem Fehler gelten die Eingaben
  return (
    <form key={JSON.stringify(v ?? null)}action={formAction} aria-label={name} className="grid items-end gap-3 sm:grid-cols-[2fr_1fr_6rem_auto]">
      <Field label="Bezeichnung" error={fe.label}>
        <Input name="label" maxLength={60} required defaultValue={v ? (v.label ?? "") : (initial?.label ?? "")} />
      </Field>
      <Field label="Sichtbar für" error={fe.visibility}>
        <Select name="visibility" defaultValue={v ? (v.visibility ?? "personal") : (initial?.visibility ?? "personal")}>
          <option value="personal">nur Personal</option>
          <option value="alle">alle (auch Schüler:innen, Eltern)</option>
        </Select>
      </Field>
      <Field label="Reihenfolge" error={fe.sortOrder}>
        <Input name="sortOrder" type="number" min={0} max={999} defaultValue={v ? (v.sortOrder ?? "") : (initial?.sortOrder?.toString() ?? "")} />
      </Field>
      <Button type="submit" variant={initial ? "secondary" : "primary"} disabled={pending}>
        {submitLabel}
      </Button>
      {state.ok && initial && (
        <p role="status" className="text-sm text-success sm:col-span-4">
          Gespeichert.
        </p>
      )}
    </form>
  );
}

/** Löschen mit Rückfrage – die Werte in allen Räumen gehen mit. */
export function DeleteFieldButton({ action, label }: { action: () => Promise<void>; label: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Infofeld „${label}“ samt den Angaben in allen Räumen löschen?`)) e.preventDefault();
      }}
    >
      <Button type="submit" variant="ghost" size="sm" aria-label={`Infofeld ${label} löschen`}>
        Löschen
      </Button>
    </form>
  );
}
