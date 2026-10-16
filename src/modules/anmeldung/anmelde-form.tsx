"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import type { PublicFormState } from "@/modules/anmeldung/public-actions";
import type { SlotOption } from "@/modules/anmeldung/slot-options";
import type { VerfahrenFields } from "@/modules/anmeldung/labels";
import { Button } from "@schulos/ui/button";
import { Field, Input, Textarea } from "@schulos/ui/field";

const STEPS = ["Kind", "Eltern", "Termin", "Prüfen und absenden"] as const;

/** Welcher Schritt enthält ein Feld (nach einem Fehler vom Server dorthin springen)? */
const STEP_OF: Record<string, number> = {
  childFirstName: 0,
  childLastName: 0,
  childBirthDate: 0,
  primarySchool: 0,
  sibling: 0,
  siblingNote: 0,
  secondChoiceSchool: 0,
  parent1Name: 1,
  parent1Email: 1,
  parent1Phone: 1,
  addressStreet: 1,
  addressZip: 1,
  addressCity: 1,
  parent2Name: 1,
  parent2Email: 1,
  parent2Consent: 1,
  hints: 1,
  slotId: 2,
  consent: 3,
};

const SUMMARY: [string, string][] = [
  ["childFirstName", "Vorname des Kindes"],
  ["childLastName", "Nachname des Kindes"],
  ["childBirthDate", "Geburtsdatum"],
  ["primarySchool", "Schule"],
  ["siblingNote", "Geschwisterkind"],
  ["secondChoiceSchool", "Zweitwunsch"],
  ["parent1Name", "Elternteil"],
  ["parent1Email", "E-Mail-Adresse"],
  ["parent1Phone", "Telefon"],
  ["addressStreet", "Straße"],
  ["addressZip", "Postleitzahl"],
  ["addressCity", "Ort"],
  ["parent2Name", "Zweiter Elternteil"],
  ["parent2Email", "E-Mail-Adresse (zweiter Elternteil)"],
  ["hints", "Hinweise"],
];

export interface AnmeldeFormProps {
  action: (prev: PublicFormState, form: FormData) => Promise<PublicFormState>;
  refreshSlots: () => Promise<SlotOption[]>;
  kind: string;
  fields: VerfahrenFields;
  slots: SlotOption[];
  /** signierter Zeitstempel (nur öffentliches Formular) */
  stamp?: string;
  /** Vorbelegung (Familien mit Konto, P4-34b) */
  prefill?: Record<string, string>;
  /** Datenschutzhinweis (Art. 13), auf dem Server erzeugt */
  privacy: React.ReactNode;
  /** Text nach dem Absenden (öffentlich: „bitte E-Mail bestätigen“) */
  done: React.ReactNode;
}

