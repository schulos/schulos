"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

function Messages({ state, ok }: { state: FormState; ok: string }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          {ok}
        </p>
      )}
    </>
  );
}

/** RS-05: Katalogeintrag umbenennen (gilt in allen Räumen). */
export function RenameTypeForm({ action, name, label, nameMax }: { action: Action; name: string; label: string; nameMax: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values;
  return (
    <form key={JSON.stringify([v ?? null, name])} action={formAction} aria-label={`${label} umbenennen`} className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
      <Field label="Name">
        <Input name="name" maxLength={nameMax} required defaultValue={v ? (v.name ?? "") : name} />
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>
        Umbenennen
      </Button>
      <Messages state={state} ok="Umbenannt." />
    </form>
  );
}

/** RS-05: Dublette in einen anderen Eintrag überführen – Räume behalten ihre Ausstattung (größere Menge gilt). */
export function MergeTypeForm({ action, label, others }: { action: Action; label: string; others: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      aria-label={`${label} zusammenführen`}
      className="grid items-end gap-2 sm:grid-cols-[1fr_auto]"
      onSubmit={(e) => {
        if (!window.confirm(`„${label}“ in den gewählten Eintrag überführen? „${label}“ verschwindet danach aus dem Katalog.`)) e.preventDefault();
      }}
    >
      <Field label="Zusammenführen mit">
        <Select name="into" required defaultValue="">
          <option value="" disabled>
            Eintrag wählen …
          </option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="secondary" disabled={pending || others.length === 0}>
        Zusammenführen
      </Button>
      <Messages state={state} ok="Zusammengeführt." />
    </form>
  );
}

/** RS-05: unbenutzten Katalogeintrag löschen. */
export function DeleteTypeButton({ action, label }: { action: () => Promise<FormState>; label: string }) {
  const [state, formAction, pending] = useActionState(() => action(), {} as FormState);
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <Button type="submit" variant="ghost" size="sm" className="text-danger" disabled={pending} aria-label={`${label} aus dem Katalog löschen`}>
        Löschen
      </Button>
      {state.error && (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
