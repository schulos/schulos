"use client";

import { useActionState } from "react";
import { saveSecuritySettingsAction, type AnmeldungState } from "@/modules/verwaltung/anmeldung-actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

export function SecuritySettingsForm({
  schoolNets,
  defaultNets,
  twoFactorFrom,
  idleMinutes,
  idleOptions,
}: {
  schoolNets: string;
  defaultNets: string;
  twoFactorFrom: string;
  idleMinutes: number;
  idleOptions: { value: number; label: string }[];
}) {
  const [state, action, pending] = useActionState<AnmeldungState, FormData>(saveSecuritySettingsAction, {});
  return (
    <form action={action} aria-label="Anmelde-Einstellungen" className="flex flex-col gap-4">
      <Field
        label="Schulnetz (Adressbereiche)"
        hint={`CIDR-Bereiche, durch Leerzeichen oder Zeilen getrennt, z. B. 10.20.0.0/16. Leer = Vorgabe (${defaultNets}). Von dort gilt eine Anmeldung als „im Schulnetz“. Der SSH-Zugang zum Server folgt nicht automatisch – nach einer Änderung auf dem Server „sudo schulosctl ssh-netze <Bereiche>“ ausführen.`}
      >
        <Textarea name="schulnetz" rows={3} defaultValue={state.values?.schulnetz ?? schoolNets} placeholder={defaultNets} spellCheck={false} className="font-mono text-sm" />
      </Field>
      <Field
        label="Zwei-Faktor-Pflicht für Lehrkräfte, Personal und Eltern ab"
        hint="Bis dahin sehen sie nur einen Hinweis; ab dem Tag geht es ohne eingerichtete Zwei-Faktor-Anmeldung nicht mehr weiter. Verwaltung, Schulleitung, Beratung und Admin brauchen sie schon jetzt."
      >
        <Input type="date" name="stichtag" required defaultValue={state.values?.stichtag ?? twoFactorFrom} />
      </Field>
      <Field
        label="Abmelden nach Inaktivität"
        hint="Ohne Eingabe so lange, endet die Sitzung auf dem Gerät – automatisches Neuladen (Startseite, Vertretungsplan, Gong) zählt nicht. Bildschirme mit Vertretungsplan im Flur laufen über den Monitor-Modus ohne Anmeldung. Das Notenbuch sperrt unabhängig davon schon nach 15 Minuten."
      >
        <Select name="inaktiv" defaultValue={state.values?.inaktiv ?? String(idleMinutes)}>
          {idleOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {state.confirmOutside && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="eigene_adresse_aussen" className="mt-1" />
          <span>
            Trotzdem speichern – meine Adresse {state.confirmOutside} liegt danach außerhalb des Schulnetzes (zurück nur noch aus dem neuen
            Schulnetz oder per Kommandozeile <code>schulnetz-zuruecksetzen</code>).
          </span>
        </label>
      )}
      <div>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          Speichern
        </Button>
      </div>
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
    </form>
  );
}
