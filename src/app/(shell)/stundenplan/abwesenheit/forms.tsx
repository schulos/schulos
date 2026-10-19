"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input, Select, Textarea } from "@schulos/ui/field";

type Option = { value: string; label: string };

/** P4-74: eigene Abwesenheit melden (ganztägig oder stundenweise). */
export function SelfAbsenceForm({
  action,
  today,
  periods,
  reasons,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  today: string;
  periods: Option[];
  reasons: Option[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.ok ? {} : (state.values ?? {});
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label="Abwesenheit melden" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Grund" hint="Fortbildung und dienstlich genehmigt die Schulleitung" error={fe.reason}>
        <Select name="reason" defaultValue={v.reason ?? ""} required>
          <option value="">Grund wählen</option>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="von Tag" error={fe.startsOn}>
        <Input type="date" name="startsOn" min={today} defaultValue={v.startsOn ?? today} required />
      </Field>
      <Field label="bis Tag" hint="leer = nur ein Tag" error={fe.endsOn}>
        <Input type="date" name="endsOn" min={today} defaultValue={v.endsOn ?? ""} />
      </Field>
      <Field label="Ergänzung" hint="nur bei Fortbildung/dienstlich – keine Gesundheitsangaben" error={fe.note}>
        <Input name="note" maxLength={80} defaultValue={v.note ?? ""} />
      </Field>
      <Field label="ab Stunde" hint="leer = ganzer Tag" error={fe.fromPeriod}>
        <Select name="fromPeriod" defaultValue={v.fromPeriod ?? ""}>
          <option value="">ganzer Tag</option>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="bis Stunde" error={fe.toPeriod}>
        <Select name="toPeriod" defaultValue={v.toPeriod ?? ""}>
          <option value="">ganzer Tag</option>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <FieldActions>
        <Button type="submit" variant="primary" disabled={pending}>
          Abwesenheit melden
        </Button>
      </FieldActions>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-4">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-2 lg:col-span-4">
          {state.values?.status === "beantragt"
            ? "Antrag gestellt – die Schulleitung entscheidet. Material kannst du schon jetzt hinterlegen."
            : "Gemeldet – die Vertretungsplanung ist informiert. Hinterlege unten gern Material für die Vertretung."}
        </p>
      )}
    </form>
  );
}

/** Ein Knopf für eine Action ohne Felder (zurückziehen, genehmigen, ablehnen) mit Meldung. */
export function ActionButton({
  action,
  label,
  aria,
  variant = "secondary",
  confirm,
}: {
  action: () => Promise<FormState>;
  label: string;
  aria?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <Button type="submit" size="sm" variant={variant} disabled={pending} aria-label={aria}>
        {label}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** Q5-12: Material zu einer Stunde (Arbeitsauftrag, Datei, für Schüler:innen sichtbar). */
export function MaterialForm({
  action,
  label,
  initial,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  label: string;
  initial: { text: string; fileName: string | null; forStudents: boolean };
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.ok ? null : state.values;
  return (
    <form action={formAction} aria-label={`Material ${label}`} className="flex flex-col gap-2">
      <Field label="Arbeitsauftrag" hint="z. B. „Buch S. 34, Nr. 1–4“ – leer lassen und speichern löscht das Material" error={fe.text}>
        <Textarea name="text" rows={2} maxLength={2000} defaultValue={v?.text ?? initial.text} />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={initial.fileName ? "Andere Datei" : "Datei"} hint="höchstens 25 MB" error={fe.file}>
          <Input type="file" name="file" />
        </Field>
        {initial.fileName && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="removeFile" className="size-4 accent-[var(--accent)]" />
            Datei „{initial.fileName}“ entfernen
          </label>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="forStudents"
            defaultChecked={v ? v.forStudents === "on" : initial.forStudents}
            className="size-4 accent-[var(--accent)]"
          />
          Schüler:innen dürfen es sehen
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          Material speichern
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          {state.values?.saved === "1" ? "Material gespeichert." : "Material gelöscht."}
        </p>
      )}
    </form>
  );
}
