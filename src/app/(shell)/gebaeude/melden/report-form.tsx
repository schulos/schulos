"use client";

import { useActionState } from "react";
import { CATEGORY_LABELS, MAX_PHOTO_MB, MAX_PHOTOS, PRIORITY_LABELS, TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/modules/gebaeude/labels";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

type Option = { value: string; label: string };

/** Mangel melden: Kategorie, Priorität, Raum oder Ort, Text, bis zu drei Fotos (mobil mit Kamera). */
export function ReportForm({
  action,
  rooms,
  initialRoom,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  rooms: Option[];
  initialRoom: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v: Record<string, string> = { category: "gebaeude", priority: "normal", roomId: initialRoom, ...state.values };
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Mangel melden" className="grid gap-4 sm:grid-cols-2">
      <Field label="Was ist kaputt?" error={fe.title} className="sm:col-span-2">
        <Input name="title" defaultValue={v.title} maxLength={120} required placeholder="z. B. Beamer flackert, Fenster klemmt" />
      </Field>
      <Field label="Kategorie" error={fe.category}>
        <Select name="category" defaultValue={v.category} required>
          {TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">Dringlichkeit</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {TICKET_PRIORITIES.map((p) => (
            <label key={p} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" name="priority" value={p} defaultChecked={v.priority === p} className="size-4 accent-[var(--accent)]" />
              {PRIORITY_LABELS[p]}
            </label>
          ))}
        </div>
        <span className="text-xs text-muted">„Gefahr“ nur bei Verletzungsgefahr (offene Steckdose, Glasbruch) – dann wird auch die Verwaltung benachrichtigt.</span>
      </fieldset>
      <Field label="Raum" hint="leer lassen, wenn es keinen Raum gibt" error={fe.roomId}>
        <Select name="roomId" defaultValue={v.roomId ?? ""}>
          <option value="">kein Raum</option>
          {rooms.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ort" hint="ohne Raum oder genauer, z. B. „Pausenhof, Westseite“" error={fe.location}>
        <Input name="location" defaultValue={v.location} maxLength={120} />
      </Field>
      <Field label="Beschreibung" error={fe.description} className="sm:col-span-2">
        <Textarea name="description" defaultValue={v.description} maxLength={4000} placeholder="Seit wann, was genau, schon etwas versucht?" />
      </Field>
      <Field
        label={`Fotos (höchstens ${MAX_PHOTOS})`}
        hint={`JPEG, PNG oder WebP, je höchstens ${MAX_PHOTO_MB} MB. Bitte nur die Sache fotografieren, keine Personen – Ortsangaben im Foto werden entfernt.`}
        error={fe.photos}
        className="sm:col-span-2"
      >
        <Input type="file" name="photos" accept="image/jpeg,image/png,image/webp" capture="environment" multiple className="py-2" />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2">
          {state.error}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Senden …" : "Mangel melden"}
        </Button>
      </div>
    </form>
  );
}
