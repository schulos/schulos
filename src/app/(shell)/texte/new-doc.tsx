"use client";

import { useActionState, useState } from "react";
import { createDocAction } from "@/modules/texte/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export const MODES = [
  { value: "alle", label: "Alle schreiben" },
  { value: "leitung", label: "Nur Leitung schreibt, alle lesen" },
];

export function NewDocForm({ groups }: { groups: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(createDocAction, {} as FormState);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState("alle");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Neuer Text" className="grid gap-3 sm:grid-cols-3 sm:items-end">
      <Field label="Titel" error={fe.title}>
        <Input name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
      </Field>
      <Field label="Gruppe">
        <Select name="groupId" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Wer schreibt?">
        <Select name="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-center gap-3 sm:col-span-3">
        <Button type="submit" variant="primary" disabled={pending}>
          Text anlegen
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
