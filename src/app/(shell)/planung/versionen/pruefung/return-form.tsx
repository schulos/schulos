"use client";

import { Undo2 } from "lucide-react";
import { Button } from "@schulos/ui/button";
import { Field, Textarea } from "@schulos/ui/field";

/** SP3-03: „Zurück an die Planung“ (Prüfung gibt zurück, Freigabe zurücknehmen, Planung holt zurück) – optional mit Kommentar. */
export function ReturnForm({ action, label, withNote }: { action: (form: FormData) => Promise<void>; label: string; withNote: boolean }) {
  return (
    <form action={action} aria-label={label} className="flex flex-col gap-3">
      {withNote && (
        <Field label="Begründung (optional)" hint="wird als Kommentar an die ganze Version gespeichert – keine Gesundheitsangaben">
          <Textarea name="note" rows={2} maxLength={500} />
        </Field>
      )}
      <div>
        <Button type="submit" variant="secondary">
          <Undo2 aria-hidden /> {label}
        </Button>
      </div>
    </form>
  );
}
