"use client";

import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

/** Katalogsuche (GET `?q=&art=`) – als Client-Komponente, damit `Field` sein Eingabefeld direkt als Element bekommt. */
export function CatalogSearch({ q, art, options }: { q: string; art: string; options: { value: string; label: string }[] }) {
  return (
    <form aria-label="Katalog durchsuchen" className="flex flex-wrap items-end gap-3">
      <Field label="Suche" hint="Titel, Autor:in, Schlagwort oder ISBN">
        <Input type="search" name="q" defaultValue={q} maxLength={100} className="w-72" />
      </Field>
      <Field label="Medienart">
        <Select name="art" defaultValue={art} className="w-40">
          <option value="">alle</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit">Suchen</Button>
    </form>
  );
}
