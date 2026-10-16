"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** Zuteilung berechnen – optional mit neuem Los. */
export function AllocateForm({ action, again }: { action: Action; again: boolean }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label="Zuteilung" className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="primary" disabled={pending}>
        {again ? "Zuteilung neu berechnen" : "Zuteilung berechnen"}
      </Button>
      {again && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="newSeed" className="size-4 accent-[var(--accent)]" />
          neu losen
        </label>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Zuteilung berechnet.
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** Korrektur je Person: Angebot wählen („automatisch“ hebt die Zuteilung von Hand auf). */
export function AssignForm({ action, student, current, offers }: { action: Action; student: string; current: string; offers: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label={`Korrektur ${student}`} className="flex flex-wrap items-center gap-2">
      <Select name="offerId" aria-label={`Kurs für ${student}`} defaultValue={current} className="w-48">
        <option value="">automatisch</option>
        {offers.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" variant="ghost" disabled={pending} aria-label={`Zuteilen: ${student}`}>
        Zuteilen
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-xs text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
