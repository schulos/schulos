"use client";

import { useActionState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { redeemCodeListAction } from "./actions";

/** SEC-02: Code von der gedruckten Code-Liste eingeben (Anmeldung von außerhalb des Schulnetzes). */
export function CodeListForm() {
  const [state, action, pending] = useActionState<{ error?: string }, FormData>(redeemCodeListAction, {});
  return (
    <form action={action} aria-label="Code von der Code-Liste" className="flex flex-col gap-3">
      <Field label="Code von deiner Code-Liste" hint="z. B. ABCDE-FGHJK – danach den Code auf der Liste durchstreichen.">
        <Input name="code" required autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} className="font-mono" />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          Weiter
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
