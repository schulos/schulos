"use client";

import { useActionState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { confirmEmailAction, removeEmailAction, requestEmailAction, type EmailFormState } from "./actions";

function Message({ state }: { state: EmailFormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        {state.ok}
      </p>
    );
  return null;
}

export function EmailRequestForm({ current, disabled }: { current: string | null; disabled: boolean }) {
  const [state, action, pending] = useActionState(requestEmailAction, {});
  return (
    <form key={JSON.stringify(state.values ?? null)} action={action} aria-label="E-Mail-Adresse ändern" className="flex flex-col gap-3">
      <Field label={current ? "Neue E-Mail-Adresse" : "E-Mail-Adresse"} hint="Sie bekommen einen Link, mit dem Sie die Adresse bestätigen.">
        <Input name="email" type="email" required autoComplete="email" defaultValue={state.values?.email ?? ""} disabled={disabled} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || disabled}>
          {pending ? "Senden …" : "Bestätigungslink senden"}
        </Button>
        <Message state={state} />
      </div>
    </form>
  );
}

export function EmailRemoveForm() {
  const [state, action, pending] = useActionState(removeEmailAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        Adresse entfernen
      </Button>
      <Message state={state} />
    </form>
  );
}

export function EmailConfirmForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<EmailFormState, FormData>(() => confirmEmailAction(token), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="primary" disabled={pending}>
        Adresse bestätigen
      </Button>
      <Message state={state} />
    </form>
  );
}
