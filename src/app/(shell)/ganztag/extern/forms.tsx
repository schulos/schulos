"use client";

import { useActionState, useState, useTransition } from "react";
import { createExternalAction, endExternalAction, extendExternalAction, type ExternalState } from "@/modules/ganztag/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input, Select } from "@schulos/ui/field";

function Status({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p role="status" className="text-sm text-muted">
        {state.message}
      </p>
    );
  return null;
}

/** GT-13: Konto für eine externe Leitung anlegen – Startdaten werden einmal angezeigt. */
export function CreateExternalForm({ offers }: { offers: { id: string; name: string; expiresOn: string }[] }) {
  const [state, action, pending] = useActionState(createExternalAction, {} as ExternalState);
  const v = state.values;
  const [group, setGroup] = useState(v?.groupId ?? offers[0]!.id);
  const [expires, setExpires] = useState(v?.expiresOn ?? offers[0]!.expiresOn);
  return (
    <form action={action} aria-label="Externe Leitung anlegen" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vorname" error={state.fieldErrors?.firstName}>
          <Input name="firstName" required defaultValue={v?.firstName} autoComplete="off" />
        </Field>
        <Field label="Nachname" error={state.fieldErrors?.lastName}>
          <Input name="lastName" required defaultValue={v?.lastName} autoComplete="off" />
        </Field>
        <Field label="E-Mail (freiwillig)" error={state.fieldErrors?.email} hint="Für Benachrichtigungen und „Passwort vergessen“">
          <Input name="email" type="email" defaultValue={v?.email} autoComplete="off" />
        </Field>
        <Field label="Anbieter" error={state.fieldErrors?.provider} hint="Verein, Musikschule, Träger …">
          <Input name="provider" required maxLength={80} defaultValue={v?.provider} />
        </Field>
        <Field label="Angebot" error={state.fieldErrors?.groupId}>
          <Select
            name="groupId"
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
              setExpires(offers.find((o) => o.id === e.target.value)?.expiresOn ?? expires);
            }}
          >
            {offers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Befristet bis" error={state.fieldErrors?.expiresOn} hint="Vorgabe: Ende der Terminserie bzw. des Schuljahres">
          <Input name="expiresOn" type="date" required value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="confidentiality" className="mt-1 size-4 accent-[var(--accent)]" required defaultChecked={v?.confidentiality === "on"} />
        <span>Die Person ist von der Schule schriftlich auf Vertraulichkeit verpflichtet.</span>
      </label>
      {state.fieldErrors?.confidentiality && (
        <p role="alert" className="text-sm text-danger">
          {state.fieldErrors.confidentiality}
        </p>
      )}
      <FieldActions>
        <Button type="submit" variant="primary" disabled={pending}>
          Konto anlegen
        </Button>
      </FieldActions>
      <Status state={state} />
      {state.credentials && (
        <div role="status" aria-label="Startdaten" className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
          <p className="font-medium">Startdaten – nur jetzt sichtbar, bitte persönlich übergeben:</p>
          <p>
            Benutzername: <span className="font-mono">{state.credentials.username}</span>
          </p>
          <p>
            Startpasswort: <span className="font-mono">{state.credentials.password}</span>
          </p>
          <p className="text-muted">Bei der ersten Anmeldung: Passwort ändern und Zwei-Faktor-Anmeldung einrichten (im Schulnetz oder mit Freigabe der Verwaltung).</p>
        </div>
      )}
    </form>
  );
}

/** Verlängern bzw. sofort beenden. */
export function ExternalActions({ userId, name, expiresOn, active }: { userId: string; name: string; expiresOn: string; active: boolean }) {
  const [state, action, pending] = useActionState(extendExternalAction.bind(null, userId), {} as FormState);
  const [ended, setEnded] = useState<string | null>(null);
  const [ending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <form action={action} aria-label={`Befristung verlängern: ${name}`} className="flex flex-wrap items-end gap-2">
        <Field label="Neues Ablaufdatum" error={state.fieldErrors?.expiresOn}>
          <Input name="expiresOn" type="date" required defaultValue={expiresOn} />
        </Field>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {active ? "Verlängern" : "Wieder freigeben"}
        </Button>
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={ending}
            onClick={() => {
              if (!window.confirm(`Zugang von ${name} jetzt beenden?`)) return;
              start(async () => {
                const r = await endExternalAction(userId);
                setEnded(r.error ?? r.message ?? null);
              });
            }}
          >
            Zugang beenden
          </Button>
        )}
      </form>
      <Status state={state} />
      {ended && (
        <p role="status" className="text-sm text-muted">
          {ended}
        </p>
      )}
    </div>
  );
}
