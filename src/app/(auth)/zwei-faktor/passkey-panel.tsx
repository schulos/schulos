"use client";

import { browserSupportsWebAuthn, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { useActionState, useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { passkeyRegistrationFinishAction, passkeyRegistrationStartAction, passkeyRemoveAction } from "./passkey-actions";

export interface PasskeyRow {
  id: string;
  name: string;
  synced: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" });

const noSubscribe = () => () => {};
/** Kann der Browser WebAuthn? (auf dem Server: annehmen, dass ja – kein Flackern) */
function useWebAuthnSupport(): boolean {
  return useSyncExternalStore(noSubscribe, browserSupportsWebAuthn, () => true);
}

/** Meldung, wenn der Browser die Zeremonie abbricht (Abbrechen, Zeitlimit, Schlüssel schon eingerichtet). */
export function webAuthnMessage(err: unknown): string {
  if (err instanceof WebAuthnError && err.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "Dieser Schlüssel ist schon eingerichtet.";
  if (err instanceof Error && err.name === "NotAllowedError") return "Abgebrochen oder Zeit abgelaufen. Bitte noch einmal versuchen.";
  return "Der Schlüssel hat nicht geantwortet. Bitte noch einmal versuchen.";
}

/** SEC-03: Liste der eigenen Sicherheitsschlüssel + Einrichten eines weiteren. */
export function PasskeyPanel({ keys, canAdd, blockedText, grund }: { keys: PasskeyRow[]; canAdd: boolean; blockedText: string; grund?: string }) {
  return (
    <div className="flex flex-col gap-4">
      {keys.length > 0 ? (
        <ul aria-label="Eingerichtete Schlüssel" className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {keys.map((k) => (
            <PasskeyItem key={k.id} row={k} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Noch kein Schlüssel eingerichtet.</p>
      )}
      {canAdd ? (
        <AddPasskeyForm grund={grund} />
      ) : (
        <p role="note" className="text-sm text-muted">
          {blockedText}
        </p>
      )}
    </div>
  );
}

function PasskeyItem({ row }: { row: PasskeyRow }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(passkeyRemoveAction, {});
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{row.name}</span>
        <span className="text-xs text-muted">
          {row.synced ? "Passkey (synchronisiert)" : "Sicherheitsschlüssel"} · eingerichtet {day(row.createdAt)}
          {row.lastUsedAt ? ` · zuletzt benutzt ${day(row.lastUsedAt)}` : ""}
        </span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(!open)} aria-expanded={open}>
          Entfernen …
        </Button>
      </div>
      {open && (
        <form action={action} aria-label={`Schlüssel „${row.name}“ entfernen`} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={row.id} />
          <Field label="Passwort zur Bestätigung" className="min-w-56 flex-1">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          <Button type="submit" variant="danger" disabled={pending}>
            Schlüssel entfernen
          </Button>
          {state.error && (
            <p role="alert" className="w-full rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          )}
        </form>
      )}
    </li>
  );
}

function AddPasskeyForm({ grund }: { grund?: string }) {
  const [error, setError] = useState<string | null>(null);
  const supported = useWebAuthnSupport();
  const [pending, start] = useTransition();

  function submit(form: FormData) {
    setError(null);
    const name = String(form.get("name") ?? "");
    const password = String(form.get("password") ?? "");
    start(async () => {
      const res = await passkeyRegistrationStartAction(password);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      let response;
      try {
        response = await startRegistration({ optionsJSON: res.options });
      } catch (err) {
        setError(webAuthnMessage(err));
        return;
      }
      const done = await passkeyRegistrationFinishAction(response, name, grund);
      if (done?.error) setError(done.error);
    });
  }

  if (!supported) return <p className="text-sm text-muted">Dieser Browser unterstützt keine Sicherheitsschlüssel.</p>;
  return (
    // onSubmit statt action: eine Form-Action setzt die Felder zurück – nach „Passwort falsch“ wäre der Name weg
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget));
      }}
      aria-label="Schlüssel hinzufügen"
      className="flex flex-col gap-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name des Schlüssels" hint="z. B. „Schlüssel blau“ oder „Handy“ – damit du ihn später erkennst.">
          <Input name="name" maxLength={60} autoComplete="off" />
        </Field>
        <Field label="Passwort zur Bestätigung">
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Warte auf den Schlüssel …" : "Schlüssel hinzufügen"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
