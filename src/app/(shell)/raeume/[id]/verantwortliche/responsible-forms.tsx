"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** RS-06: Person (Beschäftigte) oder Gruppe als verantwortlich eintragen, mit optionalem Hinweis ohne Personendaten. */
export function AddResponsibleForm({
  action,
  people,
  groups,
  noteMax,
}: {
  action: Action;
  people: { id: string; name: string; shortCode: string | null }[];
  groups: { id: string; name: string }[];
  noteMax: number;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label="Verantwortliche eintragen" className="flex flex-col gap-3">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Verantwortliche eingetragen.
        </p>
      )}
      <Field label="Person oder Gruppe" error={fe.target}>
        <Select name="target" required defaultValue={v?.target ?? ""}>
          <option value="">– wählen –</option>
          <optgroup label="Beschäftigte">
            {people.map((p) => (
              <option key={p.id} value={`u:${p.id}`}>
                {p.shortCode ? `${p.name} (${p.shortCode})` : p.name}
              </option>
            ))}
          </optgroup>
          {groups.length > 0 && (
            <optgroup label="Gruppen">
              {groups.map((g) => (
                <option key={g.id} value={`g:${g.id}`}>
                  {g.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      <Field label="Aufgabe oder Kontakt (optional)" hint="z. B. „Fachraumleitung Chemie“ – keine privaten Telefonnummern" error={fe.note}>
        <Input name="note" maxLength={noteMax} defaultValue={v?.note ?? ""} />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Eintragen
        </Button>
      </div>
    </form>
  );
}

export function RemoveResponsibleButton({ action, label }: { action: () => Promise<void>; label: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`${label} als verantwortlich entfernen?`)) e.preventDefault();
      }}
    >
      <Button type="submit" variant="ghost" size="sm" className="text-danger" aria-label={`${label} entfernen`}>
        Entfernen
      </Button>
    </form>
  );
}
