"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";
import type { PublicFormState } from "./public-actions";
import type { SlotOption } from "./slot-options";

type Action = (prev: PublicFormState, form: FormData) => Promise<PublicFormState>;

function Message({ state }: { state: PublicFormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok && state.message)
    return (
      <p role="status" className="text-sm text-success">
        {state.message}
      </p>
    );
  return null;
}

/** Termin ändern und Anmeldung zurückziehen (P4-35) – über den Vorgangslink oder das Elternkonto. */
export function VorgangActions({ change, withdraw, slots }: { change: Action; withdraw: Action; slots: SlotOption[] }) {
  const router = useRouter();
  const refreshAfter = (a: Action) => async (prev: PublicFormState, form: FormData) => {
    const r = await a(prev, form);
    if (r.ok) router.refresh();
    return r;
  };
  const [changeState, changeAction, changing] = useActionState(refreshAfter(change), {});
  const [withdrawState, withdrawAction, withdrawing] = useActionState(refreshAfter(withdraw), {});
  return (
    <div className="flex flex-col gap-6">
      <form action={changeAction} aria-label="Termin ändern" className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold">Termin ändern</h2>
        {slots.length === 0 ? (
          <p className="text-sm text-muted">Zurzeit ist kein anderer Termin frei.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Neuer Termin">
              <Select name="slotId" required defaultValue="">
                <option value="" disabled>
                  – bitte wählen –
                </option>
                {slots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.dayLabel}, {s.time}
                    {s.room ? ` (${s.room})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={changing}>
              {changing ? "Wird geändert …" : "Termin ändern"}
            </Button>
          </div>
        )}
        <Message state={changeState} />
      </form>
      <form action={withdrawAction} aria-label="Anmeldung zurückziehen" className="flex flex-col gap-3 border-t border-border pt-4">
        <h2 className="font-display text-lg font-bold">Anmeldung zurückziehen</h2>
        <p className="text-sm text-muted">Ihr Termin wird wieder frei. Das lässt sich online nicht rückgängig machen.</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" required className="size-4 accent-[var(--accent)]" />
          Ja, ich ziehe die Anmeldung zurück.
        </label>
        <Button type="submit" variant="danger" className="w-fit" disabled={withdrawing}>
          {withdrawing ? "Wird zurückgezogen …" : "Anmeldung zurückziehen"}
        </Button>
        <Message state={withdrawState} />
      </form>
    </div>
  );
}
