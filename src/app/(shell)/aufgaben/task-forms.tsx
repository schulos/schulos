"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

function Status({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        Abgegeben.
      </p>
    );
  return null;
}

export function NewTaskForm({
  action,
  groups,
  defaults,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  groups: { id: string; name: string }[];
  defaults: { startsAt: string; dueAt: string };
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <Field label="Titel" error={fe.title} className="sm:col-span-2">
        <Input name="title" required />
      </Field>
      <Field label="Aufgabenstellung" hint="Markdown möglich" className="sm:col-span-2">
        <Textarea name="description" rows={6} />
      </Field>
      <fieldset className="flex flex-col gap-2 sm:col-span-2">
        <legend className="mb-1.5 text-sm font-medium">Für</legend>
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <label key={g.id} className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="checkbox" name="groupId" value={g.id} className="size-4 accent-[var(--accent)]" /> {g.name}
            </label>
          ))}
        </div>
        {fe.groupIds && <span className="text-xs text-danger">{fe.groupIds}</span>}
      </fieldset>
      <Field label="Sichtbar ab" hint="Leer = sofort">
        <Input type="datetime-local" name="startsAt" defaultValue={defaults.startsAt} />
      </Field>
      <Field label="Abgabe bis" error={fe.dueAt}>
        <Input type="datetime-local" name="dueAt" defaultValue={defaults.dueAt} required />
      </Field>
      <Field label="Abgabe als">
        <Select name="submissionType" defaultValue="file">
          <option value="file">Datei(en)</option>
          <option value="text">Text</option>
          <option value="confirm">Nur „erledigt“ bestätigen</option>
        </Select>
      </Field>
      <Field label="Material (optional)" error={fe.files}>
        <Input type="file" name="files" multiple className="h-auto py-2" />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird gestellt …" : "Aufgabe stellen"}
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function SubmitForm({
  action,
  type,
  resubmit,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  type: "file" | "text" | "confirm";
  resubmit: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="flex flex-col gap-4">
      {type !== "confirm" && (
        <Field label={type === "text" ? "Deine Antwort" : "Nachricht an die Lehrkraft (optional)"} error={fe.text}>
          <Textarea name="text" rows={type === "text" ? 8 : 3} required={type === "text"} />
        </Field>
      )}
      {type === "file" && (
        <Field label="Dateien" hint="Bis 25 MB je Datei" error={fe.files}>
          <Input type="file" name="files" multiple className="h-auto py-2" />
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird abgegeben …" : type === "confirm" ? "Als erledigt melden" : resubmit ? "Neu abgeben" : "Abgeben"}
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function FeedbackForm({ action, initial }: { action: (prev: FormState, form: FormData) => Promise<FormState>; initial: { feedback: string; grade: string } }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Feedback" error={fe.feedback}>
        <Textarea name="feedback" rows={5} defaultValue={initial.feedback} />
      </Field>
      <Field label="Bewertung" hint="Optional, z. B. 2+ oder „erledigt“">
        <Input name="grade" defaultValue={initial.grade} className="max-w-48" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird zurückgegeben …" : "Zurückgeben"}
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}
