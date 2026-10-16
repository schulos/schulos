"use client";

import { useActionState } from "react";
import { createBookAction, transferBookAction, unlockBookAction } from "@/modules/notenbuch/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Option = { value: string; label: string };

/** Neues Notenbuch: eigener Lehrauftrag (Lerngruppe + Fach), Halbjahr, Skala. */
export function NewBookForm({ options, scales, defaultTerm }: { options: Option[]; scales: Option[]; defaultTerm: number }) {
  const [state, formAction, pending] = useActionState(createBookAction, {});
  const v: Record<string, string> = { option: options[0]?.value ?? "", term: String(defaultTerm), scale: scales[0]?.value ?? "", ...state.values };
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Neues Notenbuch" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Lerngruppe und Fach" error={fe.groupId}>
        <Select name="option" defaultValue={v.option}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Halbjahr" error={fe.term}>
        <Select name="term" defaultValue={v.term}>
          <option value="1">1. Halbjahr</option>
          <option value="2">2. Halbjahr</option>
        </Select>
      </Field>
      <Field label="Skala" error={fe.scale}>
        <Select name="scale" defaultValue={v.scale}>
          {scales.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end">
        <Button type="submit" disabled={pending}>
          Anlegen
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          Notenbuch angelegt.
        </p>
      )}
    </form>
  );
}

/** Abgeschlossenes Notenbuch wieder öffnen (P5-13, `notenbuch.unlock`) – mit Begründung, protokolliert, ohne Noten zu sehen. */
export function UnlockForm({ bookId, label }: { bookId: string; label: string }) {
  const [state, formAction, pending] = useActionState(unlockBookAction.bind(null, bookId), {});
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        Entsperrt – die Lehrkräfte können wieder ändern.
      </p>
    );
  return (
    <form action={formAction} aria-label={`${label} entsperren`} className="flex flex-wrap items-end gap-3">
      <Field label="Begründung" hint="wird protokolliert" error={state.fieldErrors?.reason} className="min-w-64 flex-1">
        <Input name="reason" maxLength={200} defaultValue={state.values?.reason} />
      </Field>
      <Button type="submit" disabled={pending}>
        Entsperren
      </Button>
      {state.error && !state.fieldErrors?.reason && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** CSV-Export der Halbjahreswerte einer Klasse (P5-13, `notenbuch.export`) – POST an die Export-Route, protokolliert. */
export function ExportForm({ classes, schoolYearId, defaultTerm }: { classes: { id: string; name: string }[]; schoolYearId: string; defaultTerm: number }) {
  return (
    <form method="post" action="/api/notenbuch/export" aria-label="Halbjahreswerte exportieren" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="schoolYearId" value={schoolYearId} />
      <Field label="Klasse">
        <Select name="groupId" defaultValue={classes[0]?.id}>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Halbjahr">
        <Select name="term" defaultValue={String(defaultTerm)}>
          <option value="1">1. Halbjahr</option>
          <option value="2">2. Halbjahr</option>
        </Select>
      </Field>
      <Field label="Zeichensatz">
        <Select name="encoding" defaultValue="utf8">
          <option value="utf8">UTF-8</option>
          <option value="cp1252">Windows-1252 (ältere Programme)</option>
        </Select>
      </Field>
      <div className="flex items-end">
        <Button type="submit">CSV herunterladen</Button>
      </div>
      <p className="text-xs text-muted sm:col-span-full">
        Nur festgelegte Halbjahresnoten des laufenden Schuljahres (offene bleiben leer) – keine Teilnoten, Kommentare oder Vorschläge. Jeder Export wird
        protokolliert. Zeugnisse entstehen in der Schulverwaltungssoftware.
      </p>
    </form>
  );
}

/**
 * Notenbuch übertragen (P5-11/P5-15, `notenbuch.transfer`): neue Lehrkraft eintragen, auf Wunsch eine bisherige austragen – ohne
 * Noteneinsicht, protokolliert.
 */
export function TransferForm({ bookId, label, teachers, targets }: { bookId: string; label: string; teachers: Option2[]; targets: Option2[] }) {
  const [state, formAction, pending] = useActionState(transferBookAction.bind(null, bookId), {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label={`${label} übertragen`} className="flex flex-wrap items-end gap-3">
      <Field label="An Lehrkraft" error={fe.toTeacherId}>
        <Select name="toTeacherId" defaultValue="">
          <option value="">– wählen –</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Austragen (optional)">
        <Select name="removeTeacherId" defaultValue="">
          <option value="">niemanden</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>
        Übertragen
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="w-full text-sm text-success">
          Übertragen.
        </p>
      )}
    </form>
  );
}

type Option2 = { id: string; name: string };
