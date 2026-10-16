"use client";

import { useActionState, useMemo } from "react";
import {
  issueDeviceCertAction,
  revokeDeviceCertAction,
  saveExternalSettingsAction,
  type GeraeteState,
  type IssueState,
} from "@/modules/verwaltung/geraete-actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

function Message({ state }: { state: GeraeteState }) {
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

export function ExternalSettingsForm({ staffCert, adminAllowed, caReady }: { staffCert: "an" | "aus" | null; adminAllowed: boolean | null; caReady: boolean }) {
  const [state, action, pending] = useActionState<GeraeteState, FormData>(saveExternalSettingsAction, {});
  return (
    <form action={action} aria-label="Regeln für den Zugriff von außen" className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Lehrkräfte und Personal von außen" hint={`Vorgabe: nur mit Gerätezertifikat, sobald die Schul-CA eingerichtet ist (jetzt: ${caReady ? "ja" : "nein"}).`}>
          <Select name="personal" defaultValue={staffCert ?? "vorgabe"}>
            <option value="vorgabe">Vorgabe</option>
            <option value="an">nur mit Gerätezertifikat</option>
            <option value="aus">auch ohne Gerätezertifikat</option>
          </Select>
        </Field>
        <Field label="Verwaltung und Admin von außen" hint="Vorgabe: gesperrt. Erlaubt gilt die Zertifikatspflicht wie für Personal – mit einem Zertifikat, das an genau dieses Konto gebunden ist.">
          <Select name="verwaltung" defaultValue={adminAllowed === null ? "vorgabe" : adminAllowed ? "erlaubt" : "gesperrt"}>
            <option value="vorgabe">Vorgabe (gesperrt)</option>
            <option value="gesperrt">gesperrt</option>
            <option value="erlaubt">erlaubt</option>
          </Select>
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          Regeln speichern
        </Button>
      </div>
      <Message state={state} />
    </form>
  );
}

const dataUrl = (type: string, base64: string) => `data:${type};base64,${base64}`;

export function IssueForm({ defaultDays, minDays, maxDays }: { defaultDays: number; minDays: number; maxDays: number }) {
  const [state, action, pending] = useActionState<IssueState, FormData>(issueDeviceCertAction, {});
  const issued = state.issued;
  const links = useMemo(
    () =>
      issued && {
        p12: dataUrl("application/x-pkcs12", issued.p12),
        mobileconfig: dataUrl("application/x-apple-aspen-config", issued.mobileconfig),
      },
    [issued],
  );
  return (
    <div className="flex flex-col gap-4">
      <form action={action} aria-label="Gerätezertifikat ausstellen" className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Gerät" hint="z. B. „iPad Lehrerzimmer 3“ – steht nur in SchulOS, nicht im Zertifikat">
            <Input name="label" required minLength={2} maxLength={80} autoComplete="off" />
          </Field>
          <Field label="Laufzeit (Tage)" hint={`${minDays}–${maxDays}`}>
            <Input name="tage" type="number" min={minDays} max={maxDays} defaultValue={defaultDays} required />
          </Field>
          <Field label="Nur für Konto (optional)" hint="Benutzername – dann gilt das Zertifikat nur für dieses Konto">
            <Input name="konto" autoComplete="off" />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={pending}>
            {pending ? "Wird ausgestellt …" : "Zertifikat ausstellen"}
          </Button>
        </div>
        <Message state={state} />
      </form>
      {issued && links && (
        <section aria-label="Neues Zertifikat" className="flex flex-col gap-3 rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm">
          <p>
            <strong>{issued.label}</strong> ({issued.commonName}) – gültig bis {new Date(issued.notAfter).toLocaleDateString("de-DE")}.
          </p>
          <p>
            Passwort der Datei (wird <strong>nur jetzt</strong> angezeigt, SchulOS speichert weder Passwort noch Schlüssel):{" "}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-base select-all" aria-label="Passwort der Datei">
              {issued.password}
            </code>
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={links.p12} download={`${issued.commonName}.p12`} className="text-accent-ink underline underline-offset-2">
              .p12 herunterladen (Windows, Android, Intune, Relution)
            </a>
            <a href={links.mobileconfig} download={`${issued.commonName}.mobileconfig`} className="text-accent-ink underline underline-offset-2">
              .mobileconfig herunterladen (iPad/Mac, Apple-MDM – enthält das Passwort)
            </a>
          </div>
          <p className="text-muted">
            Dateien nur verschlüsselt weitergeben bzw. direkt ins MDM laden und danach löschen. Fingerabdruck:{" "}
            <code className="font-mono text-xs break-all">{issued.fingerprint}</code>
          </p>
        </section>
      )}
    </div>
  );
}

export function RevokeForm({ id, label }: { id: string; label: string }) {
  const [state, action, pending] = useActionState<GeraeteState, FormData>(revokeDeviceCertAction, {});
  return (
    <form action={action} aria-label={`${label} sperren`} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Select name="grund" defaultValue="" required aria-label="Grund" className="w-auto">
        <option value="" disabled>
          Grund …
        </option>
        <option value="verloren">verloren/gestohlen</option>
        <option value="ausgemustert">Gerät ausgemustert</option>
        <option value="kompromittiert">Schlüssel kompromittiert</option>
        <option value="sonstiges">sonstiges</option>
      </Select>
      <Button type="submit" variant="danger" size="sm" disabled={pending}>
        Sperren
      </Button>
      <Message state={state} />
    </form>
  );
}
