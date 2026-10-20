"use client";

import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";

interface Option {
  value: string;
  label: string;
}

/** SP-07: Vorschau eines Laufs für eine Klasse/einen Kurs oder eine Lehrkraft wählen (GET-Formular, Wert `g:<id>` bzw. `t:<id>`). */
export function PreviewPicker({
  action,
  value,
  kategorie,
  groups,
  teachers,
}: {
  action: string;
  value: string;
  kategorie: string | null;
  groups: Option[];
  teachers: Option[];
}) {
  return (
    <form action={action} aria-label="Vorschau wählen" className="flex flex-wrap items-end gap-2">
      {kategorie && <input type="hidden" name="kategorie" value={kategorie} />}
      <Field label="Klasse, Kurs oder Lehrkraft" className="w-64">
        <Select name="vorschau" defaultValue={value} required>
          <option value="" disabled>
            wählen …
          </option>
          <optgroup label="Klassen und Kurse">
            {groups.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Lehrkräfte">
            {teachers.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        </Select>
      </Field>
      <Button type="submit">Anzeigen</Button>
    </form>
  );
}
