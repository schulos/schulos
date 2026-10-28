"use client";

import { useActionState } from "react";
import Link from "next/link";
import type { FormState } from "@/modules/verwaltung/actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Textarea } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export interface InfoFormField {
  id: string;
  label: string;
  visibility: "alle" | "personal";
  value: string;
}

/** RS-03: alle Infofelder eines Raums in einem Formular; leer lassen = keine Angabe. */
export function RoomInfoForm({ action, fields, backHref, maxLength }: { action: Action; fields: InfoFormField[]; backHref: string; maxLength: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values;
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label="Infofelder" className="flex flex-col gap-4">
      <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
        Nur Angaben zum Raum eintragen – keine Namen, Telefonnummern oder sonstigen Daten von Personen. Zuständige Personen kommen
        später als Raumverantwortliche dazu.
      </p>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {fields.map((f) => (
        <div key={f.id} className="flex flex-col gap-1">
          <Badge tone={f.visibility === "alle" ? "soft" : "neutral"} className="self-start">
            {f.visibility === "alle" ? "sichtbar für alle" : "nur Personal"}
          </Badge>
          <Field label={f.label} error={state.fieldErrors?.[`info.${f.id}`]}>
            <Textarea name={`info.${f.id}`} rows={2} maxLength={maxLength} defaultValue={v ? (v[`info.${f.id}`] ?? "") : f.value} />
          </Field>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          Speichern
        </Button>
        <Button asChild variant="ghost">
          <Link href={backHref}>Abbrechen</Link>
        </Button>
      </div>
    </form>
  );
}
