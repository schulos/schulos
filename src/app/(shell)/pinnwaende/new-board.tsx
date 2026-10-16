"use client";

import { useActionState, useState } from "react";
import { createBoardAction } from "@/modules/pinnwaende/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export const MODES = [
  { value: "alle", label: "Alle posten" },
  { value: "moderiert", label: "Alle posten, Leitung gibt frei" },
  { value: "leitung", label: "Nur Leitung postet" },
];

export function NewBoardForm({ groups, canFree }: { groups: { id: string; name: string }[]; canFree: boolean }) {
  const [state, formAction, pending] = useActionState(createBoardAction, {} as FormState);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState("alle");
  const [groupId, setGroupId] = useState(canFree ? "" : (groups[0]?.id ?? ""));
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-3 sm:items-end">
      <Field label="Titel" error={fe.title}>
        <Input name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required />
      </Field>
      <Field label="Für">
        <Select name="groupId" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          {canFree && <option value="">Frei (eigene Mitglieder)</option>}
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Wer postet?">
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
          Pinnwand anlegen
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
