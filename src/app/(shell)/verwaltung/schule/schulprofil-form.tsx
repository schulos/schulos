"use client";

import { useActionState } from "react";
import type { SchulprofilImportState } from "@/modules/verwaltung/school-actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

/**
 * P4-77: Schulprofil exportieren (überall) bzw. einspielen (nur Demo-/Vorschau-Instanz). Export per POST-Formular an die
 * API-Route (Download, protokolliert), Import als Server Action mit Bericht.
 */
export function SchulprofilSection({
  importAction,
  demo,
}: {
  importAction: (prev: SchulprofilImportState, form: FormData) => Promise<SchulprofilImportState>;
  demo: boolean;
}) {
  const [state, formAction, pending] = useActionState(importAction, {});
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm text-muted">
        Das Schulprofil enthält den Zuschnitt dieser Schule – Name, Farbe, Bundesland und Schulform, Logos, eingeschaltete Module, Moduleinstellungen, Rechte
        der Rollen und den Inaktivitätsablauf. <strong>Keine Personendaten:</strong> keine Konten, Gruppen, Noten, Inhalte, kein Impressum und keine
        Datenschutztexte. Damit zeigt die Vorschau-Instanz die eigene Schule mit Demo-Personen.
      </p>
      <form method="post" action="/api/verwaltung/schulprofil">
        <Button type="submit" variant="secondary">
          Schulprofil exportieren
        </Button>
      </form>
      {demo ? (
        <form action={formAction} aria-label="Schulprofil einspielen" className="flex flex-col gap-3 border-t border-border pt-4">
          <Field
            label="Schulprofil-Datei"
            hint="JSON aus „Schulprofil exportieren“ der echten Schule – ersetzt Schuldaten, Logos, Module und Rechte der Rollen"
          >
            <Input name="file" type="file" accept="application/json,.json" required />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Einspielen …" : "Schulprofil einspielen"}
            </Button>
            {state.error && (
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
            )}
          </div>
          {state.ok && (
            <div role="status" className="text-sm">
              <p className="text-success">{state.summary}</p>
              {state.skipped && state.skipped.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted">Übersprungen ({state.skipped.length})</summary>
                  <ul className="mt-1 list-disc pl-5 text-muted">
                    {state.skipped.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </form>
      ) : (
        <p className="text-sm text-muted" data-testid="schulprofil-nur-vorschau">
          Einspielen geht nur in einer Demo- bzw. Vorschau-Instanz – nie in die echte Schule.
        </p>
      )}
    </div>
  );
}
