"use client";

import { useActionState, useState } from "react";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";
import { preview, type Retention } from "@schulos/server/backup-retention";
import { RESTORE_SCOPE_LABEL } from "@schulos/server/agent-api";
import {
  createRestoreAction,
  replacementCodeAction,
  retentionAction,
  scheduleAction,
  type FormResult,
  type ReplacementCodeState,
  type RestoreFormState,
} from "./actions";

function Result({ state }: { state: FormResult }) {
  if (state.error)
    return (
      <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
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

export function ScheduleForm({ id, schedule }: { id: string; schedule: string[] }) {
  const [state, action, pending] = useActionState<FormResult, FormData>(scheduleAction, {});
  return (
    <form action={action} aria-label="Zeitplan" className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <Field label="Uhrzeiten (täglich)" hint="Eine bis vier, z. B. „01:30“ oder „01:30, 12:30“. Vor jedem App-Update sichert SchulOS zusätzlich.">
        <Input name="schedule" defaultValue={schedule.join(", ")} required className="w-64" />
      </Field>
      <Result state={state} />
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          Zeitplan speichern
        </Button>
      </div>
    </form>
  );
}

/** Aufbewahrung mit Live-Vorschau: wie viele Stände bleiben, wie alt der älteste wird – und ab 3 Monaten die Pflicht-Begründung. */
export function RetentionForm({ id, retention, reason }: { id: string; retention: Retention; reason: string | null }) {
  const [state, action, pending] = useActionState<FormResult, FormData>(retentionAction, {});
  // kontrolliert: React setzt Formulare nach einer Action zurück – Eingaben und Vorschau sollen nach einem Fehler stehen bleiben
  const [v, setV] = useState({ daily: String(retention.daily), weekly: String(retention.weekly), monthly: String(retention.monthly) });
  const p = preview({ daily: Number(v.daily) || 0, weekly: Number(v.weekly) || 0, monthly: Number(v.monthly) || 0 });
  const field = (key: keyof Retention) => ({ name: key, value: v[key], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [key]: e.target.value }) });
  const [why, setWhy] = useState(reason ?? "");
  return (
    <form action={action} aria-label="Aufbewahrung" className="flex flex-col gap-4">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap gap-4">
        <Field label="Tagesstände" error={state.errors?.daily}>
          <Input type="number" min={1} max={60} {...field("daily")} className="w-28" />
        </Field>
        <Field label="Wochenstände" error={state.errors?.weekly}>
          <Input type="number" min={0} max={26} {...field("weekly")} className="w-28" />
        </Field>
        <Field label="Monatsstände" error={state.errors?.monthly}>
          <Input type="number" min={0} max={24} {...field("monthly")} className="w-28" />
        </Field>
      </div>
      <p aria-label="Vorschau Aufbewahrung" className="text-sm">
        Es bleiben höchstens <strong>{p.maxSnapshots}</strong> Stände, der älteste ist <strong>{p.oldestLabel}</strong> alt. So lange stecken
        auch gelöschte Daten noch in den Sicherungen.
      </p>
      {p.needsReason && (
        <>
          <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
            Länger als 3 Monate widerspricht der Vorgabe im Löschkonzept (LK-BACKUP: 14/4/3). Nur mit Begründung, die im Protokoll steht.
          </p>
          <Field label="Begründung" error={state.errors?.reason}>
            <Textarea name="reason" value={why} onChange={(e) => setWhy(e.target.value)} rows={2} maxLength={500} />
          </Field>
        </>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          {state.ok}
        </p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          Aufbewahrung speichern
        </Button>
      </div>
    </form>
  );
}

/** Auftrag „auf Hauptsystem wiederherstellen“: Stand + Umfang wählen; danach wird der Bestätigungscode einmal angezeigt. */
export function RestoreForm({ id, snapshots }: { id: string; snapshots: { id: string; shortId: string; time: string; label: string }[] }) {
  const [state, action, pending] = useActionState<RestoreFormState, FormData>(createRestoreAction, {});
  return (
    <form action={action} aria-label="Wiederherstellen" className="flex flex-col gap-4">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap gap-4">
        <Field label="Stand">
          <Select name="snapshot" required>
            {snapshots.map((s) => (
              <option key={s.id} value={`${s.id}|${s.shortId}|${s.time}`}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Umfang">
          <Select name="scope" defaultValue="dateien">
            <option value="dateien">{RESTORE_SCOPE_LABEL.dateien}</option>
            <option value="komplett">{RESTORE_SCOPE_LABEL.komplett}</option>
          </Select>
        </Field>
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.code && (
        <div className="flex flex-col gap-1 rounded-xl border border-warn bg-warn-soft p-4 text-sm">
          <span>
            Auftrag für Stand <strong>{state.snapshot}</strong> ({state.scope}) angelegt. Er läuft erst, wenn jemand im Hauptsystem unter
            Verwaltung → Backup diesen Code eingibt:
          </span>
          <output aria-label="Bestätigungscode" className="font-mono text-2xl font-semibold tracking-[0.3em]">
            {state.code}
          </output>
          <span className="text-muted">Der Code wird nur jetzt angezeigt. Nach fünf falschen Eingaben wird der Auftrag verworfen.</span>
        </div>
      )}
      <div>
        <Button type="submit" variant="danger" size="sm" disabled={pending}>
          Wiederherstellung anfordern
        </Button>
      </div>
    </form>
  );
}

const fmtLong = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

/** Ersatz-Kopplungscode (neue Hardware) – einmal angezeigt. */
export function ReplacementCodeForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<ReplacementCodeState, FormData>(replacementCodeAction, {});
  return (
    <form action={action} aria-label="Ersatz-Kopplung" className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      {state.code && (
        <div className="flex flex-col gap-1 rounded-xl bg-surface-2 p-3 text-sm">
          <span>Im Installer des neuen Hauptsystems „aus Backup wiederherstellen“ wählen und diesen Code eingeben:</span>
          <output aria-label="Ersatz-Kopplungscode" className="font-mono text-2xl font-semibold tracking-widest">
            {state.code}
          </output>
          <span className="text-muted">Gültig bis {fmtLong.format(new Date(state.expiresAt!))} Uhr, einmal. Der bisherige Zugang dieser Instanz wird dabei ungültig.</span>
        </div>
      )}
      <div>
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          Ersatz-Kopplungscode erzeugen
        </Button>
      </div>
    </form>
  );
}
