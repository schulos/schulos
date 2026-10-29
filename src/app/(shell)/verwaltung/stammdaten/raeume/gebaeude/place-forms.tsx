"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** RS-10: Gebäude bzw. Etage anlegen oder ändern (Name, Reihenfolge). */
export function PlaceForm({
  action,
  initial,
  submitLabel,
  name,
  nameLabel,
}: {
  action: Action;
  initial?: { name: string; sortOrder: number };
  submitLabel: string;
  /** zugänglicher Name des Formulars */
  name: string;
  nameLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values;
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label={name} className="grid items-end gap-3 sm:grid-cols-[2fr_7rem_auto]">
      <Field label={nameLabel} error={fe.name}>
        <Input name="name" maxLength={60} required defaultValue={v ? (v.name ?? "") : (initial?.name ?? "")} />
      </Field>
      <Field label="Reihenfolge" error={fe.sortOrder}>
        <Input name="sortOrder" type="number" min={0} max={99999} inputMode="numeric" defaultValue={v ? (v.sortOrder ?? "") : (initial?.sortOrder?.toString() ?? "")} />
      </Field>
      <Button type="submit" variant={initial ? "secondary" : "primary"} disabled={pending}>
        {submitLabel}
      </Button>
      {state.ok && initial && (
        <p role="status" className="text-sm text-success sm:col-span-3">
          Gespeichert.
        </p>
      )}
    </form>
  );
}

/** Löschen mit Rückfrage; mit zugeordneten Räumen lehnt der Dienst ab (Meldung). */
export function DeletePlaceButton({ action, label, question }: { action: Action; label: string; question: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(question)) e.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-label={label}>
        Löschen
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
