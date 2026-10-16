"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Input, Select } from "@schulos/ui/field";

/** Ein Formular für die ganze Woche: Gruppe/Notiz oben, jeder freie Slot ist ein Absende-Knopf (name="slot"). */
export function BookingForm({
  action,
  groups,
  children,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  groups: { id: string; name: string }[];
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[16rem_1fr]">
        <Select name="groupId" aria-label="Für Klasse/Kurs (optional)" defaultValue="">
          <option value="">Für Klasse/Kurs (optional)</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        <Input name="note" placeholder="Notiz (optional), z. B. Projektarbeit" aria-label="Notiz" maxLength={200} />
        <p className="text-sm text-muted sm:col-span-2">Freie Stunde im Raster anklicken, um zu buchen.</p>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Gebucht.
        </p>
      )}
      {children}
    </form>
  );
}
