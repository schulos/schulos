"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Textarea } from "@schulos/ui/field";

const HINT = "Markdown: **fett**, *kursiv*, - Liste, [Link](https://…)";

/** Neues Thema: Titel + erster Beitrag. Kontrolliert, damit nach einem Fehler nichts verloren geht. */
export function TopicForm({ action }: { action: (prev: FormState, form: FormData) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState(action, {});
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Field label="Titel" error={fe.title}>
        <Input name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required />
      </Field>
      <Field label="Beitrag" hint={HINT} error={fe.body}>
        <Textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={5} required />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Thema starten
        </Button>
      </div>
    </form>
  );
}

/** Antwort bzw. Bearbeiten eines Beitrags; nach Erfolg leer (Antwort) bzw. geschlossen (Bearbeiten über `onDone`). */
export function PostForm({
  action,
  label,
  submitLabel,
  initial = "",
  onDone,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  label: string;
  submitLabel: string;
  initial?: string;
  onDone?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [state, formAction, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const next = await action(prev, form);
    if (next.ok) {
      setBody("");
      onDone?.();
    }
    return next;
  }, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Field label={label} hint={HINT} error={fe.body}>
        <Textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={4} required />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
