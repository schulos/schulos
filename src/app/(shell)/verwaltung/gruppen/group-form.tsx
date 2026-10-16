"use client";

import { useActionState } from "react";
import { GROUP_KINDS, type GroupKind } from "@/core/db/schema";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { LEVEL_LABELS } from "@/core/school/catalog";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

export interface GroupFormValues {
  name: string;
  kind: GroupKind;
  description: string | null;
  gradeLevel: number | null;
  level: string | null;
  subjectId: string | null;
  homeRoomId: string | null;
}

export function GroupForm({
  action,
  initial,
  subjects,
  grades,
  levels,
  rooms,
  submitLabel,
}: {
  /** aktive Räume für den Stammraum */
  rooms: { id: string; name: string }[];
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial?: GroupFormValues;
  subjects: { id: string; name: string }[];
  /** Jahrgänge aus den Stammdaten */
  grades: { level: number; code: string; name: string }[];
  /** Niveaus laut Schulprofil */
  levels: string[];
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  // nach einem Fehler mit den eingegebenen Werten neu aufbauen (key) – React setzt das Formular sonst zurück (TD-02)
  const v = state.values;
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" error={fe.name} className="sm:col-span-2">
        <Input name="name" defaultValue={v?.name ?? initial?.name} required />
      </Field>
      <Field label="Art" error={fe.kind}>
        <Select name="kind" defaultValue={v?.kind ?? initial?.kind ?? "frei"}>
          {GROUP_KINDS.map((k) => (
            <option key={k} value={k}>
              {GROUP_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Jahrgang" hint="Optional" error={fe.gradeLevel}>
        <Select name="gradeLevel" defaultValue={v?.gradeLevel ?? initial?.gradeLevel ?? ""}>
          <option value="">—</option>
          {grades.map((g) => (
            <option key={g.level} value={g.level}>
              {g.code === String(g.level) ? g.name : `${g.code} – ${g.name}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Niveau" hint="Optional, für Kurse" error={fe.level}>
        <Select name="level" defaultValue={v?.level ?? initial?.level ?? ""}>
          <option value="">—</option>
          {[...new Set([...levels, ...(initial?.level ? [initial.level] : [])])].map((l) => (
            <option key={l} value={l}>
              {l} – {LEVEL_LABELS[l] ?? l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Fach" hint="Optional, für Kurse und Fachschaften" error={fe.subjectId}>
        <Select name="subjectId" defaultValue={v?.subjectId ?? initial?.subjectId ?? ""}>
          <option value="">—</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Stammraum" hint="Optional, für Klassen – Vorgabe beim Setzen von Stunden" error={fe.homeRoomId}>
        <Select name="homeRoomId" defaultValue={v?.homeRoomId ?? initial?.homeRoomId ?? ""}>
          <option value="">—</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id === r.name ? r.id : `${r.id} – ${r.name}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Beschreibung" className="sm:col-span-2">
        <Textarea name="description" defaultValue={v?.description ?? initial?.description ?? ""} rows={3} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : submitLabel}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
      </div>
    </form>
  );
}
