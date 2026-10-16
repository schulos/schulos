"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

const KIND_LABEL: Record<string, string> = { klasse: "Klassen", kurs: "Kurse", ag: "AGs" };

export function LetterForm({ action, groups }: { action: (prev: FormState, form: FormData) => Promise<FormState>; groups: { id: string; name: string; kind: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v: Record<string, string> = { responseType: "none", ...state.values };
  const [responseType, setResponseType] = useState(v.responseType!);
  const checked = new Set((v.groupIds ?? "").split(",").filter(Boolean));
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="flex flex-col gap-5">
      <Field label="Betreff" error={fe.title}>
        <Input name="title" defaultValue={v.title} required maxLength={150} />
      </Field>
      <Field label="Text" hint="Markdown möglich: **fett**, Listen mit -, Links" error={fe.body}>
        <Textarea name="body" defaultValue={v.body} rows={8} required />
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Empfänger: Eltern der Schüler:innen in …</legend>
        {fe.groupIds && <span className="text-xs text-danger">{fe.groupIds}</span>}
        {["klasse", "kurs", "ag"].map((kind) => {
          const list = groups.filter((g) => g.kind === kind);
          if (list.length === 0) return null;
          return (
            <div key={kind} className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold tracking-wide text-muted uppercase">{KIND_LABEL[kind]}</span>
              <div className="flex flex-wrap gap-2">
                {list.map((g) => (
                  <label key={g.id} className="flex min-h-10 items-center gap-2 rounded-xl border border-border bg-surface px-3 has-checked:border-accent has-checked:bg-accent-soft">
                    <input type="checkbox" name="groupIds" value={g.id} defaultChecked={checked.has(g.id)} className="size-4 accent-[var(--accent)]" />
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-[14rem_1fr_11rem]">
        <Field label="Rückmeldung" error={fe.responseType}>
          <Select name="responseType" value={responseType} onChange={(e) => setResponseType(e.target.value)}>
            <option value="none">nur Lesebestätigung</option>
            <option value="yesno">Ja/Nein-Frage</option>
            <option value="text">Antwort als Text</option>
          </Select>
        </Field>
        <Field label="Frage" error={fe.question}>
          <Input name="question" defaultValue={v.question} disabled={responseType === "none"} placeholder="z. B. Darf Ihr Kind teilnehmen?" />
        </Field>
        <Field label="Rückmeldung bis" hint="optional" error={fe.dueDate}>
          <Input type="date" name="dueDate" defaultValue={v.dueDate} />
        </Field>
      </div>
      <Field label="Anhang" hint="optional, bis 25 MB" error={fe.attachment}>
        <Input type="file" name="attachment" className="py-2" />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird verschickt …" : "Elternbrief verschicken"}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/elternbriefe">Abbrechen</Link>
        </Button>
      </div>
    </form>
  );
}
