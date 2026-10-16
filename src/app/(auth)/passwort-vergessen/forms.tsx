"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { completeResetAction, requestResetAction, type ResetCompleteState, type ResetRequestState } from "./actions";

export function RequestResetForm({ doneText }: { doneText: string }) {
  const [state, action, pending] = useActionState<ResetRequestState, FormData>(requestResetAction, {});
  if (state.done)
    return (
      <p role="status" className="text-sm">
        {doneText}
      </p>
    );
  return (
    <form action={action} aria-label="Passwort vergessen" className="flex flex-col gap-4">
      <Field label="Benutzername oder E-Mail-Adresse">
        <Input name="konto" required autoComplete="username" maxLength={200} />
      </Field>
      <Button type="submit" disabled={pending}>
        Link anfordern
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function CompleteResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetCompleteState, FormData>(completeResetAction.bind(null, token), {});
  if (state.done)
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p role="status" className="font-medium text-success">
          Das Passwort ist geändert. Alle Geräte wurden abgemeldet.
        </p>
        <Link href="/login" className="font-medium text-accent-ink hover:underline">
          Zur Anmeldung
        </Link>
      </div>
    );
  return (
    <form action={action} aria-label="Neues Passwort" className="flex flex-col gap-4">
      <Field label="Neues Passwort">
        <Input type="password" name="next" required autoComplete="new-password" />
      </Field>
      <Field label="Neues Passwort wiederholen">
        <Input type="password" name="repeat" required autoComplete="new-password" />
      </Field>
      <Button type="submit" disabled={pending}>
        Passwort speichern
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
