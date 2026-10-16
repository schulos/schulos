"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

interface Teacher {
  id: string;
  label: string;
  free: boolean;
}

export function SubstitutionForm({
  action,
  removeAction,
  lessonId,
  date,
  label,
  initial,
  teachers,
  rooms,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  removeAction?: () => Promise<void>;
  lessonId: string;
  date: string;
  /** z. B. „3. Std · Mathematik · Klasse 7b“ – für eindeutige Feldnamen */
  label: string;
  initial: { kind: string; substituteId: string; roomId: string; note: string };
  teachers: Teacher[];
  rooms: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = { ...initial, ...state.values };
  const [kind, setKind] = useState(v.kind || "substitute");
  const fe = state.fieldErrors ?? {};
  // key: nach dem Speichern liefert der Server neue Werte → Formular neu aufbauen (React setzt es sonst auf alte Vorgaben zurück)
  return (
    <form key={JSON.stringify([initial, state.values ?? null])} action={formAction} aria-label={label} className="grid gap-3 sm:grid-cols-[10rem_1fr_9rem] lg:grid-cols-[10rem_1fr_9rem_1fr_auto] lg:items-end">
      <input type="hidden" name="lessonId" value={lessonId} />
      <input type="hidden" name="date" value={date} />
      <Field label="Art" error={fe.kind}>
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="substitute">Vertretung</option>
          <option value="cancel">Entfall</option>
          <option value="room">Raumänderung</option>
        </Select>
      </Field>
      <Field label="Vertretung durch" error={fe.substituteId}>
        <Select name="substituteId" defaultValue={v.substituteId} disabled={kind !== "substitute"}>
          <option value="">Lehrkraft wählen</option>
          <optgroup label="Frei">
            {teachers
              .filter((t) => t.free)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
          </optgroup>
          <optgroup label="Hat selbst Unterricht">
            {teachers
              .filter((t) => !t.free)
              .map((t) => (
                <option key={t.id} value={t.id} disabled>
                  {t.label}
                </option>
              ))}
          </optgroup>
        </Select>
      </Field>
      <Field label="Raum" error={fe.roomId}>
        <Select name="roomId" defaultValue={v.roomId} disabled={kind === "cancel"}>
          <option value="">wie sonst</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Hinweis" error={fe.note} className="sm:col-span-2 lg:col-span-1">
        <Input name="note" defaultValue={v.note} placeholder="z. B. Arbeitsheft S. 24" maxLength={200} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Speichern"}
        </Button>
        {removeAction && (
          <Button type="submit" formAction={removeAction} formNoValidate>
            Aufheben
          </Button>
        )}
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          Gespeichert – Betroffene sind benachrichtigt.
        </p>
      )}
    </form>
  );
}
