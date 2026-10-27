"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input, Segmented, Select } from "@schulos/ui/field";

type Source = "live_copy" | "empty" | "previous_version";

/** SP3-01: Entwurf anlegen – Ausgangsbasis, Stichtag, Nummer (neue Planung/Folgeversion), Name. */
export function DraftForm({
  action,
  schoolYearId,
  suggestion,
  bounds,
  numbers,
  validLabel,
  previous,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  schoolYearId: string;
  suggestion: string | null;
  bounds: { min: string; max: string };
  /** vorgesehene Nummern: neue Planung bzw. Folgeversion (null = keine gültige Version) */
  numbers: { major: string; minor: string | null };
  /** gültige Version, aus der „aus dem gültigen Plan“ kopiert */
  validLabel: string | null;
  previous: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const [source, setSource] = useState<Source>((v.source as Source | undefined) ?? (validLabel ? "live_copy" : "empty"));
  const [numbering, setNumbering] = useState<"major" | "minor">(v.numbering === "minor" && numbers.minor ? "minor" : "major");
  const sources: { value: Source; label: string }[] = [
    ...(validLabel ? [{ value: "live_copy" as const, label: "Aus dem gültigen Plan" }] : []),
    { value: "empty", label: "Leer" },
    ...(previous.length ? [{ value: "previous_version" as const, label: "Aus Vorversion" }] : []),
  ];
  const hint =
    source === "live_copy"
      ? `Kopiert alle Stunden, die ab dem Stichtag gelten (Version ${validLabel}). Der gültige Plan bleibt unverändert.`
      : source === "empty"
        ? "Ein Entwurf ohne Stunden – zum Neuplanen, auf Wunsch mit den fixierten Stunden."
        : "Kopiert eine archivierte oder verworfene Version dieses Schuljahrs.";
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Entwurf anlegen" className="flex flex-col gap-4">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <input type="hidden" name="schoolYearId" value={schoolYearId} />
      <Segmented legend="Ausgangsbasis" name="source" value={source} onChange={setSource} options={sources} />
      <p className="-mt-2 text-sm text-muted">{hint}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Gültig ab (Stichtag)" hint="ein Schultag im Schuljahr, nach heute" error={fe.validFrom}>
          <Input type="date" name="validFrom" required min={bounds.min} max={bounds.max} defaultValue={v.validFrom ?? suggestion ?? ""} />
        </Field>
        {source === "previous_version" && (
          <Field label="Vorversion" error={fe.previousVersionId}>
            <Select name="previousVersionId" defaultValue={v.previousVersionId ?? previous[0]?.id}>
              {previous.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Name" hint="optional, z. B. „2. Halbjahr“ – keine Personen nennen" error={fe.name} className="sm:col-span-2">
          <Input name="name" maxLength={80} defaultValue={v.name ?? ""} />
        </Field>
      </div>
      <Segmented
        legend="Nummer"
        name="numbering"
        value={numbering}
        onChange={setNumbering}
        options={[
          { value: "major", label: `Neue Planung (${numbers.major})` },
          ...(numbers.minor ? [{ value: "minor" as const, label: `Folgeversion (${numbers.minor})` }] : []),
        ]}
      />
      {fe.numbering && <p className="-mt-2 text-xs text-danger">{fe.numbering}</p>}
      {source === "empty" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="withFixed" defaultChecked={v.withFixed === "on"} className="size-4 accent-accent" />
          Fixierte Stunden des gültigen Plans übernehmen
        </label>
      )}
      <FieldActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird angelegt …" : "Entwurf anlegen"}
        </Button>
      </FieldActions>
    </form>
  );
}
