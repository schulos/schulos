"use client";

import { useActionState } from "react";
import type { Role } from "@/core/roles";
import { checkedAfter } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Textarea } from "@schulos/ui/field";
import { TargetPicker } from "@/ui/target-picker";

export interface PostFormValues {
  title: string;
  body: string;
  pinned: boolean;
  onMonitor: boolean;
  expiresAt: string;
  targetRoles: Role[];
  targetGroupIds: string[];
}

export function PostForm({
  action,
  initial,
  groups,
  canPin,
  submitLabel,
  showNotify,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial?: PostFormValues;
  groups: { id: string; name: string }[];
  canPin: boolean;
  submitLabel: string;
  showNotify: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  // nach einem Fehler mit den eingegebenen Werten neu aufbauen (key) – React setzt das Formular sonst zurück (TD-02)
  const v = state.values;

  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="flex flex-col gap-5">
      <Field label="Titel" error={fe.title}>
        <Input name="title" defaultValue={v?.title ?? initial?.title} maxLength={140} required />
      </Field>
      <Field label="Text" hint="Markdown: **fett**, *kursiv*, - Liste, [Link](https://…)" error={fe.body}>
        <Textarea name="body" defaultValue={v?.body ?? initial?.body} rows={10} required />
      </Field>

      <TargetPicker
        initialRoles={initial?.targetRoles ?? []}
        initialGroupIds={initial?.targetGroupIds ?? []}
        groups={groups}
        everyoneText="Ohne Auswahl sehen alle den Beitrag."
        hint="Eltern sehen Beiträge an die Klassen ihrer Kinder automatisch mit."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sichtbar bis" hint="Optional – danach verschwindet der Beitrag" error={fe.expiresAt}>
          <Input type="date" name="expiresAt" defaultValue={v?.expiresAt ?? initial?.expiresAt} />
        </Field>
        <div className="flex flex-col justify-end gap-2">
          {canPin && (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="pinned" defaultChecked={checkedAfter(v, "pinned", initial?.pinned)} className="size-4 accent-[var(--accent)]" /> Oben anheften
            </label>
          )}
          {canPin && (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="onMonitor" defaultChecked={checkedAfter(v, "onMonitor", initial?.onMonitor)} className="size-4 accent-[var(--accent)]" /> Im Laufband der Monitore zeigen
            </label>
          )}
          {showNotify && (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="notify" defaultChecked={checkedAfter(v, "notify", true)} className="size-4 accent-[var(--accent)]" /> Empfänger per Gong benachrichtigen
            </label>
          )}
        </div>
      </div>

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
