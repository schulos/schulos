"use client";

import { useActionState, useState } from "react";
import { createBoardAction } from "@/modules/tafeln/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export function NewBoardForm({ groups }: { groups: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(createBoardAction, {} as FormState);
  const [title, setTitle] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Neue Tafel" className="grid gap-3 sm:grid-cols-2 sm:items-end">
      <Field label="Titel" error={fe.title}>
        <Input name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required />
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
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          Tafel anlegen
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
