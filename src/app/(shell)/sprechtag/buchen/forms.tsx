"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** Eine Zeit bei einer Lehrkraft buchen. */
export function BookForm({ action, teacher, free }: { action: Action; teacher: string; free: string[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label={`Termin bei ${teacher}`} className="flex flex-wrap items-center gap-2">
      <Select name="slot" aria-label={`Zeit bei ${teacher}`} className="w-32" defaultValue={free[0]}>
        {free.map((s) => (
          <option key={s} value={s}>
            {s} Uhr
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" disabled={pending} aria-label={`Buchen bei ${teacher}`}>
        Buchen
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** Vorschlag „hintereinander“ übernehmen (alle auf einmal). */
export function SuggestionForm({ action, items }: { action: Action; items: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label="Vorschlag buchen" className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.value} className="tabular-nums">
            <input type="hidden" name="b" value={i.value} />
            {i.label}
          </li>
        ))}
      </ol>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Alle {items.length} Termine buchen
        </Button>
      </div>
    </form>
  );
}
