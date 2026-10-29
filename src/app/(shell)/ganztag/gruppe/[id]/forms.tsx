"use client";

import { Ban, RotateCcw, Trash2 } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import {
  createSeriesAction,
  createSessionAction,
  deleteSeriesAction,
  deleteSessionAction,
  setCancelledAction,
  setOfferSettingsAction,
  type ActionResult,
} from "@/modules/ganztag/actions";
import type { OfferSettings } from "@/modules/ganztag/service";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input, Select } from "@schulos/ui/field";

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];

function Status({ state }: { state: FormState | ActionResult }) {
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

export function SeriesForm({ groupId, defaults }: { groupId: string; defaults: { validFrom: string; validTo: string } }) {
  const [state, action, pending] = useActionState(createSeriesAction.bind(null, groupId), {});
  const v = state.values;
  return (
    <form key={state.ok ? state.message : "form"} action={action} aria-label="Serie anlegen" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Wochentag" error={state.fieldErrors?.weekday}>
          <Select name="weekday" defaultValue={v?.weekday ?? "0"}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Beginn" error={state.fieldErrors?.startsAt}>
          <Input name="startsAt" type="time" required defaultValue={v?.startsAt ?? "14:00"} />
        </Field>
        <Field label="Ende" error={state.fieldErrors?.endsAt}>
          <Input name="endsAt" type="time" required defaultValue={v?.endsAt ?? "15:30"} />
        </Field>
        <Field label="Gültig ab" error={state.fieldErrors?.validFrom}>
          <Input name="validFrom" type="date" required defaultValue={v?.validFrom ?? defaults.validFrom} />
        </Field>
        <Field label="Gültig bis" error={state.fieldErrors?.validTo} hint="Ferien und Feiertage werden übersprungen">
          <Input name="validTo" type="date" required defaultValue={v?.validTo ?? defaults.validTo} />
        </Field>
        <FieldActions>
          <Button type="submit" variant="primary" disabled={pending}>
            Serie anlegen
          </Button>
        </FieldActions>
      </div>
      <Status state={state} />
    </form>
  );
}

export function SessionForm({ groupId, today }: { groupId: string; today: string }) {
  const [state, action, pending] = useActionState(createSessionAction.bind(null, groupId), {});
  const v = state.values;
  return (
    <form key={state.ok ? `ok-${state.message}` : "form"} action={action} aria-label="Einzeltermin anlegen" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Datum" error={state.fieldErrors?.date}>
          <Input name="date" type="date" required defaultValue={v?.date ?? today} />
        </Field>
        <Field label="Beginn" error={state.fieldErrors?.startsAt}>
          <Input name="startsAt" type="time" required defaultValue={v?.startsAt ?? "14:00"} />
        </Field>
        <Field label="Ende" error={state.fieldErrors?.endsAt}>
          <Input name="endsAt" type="time" required defaultValue={v?.endsAt ?? "15:30"} />
        </Field>
        <FieldActions>
          <Button type="submit" disabled={pending}>
            Termin anlegen
          </Button>
        </FieldActions>
      </div>
      <Status state={state} />
    </form>
  );
}

export function DeleteSeries({ id, label }: { id: string; label: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={`Serie ${label} löschen`}
        onClick={() => {
          if (confirm("Serie löschen? Noch nicht erfasste Termine fallen weg, erfasste bleiben.")) start(async () => setResult(await deleteSeriesAction(id)));
        }}
      >
        <Trash2 aria-hidden />
      </Button>
      <Status state={result} />
    </>
  );
}

/** Ausfall markieren/zurücknehmen und Termin löschen. */
export function SessionActions({ id, label, cancelled, canDelete, back = false }: { id: string; label: string; cancelled: boolean; canDelete: boolean; back?: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  return (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap gap-1">
        {cancelled ? (
          <Button size="sm" disabled={pending} aria-label={`${label} findet statt`} onClick={() => start(async () => setResult(await setCancelledAction(id, false)))}>
            <RotateCcw aria-hidden /> Findet statt
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={pending}
            aria-label={`${label} fällt aus`}
            onClick={() => {
              if (confirm("Termin fällt aus? Teilnehmende und Eltern bekommen einen Hinweis.")) start(async () => setResult(await setCancelledAction(id, true)));
            }}
          >
            <Ban aria-hidden /> Fällt aus
          </Button>
        )}
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            aria-label={`${label} löschen`}
            onClick={() => {
              if (confirm("Termin löschen?")) start(async () => setResult(await deleteSessionAction(id, back)));
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        )}
      </span>
      <Status state={result} />
    </div>
  );
}

const SETTING_ITEMS: { name: keyof OfferSettings; label: string; hint: string }[] = [
  { name: "mandatory", label: "Verpflichtendes Angebot", hint: "Unentschuldigtes Fehlen geht abends gebündelt als Hinweis an die Klassenleitung – kein Eintrag ins Klassenbuch." },
  { name: "notifyClassLead", label: "Klassenleitung benachrichtigen", hint: "Nur bei verpflichtenden Angeboten." },
  { name: "prefillAbsences", label: "Krankmeldungen und Beurlaubungen vorbelegen", hint: "„fehlt (entschuldigt)“ steht dann schon in der Liste – nur die Quelle, nie der Grund; die Leitung kann ändern." },
];

/** GT-04: Einstellungen des Angebots (nur „Ganztag verwalten“). */
export function OfferSettingsForm({ groupId, settings }: { groupId: string; settings: OfferSettings }) {
  const [state, action, pending] = useActionState(setOfferSettingsAction.bind(null, groupId), {});
  return (
    <form action={action} aria-label="Einstellungen des Angebots" className="flex flex-col gap-3">
      {SETTING_ITEMS.map((i) => (
        <label key={i.name} className="flex min-h-11 items-start gap-3">
          <input type="checkbox" name={i.name} defaultChecked={settings[i.name]} className="mt-1 size-4 accent-[var(--accent)]" />
          <span className="flex flex-col">
            <span className="font-medium">{i.label}</span>
            <span className="text-xs text-muted">{i.hint}</span>
          </span>
        </label>
      ))}
      <div>
        <Button type="submit" disabled={pending}>
          Einstellungen speichern
        </Button>
      </div>
      <Status state={state} />
    </form>
  );
}
