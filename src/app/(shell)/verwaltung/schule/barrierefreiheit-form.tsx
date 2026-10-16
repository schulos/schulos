"use client";

import Link from "next/link";
import { useActionState } from "react";
import { A11Y_FIELD_MAX, A11Y_STATUS, A11Y_STATUS_LABEL, type A11yStatement } from "@/core/school/barrierefreiheit-fields";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

/** Angaben der Schule zur Erklärung zur Barrierefreiheit (A11Y-02), öffentlich unter /barrierefreiheit. */
export function BarrierefreiheitForm({
  action,
  initial,
  enforcementDefault,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial: A11yStatement;
  enforcementDefault: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = (k: keyof A11yStatement) => state.values?.[k] ?? initial[k];
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Erklärung zur Barrierefreiheit" className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-muted">
        Erscheint öffentlich unter /barrierefreiheit (verlinkt auf der Anmeldeseite). Aufbau nach dem EU-Muster; die bekannten Einschränkungen von SchulOS
        stehen schon darin. Ohne eigene Kontaktangaben gelten E-Mail und Telefon aus dem Impressum. Vorlage, keine Rechtsberatung.
      </p>
      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        <Field label="Stand der Vereinbarkeit" error={fe.status}>
          <Select name="status" defaultValue={v("status")}>
            {A11Y_STATUS.map((s) => (
              <option key={s} value={s}>
                {A11Y_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Datum der Überprüfung" hint="Selbstbewertung bzw. letzte Überprüfung" error={fe.reviewedOn}>
          <Input name="reviewedOn" type="date" defaultValue={v("reviewedOn")} />
        </Field>
        <Field label="Ansprechstelle" hint="z. B. „Sekretariat“ – kein Name nötig" error={fe.contactName}>
          <Input name="contactName" maxLength={A11Y_FIELD_MAX.contactName} defaultValue={v("contactName")} />
        </Field>
        <Field label="E-Mail für Rückmeldungen" hint="leer = aus dem Impressum" error={fe.contactEmail}>
          <Input name="contactEmail" type="email" maxLength={A11Y_FIELD_MAX.contactEmail} defaultValue={v("contactEmail")} />
        </Field>
        <Field label="Telefon für Rückmeldungen" hint="leer = aus dem Impressum" error={fe.contactPhone}>
          <Input name="contactPhone" type="tel" maxLength={A11Y_FIELD_MAX.contactPhone} defaultValue={v("contactPhone")} />
        </Field>
        <Field
          label="Weitere nicht barrierefreie Inhalte"
          hint="eine Zeile je Punkt, z. B. eingescannte Elternbriefe ohne Textebene"
          error={fe.extraBarriers}
          className="sm:col-span-2"
        >
          <Textarea name="extraBarriers" rows={3} maxLength={A11Y_FIELD_MAX.extraBarriers} defaultValue={v("extraBarriers")} />
        </Field>
        <Field
          label="Durchsetzungsverfahren"
          hint="leer = Vorgabe für das Bundesland der Schule (siehe Platzhalter)"
          error={fe.enforcement}
          className="sm:col-span-2"
        >
          <Textarea name="enforcement" rows={5} maxLength={A11Y_FIELD_MAX.enforcement} placeholder={enforcementDefault} defaultValue={v("enforcement")} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Erklärung speichern"}
        </Button>
        <Link href="/barrierefreiheit" className="text-sm text-accent-ink underline underline-offset-2">
          Öffentliche Seite ansehen
        </Link>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
