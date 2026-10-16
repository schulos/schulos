"use client";

import { useActionState, useState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { createCodeAction, renameAction, unpairAction, type CodeState, type RenameState } from "./actions";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

/** Code erzeugen – er wird genau einmal angezeigt (gespeichert ist nur ein Suchschlüssel). */
export function CreateCodeForm() {
  const [state, action, pending] = useActionState<CodeState>(createCodeAction, {});
  return (
    <form action={action} aria-label="Kopplungscode erzeugen" className="flex flex-col gap-4">
      {state.code ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">Diesen Code im Hauptsystem unter Verwaltung → Backup eingeben, zusammen mit der Adresse dieses Servers:</p>
          <output aria-label="Kopplungscode" className="w-fit rounded-xl bg-surface-2 px-4 py-3 font-mono text-2xl font-semibold tracking-widest">
            {state.code}
          </output>
          <p className="text-sm text-muted">
            Gültig bis {fmt.format(new Date(state.expiresAt!))} Uhr und nur einmal. Er wird nur jetzt angezeigt.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">Ein Code koppelt genau ein Hauptsystem und gilt 24 Stunden.</p>
      )}
      <div>
        <Button type="submit" variant={state.code ? "secondary" : "primary"} disabled={pending}>
          {state.code ? "Weiteren Code erzeugen" : "Kopplungscode erzeugen"}
        </Button>
      </div>
    </form>
  );
}

export function RenameForm({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useActionState<RenameState, FormData>(renameAction, {});
  return (
    <form action={action} aria-label={`${name} umbenennen`} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <Field label="Name" error={state.error}>
        <Input name="name" defaultValue={name} required maxLength={80} className="w-72" />
      </Field>
      <Button type="submit" size="sm" disabled={pending}>
        Umbenennen
      </Button>
    </form>
  );
}

export function UnpairForm({ id, name }: { id: string; name: string }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm)
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(true)}>
        Entkoppeln …
      </Button>
    );
  return (
    <form action={unpairAction} aria-label={`${name} entkoppeln`} className="flex flex-col gap-2 rounded-xl border border-danger bg-danger-soft p-3 text-sm">
      <input type="hidden" name="id" value={id} />
      <p>
        „{name}“ kann danach nichts mehr sichern. Die vorhandenen Sicherungen bleiben auf diesem Server. Für eine neue Kopplung braucht das
        Hauptsystem einen neuen Code.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="danger">
          Entkoppeln
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}
