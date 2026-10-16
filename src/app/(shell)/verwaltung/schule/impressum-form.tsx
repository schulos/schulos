"use client";

import Link from "next/link";
import { useActionState } from "react";
import { IMPRESSUM_FIELD_DEFS, type ImpressumFields } from "@/core/school/impressum-fields";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Textarea } from "@schulos/ui/field";

/** Impressum als einzelne Felder nach § 5 DDG (Q5-22); bisheriger Freitext (P4-33) wird angezeigt, bis alles ausgefüllt ist. */
export function ImpressumForm({
  action,
  initial,
  legacyText,
  missing,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial: ImpressumFields;
  legacyText: string;
  missing: string[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Impressum" className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-muted">
        Erscheint öffentlich unter /impressum (Pflicht für die öffentliche Schulanmeldung). Die Felder folgen den Angaben nach § 5 DDG – ob sie für
        Ihre Schule vollständig sind, prüft die Schule bzw. der Schulträger.
      </p>
      {missing.length > 0 ? (
        <p role="note" data-testid="impressum-missing" className="max-w-3xl rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
          Impressum unvollständig – es fehlt: {missing.join(", ")}. Ohne vollständiges Impressum lässt sich keine Schulanmeldung veröffentlichen.
        </p>
      ) : (
        <p data-testid="impressum-complete" className="text-sm text-success">
          Alle Pflichtangaben sind ausgefüllt.
        </p>
      )}
      {legacyText && (
        <section aria-label="Bisheriger Freitext" className="max-w-3xl rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
          <p className="font-medium">Bisheriger Freitext</p>
          <p className="mb-2 text-muted">Wird öffentlich angezeigt, bis alle Pflichtfelder ausgefüllt sind; danach wird er entfernt. Übertragen Sie die Angaben in die Felder.</p>
          <p className="whitespace-pre-line" data-testid="impressum-legacy">
            {legacyText}
          </p>
        </section>
      )}
      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        {IMPRESSUM_FIELD_DEFS.map((d) => (
          <Field
            key={d.key}
            label={d.label}
            hint={[d.required ? "Pflicht" : null, d.hint].filter(Boolean).join(" · ") || undefined}
            error={fe[d.key]}
            className={d.multiline || d.max > 200 ? "sm:col-span-2" : undefined}
          >
            {d.multiline ? (
              <Textarea name={d.key} rows={4} maxLength={d.max} defaultValue={state.values?.[d.key] ?? initial[d.key]} />
            ) : (
              <Input
                name={d.key}
                type={d.key === "email" ? "email" : d.key === "phone" ? "tel" : "text"}
                inputMode={d.key === "postalCode" ? "numeric" : undefined}
                maxLength={d.max}
                defaultValue={state.values?.[d.key] ?? initial[d.key]}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Impressum speichern"}
        </Button>
        <Link href="/impressum" className="text-sm text-accent-ink underline underline-offset-2">
          Öffentliche Seite ansehen
        </Link>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
