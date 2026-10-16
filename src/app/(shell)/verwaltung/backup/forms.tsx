"use client";

import { useActionState, useState } from "react";
import {
  pairAction,
  restoreDecisionAction,
  runNowAction,
  type PairFormState,
  type RestoreConfirmState,
  type RunNowState,
} from "@/modules/verwaltung/backup-actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

export function PairForm({ defaultName }: { defaultName: string }) {
  const [state, action, pending] = useActionState<PairFormState, FormData>(pairAction, {});
  const v = state.values;
  return (
    // key: nach einem Fehler mit den eingegebenen Werten neu aufbauen (React setzt Formulare nach einer Action zurück)
    <form key={JSON.stringify(v ?? {})} action={action} aria-label="Backupserver koppeln" className="flex flex-col gap-4">
      <Field label="Adresse des Backupservers" hint="z. B. https://backup.schule.de">
        <Input name="backupUrl" type="url" required defaultValue={v?.backupUrl} placeholder="https://" />
      </Field>
      <Field label="Kopplungscode" hint="Auf dem Backupserver unter Instanzen erzeugen – zwölf Zeichen, 24 Stunden gültig.">
        <Input name="code" required autoComplete="off" className="w-56 font-mono tracking-widest uppercase" placeholder="XXXX-XXXX-XXXX" />
      </Field>
      <Field label="Name dieser Instanz auf dem Backupserver">
        <Input name="instanceName" required maxLength={80} defaultValue={v?.instanceName ?? defaultName} />
      </Field>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Koppeln …" : "Koppeln"}
        </Button>
      </div>
    </form>
  );
}

export function UnpairForm({ action }: { action: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm)
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(true)}>
        Entkoppeln …
      </Button>
    );
  return (
    <form action={action} aria-label="Entkoppeln" className="flex flex-col gap-2 rounded-xl border border-danger bg-danger-soft p-3 text-sm">
      <p>
        SchulOS sichert danach nicht mehr. Die Zugangsdaten werden hier gelöscht; auf dem Backupserver die Instanz zusätzlich entkoppeln. Die
        vorhandenen Sicherungen bleiben dort erhalten.
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

export function RunNowForm() {
  const [state, action, pending] = useActionState<RunNowState>(runNowAction, {});
  return (
    <form action={action} aria-label="Jetzt sichern" className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Wird angefordert …" : "Jetzt sichern"}
      </Button>
      {state.ok && (
        <span role="status" className="text-sm text-success">
          Angefordert – der Backup-Agent startet innerhalb einer Minute.
        </span>
      )}
      {state.error && (
        <span role="alert" className="text-sm text-danger">
          {state.error}
        </span>
      )}
    </form>
  );
}

/** Wiederherstellungsauftrag vom Backupserver bestätigen (Code von dort) oder ablehnen. */
export function RestoreDecisionForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<RestoreConfirmState, FormData>(restoreDecisionAction, {});
  return (
    <form action={action} aria-label="Wiederherstellung bestätigen" className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <Field label="Bestätigungscode vom Backupserver">
        <Input name="code" inputMode="numeric" autoComplete="off" maxLength={7} className="w-40 font-mono tracking-widest" />
      </Field>
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
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="entscheidung" value="bestaetigen" variant="danger" size="sm" disabled={pending}>
          Wiederherstellung bestätigen
        </Button>
        <Button type="submit" name="entscheidung" value="ablehnen" variant="ghost" size="sm" disabled={pending}>
          Ablehnen
        </Button>
      </div>
    </form>
  );
}
