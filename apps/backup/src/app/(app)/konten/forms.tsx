"use client";

import { useActionState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { accountAction, createAccountAction, type AccountFormState } from "./actions";

function StartPassword({ p }: { p: NonNullable<AccountFormState["password"]> }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface-2 p-3 text-sm">
      <span>
        Startpasswort für <strong>{p.username}</strong> – nur jetzt sichtbar, persönlich übergeben:
      </span>
      <output aria-label="Startpasswort" className="font-mono text-lg tracking-wider">
        {p.value}
      </output>
      <span className="text-muted">Beim ersten Anmelden: eigenes Passwort, dann Zwei-Faktor-Anmeldung einrichten.</span>
    </div>
  );
}

function Feedback({ state }: { state: AccountFormState }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          {state.ok}
        </p>
      )}
      {state.password && <StartPassword p={state.password} />}
    </>
  );
}

export function CreateAccountForm() {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(createAccountAction, {});
  const v = state.values;
  return (
    <form key={JSON.stringify(v ?? {})} action={action} aria-label="Konto anlegen" className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        <Field label="Vorname">
          <Input name="firstName" required defaultValue={v?.firstName} />
        </Field>
        <Field label="Nachname">
          <Input name="lastName" required defaultValue={v?.lastName} />
        </Field>
        <Field label="Benutzername">
          <Input name="username" required defaultValue={v?.username} pattern="[A-Za-z0-9._]{3,30}" />
        </Field>
      </div>
      <Feedback state={state} />
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          Konto anlegen
        </Button>
      </div>
    </form>
  );
}

/** Aktionen je Konto (nicht am eigenen): sperren/entsperren, Zwei-Faktor zurücksetzen, neues Startpasswort. */
export function AccountActions({ id, username, locked }: { id: string; username: string; locked: boolean }) {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(accountAction, {});
  const button = (what: string, label: string, variant: "secondary" | "ghost" | "danger" = "ghost") => (
    <Button type="submit" name="what" value={what} size="sm" variant={variant} disabled={pending}>
      {label}
    </Button>
  );
  return (
    <form action={action} aria-label={`Aktionen ${username}`} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="username" value={username} />
      <div className="flex flex-wrap gap-1">
        {locked ? button("unlock", "Entsperren", "secondary") : button("lock", "Sperren", "danger")}
        {button("2fa", "Zwei-Faktor zurücksetzen")}
        {button("password", "Neues Startpasswort")}
      </div>
      <Feedback state={state} />
    </form>
  );
}
