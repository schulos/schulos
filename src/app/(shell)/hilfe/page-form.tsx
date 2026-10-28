"use client";

import { useActionState } from "react";
import type { Role } from "@/core/roles";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";
import { TargetPicker } from "@/ui/target-picker";

export interface PageFormValues {
  sectionId: string;
  title: string;
  body: string;
  status: "entwurf" | "veroeffentlicht";
  contactId: string;
  targetRoles: Role[];
  targetGroupIds: string[];
}

/**
 * Editor einer Handbuchseite (HB-02). `full` = Pflegende (Bereich, Status, Zielgruppen, Ansprechperson); sonst bearbeitet die
 * Ansprechperson nur Titel und Text.
 */
export function PageForm({
  action,
  initial,
  sections,
  contacts,
  groups,
  full,
  submitLabel,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial: PageFormValues;
  sections: { id: string; title: string }[];
  contacts: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  full: boolean;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  // nach einem Fehler mit den eingegebenen Werten neu aufbauen (key) – React setzt das Formular sonst zurück (TD-02)
  const v = state.values;

  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Handbuchseite" className="flex flex-col gap-5">
      {full && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bereich" error={fe.sectionId}>
            <Select name="sectionId" defaultValue={v?.sectionId ?? initial.sectionId} required>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" error={fe.status} hint="Entwürfe sehen nur Pflegende und die Ansprechperson.">
            <Select name="status" defaultValue={v?.status ?? initial.status}>
              <option value="entwurf">Entwurf</option>
              <option value="veroeffentlicht">Veröffentlicht</option>
            </Select>
          </Field>
        </div>
      )}
      <Field label="Titel" error={fe.title}>
        <Input name="title" defaultValue={v?.title ?? initial.title} maxLength={140} required />
      </Field>
      <p role="note" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm">
        Das Handbuch beschreibt Abläufe. Bitte keine Schülerdaten und keine Gesundheits- oder Notendaten eintragen – auch nicht
        als Beispiel.
      </p>
      <Field label="Text" hint="Markdown: ## Zwischenüberschrift, **fett**, - Liste, [Link](https://…); andere Seite: [Titel](/hilfe/adresse)" error={fe.body}>
        <Textarea name="body" defaultValue={v?.body ?? initial.body} rows={16} />
      </Field>
      {full ? (
        <>
          <Field label="Ansprechperson" hint="Darf die Seite bearbeiten und wird an die Überprüfung erinnert." error={fe.contactId}>
            <Select name="contactId" defaultValue={v?.contactId ?? initial.contactId}>
              <option value="">keine</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <TargetPicker
            legend="Wer sieht die Seite?"
            initialRoles={initial.targetRoles}
            initialGroupIds={initial.targetGroupIds}
            groups={groups}
            everyoneText="Ohne Auswahl sehen alle angemeldeten Personen die Seite."
            hint="Eltern sehen Seiten für die Klassen ihrer Kinder automatisch mit."
          />
          {fe.targets && <p className="text-sm text-danger">{fe.targets}</p>}
        </>
      ) : (
        <p className="text-sm text-muted">Bereich, Status, Zielgruppen und Ansprechperson ändert, wer das Handbuch pflegt.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : submitLabel}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
