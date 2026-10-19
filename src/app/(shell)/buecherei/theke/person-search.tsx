"use client";

import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

/**
 * Personensuche der Theke (GET `?q=`). Als Client-Komponente, damit `Field` sein Eingabefeld direkt als Element bekommt –
 * aus einer Server-Komponente kann das Feld beim Streamen als noch nicht aufgelöster Verweis ankommen.
 */
export function PersonSearch({ q }: { q: string }) {
  return (
    <form aria-label="Person suchen" className="flex flex-wrap items-end gap-3">
      <Field label="Name oder Klasse" hint="z. B. „Schäfer“, „7b“ oder „Lea 7b“">
        <Input type="search" name="q" defaultValue={q} maxLength={60} className="w-56" />
      </Field>
      <Button type="submit" variant="secondary">
        Suchen
      </Button>
    </form>
  );
}
