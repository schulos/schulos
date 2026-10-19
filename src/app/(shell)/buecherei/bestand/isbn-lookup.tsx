"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createTitleAction, lookupIsbnAction } from "@/modules/buecherei/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { SpecForm } from "@/ui/spec-form";
import { newTitleFields } from "./title-fields";

/**
 * ISBN-Abfrage (BU-06): ISBN eingeben → der Server fragt die eingeschalteten Bibliothekskataloge (nur die ISBN geht nach
 * außen). Das Ergebnis ist nur ein Vorschlag im Formular „Titel anlegen“ – angelegt wird erst nach Prüfung.
 */
export function IsbnLookup({ sources }: { sources: string[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(lookupIsbnAction, {});
  const v = state.values ?? {};
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        <strong className="font-semibold text-ink">Externer Dienst:</strong> Die ISBN (und nur sie) wird vom Server an {sources.join(", ")} geschickt – der Reihe
        nach, bis eine Quelle etwas findet. Ohne Internetzugang erscheint nur ein Hinweis.
      </p>
      <form action={action} aria-label="ISBN nachschlagen" className="flex flex-wrap items-end gap-3">
        <Field label="ISBN" error={state.fieldErrors?.isbn}>
          <Input name="isbn" required maxLength={20} defaultValue={state.ok ? "" : (v.isbn ?? "")} className="w-56" inputMode="numeric" />
        </Field>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Frage nach …" : "Nachschlagen"}
        </Button>
      </form>
      {state.ok && v.result && (
        <p role="status" className={v.kind === "found" ? "text-sm text-success" : "text-sm text-muted"}>
          {v.result}
          {v.kind === "duplicate" && v.titleId && (
            <>
              {" – "}
              <Link href={`/buecherei/bestand/${v.titleId}`} className="font-medium text-accent-ink hover:underline">
                dort weitere Exemplare anlegen
              </Link>
            </>
          )}
        </p>
      )}
      {state.ok && v.kind === "found" && (
        <SpecForm
          key={v.isbn}
          action={createTitleAction}
          label="Vorschlag übernehmen"
          submit="Anlegen"
          fields={newTitleFields({ title: v.title, author: v.author, isbn: v.isbn, publisher: v.publisher, year: v.year })}
        />
      )}
    </div>
  );
}
