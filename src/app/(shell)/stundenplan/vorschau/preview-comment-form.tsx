"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Select, Textarea } from "@schulos/ui/field";

/** SP3-03: Rückmeldung einer Lehrkraft aus der Vorschau „Mein Plan ab …“ – zum ganzen eigenen Plan oder zu einer eigenen Stunde. */
export function PreviewCommentForm({ action, slots }: { action: (prev: FormState, form: FormData) => Promise<FormState>; slots: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Kommentar an die Stundenplanung" className="flex flex-col gap-4">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <Field label="Bezug" error={fe.slot}>
        <Select name="slot" defaultValue={v.slot ?? ""}>
          <option value="">Mein Plan insgesamt</option>
          {slots.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Kommentar" hint="höchstens 500 Zeichen – nur die Stundenplanung (und die Schulleitung bei der Prüfung) liest ihn; keine Gesundheitsangaben" error={fe.body}>
        <Textarea name="body" rows={3} maxLength={500} required defaultValue={v.body ?? ""} />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          Kommentar senden
        </Button>
      </div>
    </form>
  );
}