/** Mehrschrittiges Anmeldeformular – alle Felder in einem Formular, Schritte nur ein-/ausgeblendet (Werte bleiben). */
export function AnmeldeForm({ action, refreshSlots, kind, fields, slots: initialSlots, stamp, prefill, privacy, done }: AnmeldeFormProps) {
  const [step, setStep] = useState(0);
  const [slots, setSlots] = useState(initialSlots);
  const [loading, startLoading] = useTransition();
  // Fehler vom Server: zum ersten betroffenen Schritt (bei vergebenem Termin gleich die Termine neu laden)
  const [state, formAction, pending] = useActionState(async (prev: PublicFormState, data: FormData) => {
    const r = await action(prev, data);
    if (r.fieldErrors) {
      setStep(Math.min(...Object.keys(r.fieldErrors).map((k) => STEP_OF[k] ?? 3)));
      if (r.fieldErrors.slotId) setSlots(await refreshSlots());
    }
    return r;
  }, {});
  const [summary, setSummary] = useState<[string, string][]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fe = state.fieldErrors ?? {};
  const values = state.values ?? prefill ?? {};
  const val = (k: string) => values[k] ?? "";

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  if (state.ok) return <div role="status">{done}</div>;

  const go = (to: number) => {
    const form = formRef.current;
    if (!form) return;
    if (to > step) {
      // Pflichtfelder des aktuellen Schritts im Browser prüfen (der Server prüft ohnehin alles noch einmal)
      const current = form.querySelector<HTMLFieldSetElement>(`fieldset[data-step="${step}"]`);
      const invalid = [...(current?.querySelectorAll<HTMLInputElement>("input, textarea, select") ?? [])].find((el) => !el.checkValidity());
      if (invalid) {
        invalid.reportValidity();
        return;
      }
    }
    if (to === 2) startLoading(async () => setSlots(await refreshSlots()));
    if (to === 3) {
      const data = new FormData(form);
      setSummary(SUMMARY.flatMap(([k, label]) => (String(data.get(k) ?? "").trim() ? [[label, String(data.get(k)).trim()] as [string, string]] : [])));
    }
    setStep(to);
  };

  const byDay = new Map<string, SlotOption[]>();
  for (const s of slots) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  const school = kind === "klasse5" ? "Grundschule" : "Bisherige Schule";

  return (
    <div className="flex flex-col gap-4">
      <ol aria-label="Schritte" className="flex flex-wrap gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? "step" : undefined}
            className={i === step ? "rounded-lg bg-accent-soft px-3 py-1.5 font-medium text-accent-ink" : "rounded-lg px-3 py-1.5 text-muted"}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <form ref={formRef} key={JSON.stringify(state.values ?? null)} action={formAction}
        aria-label="Anmeldung"
        // Browser-Prüfung je Schritt (Weiter); beim Absenden nur der letzte Schritt – ausgeblendete Felder kann der Browser nicht anzeigen
        noValidate
        onSubmit={(e) => {
          const last = e.currentTarget.querySelector<HTMLFieldSetElement>('fieldset[data-step="3"]');
          const invalid = [...(last?.querySelectorAll<HTMLInputElement>("input") ?? [])].find((el) => !el.checkValidity());
          if (invalid) {
            e.preventDefault();
            invalid.reportValidity();
          }
        }}
        className="flex flex-col gap-4"
      >
        {stamp && <input type="hidden" name="stamp" value={stamp} />}
        {/* Falle für Bots: für Menschen unsichtbar und nicht erreichbar */}
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>
            Webseite (bitte leer lassen)
            <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>

        <fieldset data-step="0" hidden={step !== 0} className="flex flex-col gap-4">
          <legend className="sr-only">Kind</legend>
          {step === 0 && (
            <h2 ref={headingRef} tabIndex={-1} className="font-display text-xl font-bold outline-none">
              Angaben zum Kind
            </h2>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Vorname" error={fe.childFirstName}>
              <Input name="childFirstName" defaultValue={val("childFirstName")} required maxLength={60} autoComplete="off" />
            </Field>
            <Field label="Nachname" error={fe.childLastName}>
              <Input name="childLastName" defaultValue={val("childLastName")} required maxLength={60} autoComplete="off" />
            </Field>
            <Field label="Geburtsdatum" error={fe.childBirthDate}>
              <Input name="childBirthDate" type="date" defaultValue={val("childBirthDate")} required />
            </Field>
            <Field label={school} error={fe.primarySchool}>
              <Input name="primarySchool" defaultValue={val("primarySchool")} required maxLength={120} />
            </Field>
          </div>
          {fields.geschwister && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="sibling" defaultChecked={val("sibling") === "on"} className="size-4 accent-[var(--accent)]" />
                Ein Geschwisterkind besucht schon unsere Schule
              </label>
              <Field label="Name und Klasse des Geschwisterkinds (optional)" error={fe.siblingNote}>
                <Input name="siblingNote" defaultValue={val("siblingNote")} maxLength={120} />
              </Field>
            </div>
          )}
          {fields.zweitwunsch && (
            <Field label="Zweitwunsch (andere Schule, optional)" error={fe.secondChoiceSchool}>
              <Input name="secondChoiceSchool" defaultValue={val("secondChoiceSchool")} maxLength={120} />
            </Field>
          )}
        </fieldset>

        <fieldset data-step="1" hidden={step !== 1} className="flex flex-col gap-4">
          <legend className="sr-only">Eltern</legend>
          {step === 1 && (
            <h2 ref={headingRef} tabIndex={-1} className="font-display text-xl font-bold outline-none">
              Angaben zu den Eltern
            </h2>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name (Elternteil)" error={fe.parent1Name}>
              <Input name="parent1Name" defaultValue={val("parent1Name")} required maxLength={120} autoComplete="name" />
            </Field>
            <Field label="E-Mail-Adresse" hint="Dorthin schicken wir den Bestätigungslink" error={fe.parent1Email}>
              <Input name="parent1Email" type="email" defaultValue={val("parent1Email")} required maxLength={254} autoComplete="email" />
            </Field>
            <Field label="Telefon (optional)" error={fe.parent1Phone}>
              <Input name="parent1Phone" type="tel" defaultValue={val("parent1Phone")} maxLength={30} autoComplete="tel" />
            </Field>
            <Field label="Straße und Hausnummer" error={fe.addressStreet}>
              <Input name="addressStreet" defaultValue={val("addressStreet")} required maxLength={120} autoComplete="street-address" />
            </Field>
            <Field label="Postleitzahl" error={fe.addressZip}>
              <Input name="addressZip" defaultValue={val("addressZip")} required maxLength={10} inputMode="numeric" autoComplete="postal-code" />
            </Field>
            <Field label="Ort" error={fe.addressCity}>
              <Input name="addressCity" defaultValue={val("addressCity")} required maxLength={80} autoComplete="address-level2" />
            </Field>
            {fields.elternteil2 && (
              <>
                <Field label="Zweiter Elternteil (optional)" error={fe.parent2Name}>
                  <Input name="parent2Name" defaultValue={val("parent2Name")} maxLength={120} />
                </Field>
                <Field
                  label="E-Mail-Adresse (zweiter Elternteil, optional)"
                  hint="Nur für ein eigenes Elternkonto nach der Aufnahme – vorher schreiben wir nicht an diese Adresse"
                  error={fe.parent2Email}
                >
                  <Input name="parent2Email" type="email" defaultValue={val("parent2Email")} maxLength={254} />
                </Field>
              </>
            )}
          </div>
          {fields.elternteil2 && (
            <div className="flex flex-col gap-1">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="parent2Consent"
                  defaultChecked={val("parent2Consent") === "on"}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                  aria-describedby={fe.parent2Consent ? "parent2-consent-error" : undefined}
                />
                <span>Nur mit E-Mail-Adresse des zweiten Elternteils: Der zweite Elternteil weiß von dieser Angabe und kennt die Datenschutzhinweise.</span>
              </label>
              {fe.parent2Consent && (
                <p id="parent2-consent-error" className="text-sm text-danger">
                  {fe.parent2Consent}
                </p>
              )}
            </div>
          )}
          {fields.hinweise && (
            <Field label="Hinweise für das Gespräch (optional)" hint="Höchstens 300 Zeichen, keine Links. Bitte keine Angaben zur Gesundheit." error={fe.hints}>
              <Textarea name="hints" rows={3} maxLength={300} defaultValue={val("hints")} />
            </Field>
          )}
        </fieldset>

        <fieldset data-step="2" hidden={step !== 2} className="flex flex-col gap-4">
          <legend className="sr-only">Termin</legend>
          {step === 2 && (
            <h2 ref={headingRef} tabIndex={-1} className="font-display text-xl font-bold outline-none">
              Termin für das Anmeldegespräch
            </h2>
          )}
          {fe.slotId && (
            <p role="alert" className="text-sm text-danger">
              {fe.slotId}
            </p>
          )}
          <div aria-busy={loading} className="flex flex-col gap-4" role="radiogroup" aria-label="Freie Termine">
            {slots.length === 0 ? (
              <p className="text-sm">Zurzeit sind keine Termine frei. Bitte versuchen Sie es später noch einmal oder wenden Sie sich an das Sekretariat.</p>
            ) : (
              [...byDay].map(([day, list]) => (
                <div key={day} className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{list[0]!.dayLabel}</p>
                  <div className="flex flex-wrap gap-2">
                    {list.map((s) => (
                      <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                        <input type="radio" name="slotId" value={s.id} required defaultChecked={val("slotId") === s.id} className="accent-[var(--accent)]" />
                        <span className="tabular-nums">{s.time}</span>
                        {s.room && <span className="text-muted">· {s.room}</span>}
                      </label>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={loading} onClick={() => startLoading(async () => setSlots(await refreshSlots()))}>
            {loading ? "Termine werden geladen …" : "Freie Termine aktualisieren"}
          </Button>
        </fieldset>

        <fieldset data-step="3" hidden={step !== 3} className="flex flex-col gap-4">
          <legend className="sr-only">Prüfen und absenden</legend>
          {step === 3 && (
            <h2 ref={headingRef} tabIndex={-1} className="font-display text-xl font-bold outline-none">
              Angaben prüfen
            </h2>
          )}
          <dl aria-label="Ihre Angaben" className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
            {summary.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="break-words whitespace-pre-line">{v}</dd>
              </div>
            ))}
          </dl>
          {privacy}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required defaultChecked={false} className="mt-0.5 size-4 accent-[var(--accent)]" aria-describedby={fe.consent ? "consent-error" : undefined} />
            Ich habe die Datenschutzhinweise gelesen.
          </label>
          {fe.consent && (
            <p id="consent-error" className="text-sm text-danger">
              {fe.consent}
            </p>
          )}
        </fieldset>

        {state.error && !state.fieldErrors && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        {state.fieldErrors && (
          <p role="alert" className="text-sm text-danger">
            Bitte prüfen Sie Ihre Angaben: {state.error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {step > 0 && (
            <Button type="button" variant="secondary" onClick={() => go(step - 1)}>
              Zurück
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button type="button" variant="primary" onClick={() => go(step + 1)}>
              Weiter
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Wird gesendet …" : "Anmeldung absenden"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
