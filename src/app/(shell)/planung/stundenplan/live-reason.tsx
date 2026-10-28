import { Field, Input } from "@schulos/ui/field";

/** SP3-05: Hinweis „Sofort-Korrektur ab …“ und optionale Begründung (Protokoll, ≤ 120 Zeichen) – nur bei laufenden Stunden im gültigen Plan. */
export function LiveReason({ note, error, defaultValue, className }: { note: string; error?: string; defaultValue?: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-3 rounded-xl border border-warn-border bg-warn-soft p-3 ${className ?? ""}`}>
      <p data-testid="sofortkorrektur-hinweis" className="text-sm">
        {note}
      </p>
      <Field label="Begründung (optional)" hint="fürs Protokoll, z. B. „Raumtausch Brandschutz“ – keine Personen, keine Gesundheitsangaben" error={error}>
        <Input name="reason" maxLength={120} defaultValue={defaultValue ?? ""} />
      </Field>
    </div>
  );
}
