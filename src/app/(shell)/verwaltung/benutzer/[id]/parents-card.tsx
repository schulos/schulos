"use client";

import Link from "next/link";
import { Link2Off, UserPlus } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { createParentAction, linkParentAction, unlinkParentAction, type FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { Credentials } from "../credentials";

function Msg({ state, ok }: { state: FormState; ok?: string }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {Object.values(state.fieldErrors ?? {})[0] ?? state.error}
      </p>
    );
  if (state.ok && ok)
    return (
      <p role="status" className="text-sm text-success">
        {ok}
      </p>
    );
  return null;
}

/**
 * Eltern eines Kindes (P4-38): verknüpfte Elternkonten mit „Lösen“, vorhandenes Elternkonto per Benutzername verknüpfen oder
 * ein neues anlegen (Startpasswort einmalig, E-Mail optional als Kontaktadresse). Nur bei Schüler:innen und ohne SEC-04-Sperre.
 */
export function ParentsCard({ childId, parents, canEdit }: { childId: string; parents: { id: string; name: string }[]; canEdit: boolean }) {
  const [unlinkState, setUnlinkState] = useState<FormState>({});
  const [pending, start] = useTransition();
  const [linkState, linkAction, linkPending] = useActionState(linkParentAction.bind(null, childId), {});
  const [newState, newAction, newPending] = useActionState(createParentAction.bind(null, childId), {});
  const [showNew, setShowNew] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {parents.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2">
            <Link href={`/verwaltung/benutzer/${p.id}`} className="font-medium hover:underline">
              {p.name}
            </Link>
            {canEdit && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Verknüpfung mit ${p.name} lösen`}
                disabled={pending}
                onClick={() => {
                  if (confirm(`Verknüpfung mit ${p.name} lösen? Das Elternkonto sieht danach keine Daten dieses Kindes mehr.`))
                    start(async () => setUnlinkState(await unlinkParentAction(p.id, childId)));
                }}
              >
                <Link2Off aria-hidden /> Lösen
              </Button>
            )}
          </li>
        ))}
        {parents.length === 0 && <li className="text-sm text-muted">Kein Elternkonto verknüpft</li>}
      </ul>
      <Msg state={unlinkState} />
      {canEdit && (
        <>
          <form key={linkState.ok ? "ok" : JSON.stringify(linkState.values ?? null)} action={linkAction} aria-label="Elternkonto verknüpfen" className="flex flex-wrap items-end gap-2">
            <Field label="Vorhandenes Elternkonto verknüpfen" hint="Benutzername, z. B. vorname.nachname" error={linkState.fieldErrors?.username ?? linkState.fieldErrors?.parent}>
              <Input name="username" defaultValue={linkState.values?.username ?? ""} placeholder="vorname.nachname" className="w-56" />
            </Field>
            <Button type="submit" size="sm" disabled={linkPending}>
              Verknüpfen
            </Button>
            <Msg state={linkState.error ? { ...linkState, fieldErrors: {} } : linkState} ok="Verknüpft." />
          </form>
          {newState.ok && newState.credentials ? (
            <Credentials title="Elternkonto angelegt" {...newState.credentials} />
          ) : showNew ? (
            <form action={newAction} aria-label="Neues Elternkonto" className="flex flex-col gap-3 rounded-xl border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Vorname" error={newState.fieldErrors?.firstName}>
                  <Input name="firstName" defaultValue={newState.values?.firstName ?? ""} required />
                </Field>
                <Field label="Nachname" error={newState.fieldErrors?.lastName}>
                  <Input name="lastName" defaultValue={newState.values?.lastName ?? ""} required />
                </Field>
                <Field label="E-Mail-Adresse (optional)" hint="Kontaktadresse; gilt erst nach Bestätigung durch die Person als bestätigt" error={newState.fieldErrors?.email} className="sm:col-span-2">
                  <Input name="email" type="email" defaultValue={newState.values?.email ?? ""} />
                </Field>
              </div>
              <Button type="submit" size="sm" variant="primary" disabled={newPending} className="self-start">
                Elternkonto anlegen und verknüpfen
              </Button>
              {newState.error && !newState.fieldErrors?.firstName && !newState.fieldErrors?.lastName && !newState.fieldErrors?.email && <Msg state={newState} />}
            </form>
          ) : (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setShowNew(true)}>
              <UserPlus aria-hidden /> Neues Elternkonto anlegen …
            </Button>
          )}
        </>
      )}
    </div>
  );
}
