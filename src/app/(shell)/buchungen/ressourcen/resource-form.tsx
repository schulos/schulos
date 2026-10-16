"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export function ResourceForm({ action, rooms }: { action: (prev: FormState, form: FormData) => Promise<FormState>; rooms: { id: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const [kind, setKind] = useState("device");
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state)} action={formAction} className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end">
      <Field label="Art">
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="device">Gerät</option>
          <option value="room">Raum</option>
        </Select>
      </Field>
      {kind === "room" ? (
        <Field label="Raum" error={fe.roomId} className="sm:col-span-2">
          <Select name="roomId" defaultValue="">
            <option value="">Raum wählen</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <Field label="Name" error={fe.name}>
            <Input name="name" placeholder="z. B. Laptopwagen 3" />
          </Field>
          <Field label="Beschreibung" hint="optional">
            <Input name="description" />
          </Field>
        </>
      )}
      <Button type="submit" variant="primary" disabled={pending}>
        Hinzufügen
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
    </form>
  );
}
