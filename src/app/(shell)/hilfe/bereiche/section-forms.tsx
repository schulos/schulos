"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useActionState, useTransition } from "react";
import { createSectionAction, deleteSectionAction, moveSectionAction, renameSectionAction } from "@/modules/hilfe/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

function Status({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-muted">
        {state.message}
      </p>
    );
  return null;
}

export function NewSectionForm() {
  const [state, action, pending] = useActionState(createSectionAction, {});
  return (
    <form key={state.ok ? "ok" : JSON.stringify(state.values ?? null)} action={action} aria-label="Bereich anlegen" className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field label="Neuer Bereich" error={state.fieldErrors?.title} className="flex-1">
        <Input name="title" maxLength={80} required defaultValue={state.values?.title} placeholder="z. B. Erste Schritte" />
      </Field>
      <Button type="submit" variant="primary" disabled={pending}>
        Anlegen
      </Button>
      <Status state={state.fieldErrors ? {} : state} />
    </form>
  );
}

export function SectionRow({ id, title, pages, canDelete, first, last }: { id: string; title: string; pages: number; canDelete: boolean; first: boolean; last: boolean }) {
  const [state, action, pending] = useActionState(renameSectionAction.bind(null, id), {});
  const [delState, delAction, deleting] = useActionState(deleteSectionAction.bind(null, id), {});
  const [moving, start] = useTransition();
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <form action={action} aria-label={`Bereich ${title}`} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Titel" error={state.fieldErrors?.title} className="flex-1" hint={pages === 1 ? "1 Seite" : `${pages} Seiten`}>
          <Input name="title" maxLength={80} required defaultValue={title} />
        </Field>
        <span className="flex flex-wrap gap-1">
          <Button type="submit" size="sm" disabled={pending}>
            Speichern
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={moving || first} aria-label={`${title} nach oben`} onClick={() => start(() => moveSectionAction(id, -1))}>
            <ArrowUp aria-hidden />
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={moving || last} aria-label={`${title} nach unten`} onClick={() => start(() => moveSectionAction(id, 1))}>
            <ArrowDown aria-hidden />
          </Button>
          {canDelete && (
            <Button type="submit" formAction={delAction} size="sm" variant="ghost" disabled={deleting} aria-label={`${title} löschen`}>
              <Trash2 aria-hidden />
            </Button>
          )}
        </span>
      </form>
      <Status state={state.fieldErrors ? {} : state} />
      <Status state={delState} />
    </li>
  );
}
