"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { SubjectBar } from "@schulos/ui/misc";

/** SP2-12: Lehrfächer (Fakultas) einer Lehrkraft – ein Häkchen je Fach. */
export function TeacherSubjectsForm({
  action,
  subjects,
  selected,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  subjects: { value: string; label: string; color: string }[];
  selected: string[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form key={selected.join(",")} action={formAction} aria-label="Lehrfächer" className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Bei der Zuweisung eines Fachs schlägt SchulOS nur Lehrkräfte mit diesem Lehrfach vor; im Fachbedarf zählt ihr Deputat für diese Fächer.
        {selected.length === 0 && " Noch keine Lehrfächer gepflegt."}
      </p>
      <fieldset className="grid gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        <legend className="sr-only">Lehrfächer</legend>
        {subjects.map((s) => (
          <label key={s.value} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="subjectIds" value={s.value} defaultChecked={selected.includes(s.value)} className="size-4 accent-[var(--accent)]" />
            <SubjectBar color={s.color} className="h-4 w-1 shrink-0" />
            {s.label}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Lehrfächer speichern
        </Button>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
