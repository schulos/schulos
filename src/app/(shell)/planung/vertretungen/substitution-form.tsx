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
  subjects,
  regularSubjectId,
  exams,
  periods,
  ownPeriod,
  mergeOptions,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  removeAction?: () => Promise<void>;
  lessonId: string;
  date: string;
  /** z. B. „3. Std · Mathematik · Klasse 7b“ – für eindeutige Feldnamen */
  label: string;
  initial: { kind: string; substituteId: string; roomId: string; note: string; subjectId: string; targetPeriod: string; mergeLessonId: string };
  teachers: Teacher[];
  rooms: { id: string; label: string }[];
  /** SP-12 (Fachtausch): alle Fächer; Vorgabe ist das reguläre Fach der Stunde */
  subjects: { id: string; label: string }[];
  regularSubjectId: string;
  /** Arbeiten der Gruppe an dem Tag – Hinweis, wenn das gewählte Fach eine hat */
  exams: { subjectId: string; label: string }[];
  /** SP2-07 Verlegung: Stunden des Zeitrasters; die eigene ist nicht wählbar */
  periods: { nr: number; label: string }[];
  ownPeriod: number;
  /** SP2-07 Zusammenlegung: Stunden zur selben Zeit */
  mergeOptions: { lessonId: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = { ...initial, ...state.values };
  const [kind, setKind] = useState(v.kind || "substitute");
  const [subjectId, setSubjectId] = useState(v.subjectId || regularSubjectId);
  const exam = kind === "substitute" ? exams.find((e) => e.subjectId === subjectId) : undefined;
  const fe = state.fieldErrors ?? {};
  // key: nach dem Speichern liefert der Server neue Werte → Formular neu aufbauen (React setzt es sonst auf alte Vorgaben zurück)
  return (
    <form key={JSON.stringify([initial, state.values ?? null])} action={formAction} aria-label={label} className="grid gap-3 sm:grid-cols-[10rem_1fr_11rem_9rem] lg:grid-cols-[10rem_1fr_11rem_9rem_1fr_auto] lg:items-end">
      <input type="hidden" name="lessonId" value={lessonId} />
      <input type="hidden" name="date" value={date} />
      <Field label="Art" error={fe.kind}>
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="substitute">Vertretung</option>
          <option value="cancel">Entfall</option>
          <option value="room">Raumänderung</option>
          <option value="move">Verlegung</option>
          <option value="merge">Zusammenlegung</option>
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
      <Field label="Fach" error={fe.subjectId}>
        <Select name="subjectId" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={kind !== "substitute"}>
          {subjects.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id === regularSubjectId ? `${x.label} (regulär)` : x.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Raum" error={fe.roomId}>
        <Select name="roomId" defaultValue={v.roomId} disabled={kind === "cancel" || kind === "merge"}>
          <option value="">wie sonst</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Hinweis" error={fe.note} className="sm:col-span-3 lg:col-span-1">
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
      {kind === "move" && (
        <div className="flex flex-wrap items-end gap-3 sm:col-span-full">
          <Field label="Verlegen in" error={fe.targetPeriod}>
            <Select name="targetPeriod" defaultValue={v.targetPeriod}>
              <option value="">Stunde wählen</option>
              {periods
                .filter((p) => p.nr !== ownPeriod)
                .map((p) => (
                  <option key={p.nr} value={p.nr}>
                    {p.label}
                  </option>
                ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="swap" value="1" className="size-4 accent-[var(--accent)]" />
            Tauschen: Unterricht der Gruppe aus der Zielstunde rückt hierher
          </label>
        </div>
      )}
      {kind === "merge" && (
        <Field label="Zusammenlegen mit" error={fe.mergeLessonId} className="sm:col-span-full">
          <Select name="mergeLessonId" defaultValue={v.mergeLessonId}>
            <option value="">Stunde zur selben Zeit wählen</option>
            {mergeOptions.map((o) => (
              <option key={o.lessonId} value={o.lessonId}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {exam && (
        <p role="note" className="text-sm font-medium text-warn sm:col-span-full">
          Achtung: An diesem Tag steht für die Gruppe eine {exam.label} an.
        </p>
      )}
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
