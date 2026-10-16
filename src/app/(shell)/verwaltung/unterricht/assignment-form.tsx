"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export interface AssignmentFormValues {
  groupId: string;
  coupledGroupIds: string;
  subjectId: string;
  hours: string;
  doubleLessons: string;
  teacherId: string;
  teacher2Id: string;
  roomId: string;
  note: string;
}

interface Option {
  value: string;
  label: string;
}

export function AssignmentForm({
  action,
  deleteAction,
  initial,
  options,
  back,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  deleteAction?: () => Promise<void>;
  initial: AssignmentFormValues;
  options: { groups: { label: string; options: Option[] }[]; subjects: Option[]; teachers: Option[]; rooms: Option[] };
  back: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  // Nach einem Fehler mit den eingegebenen Werten neu aufbauen (key), sonst gehen sie verloren
  const v: Record<string, string> = { ...initial, ...state.values };
  const coupled = v.coupledGroupIds ? v.coupledGroupIds.split(",") : [];
  const groupOptions = (exclude?: string) =>
    options.groups.map((g) => (
      <optgroup key={g.label} label={g.label}>
        {g.options
          .filter((o) => o.value !== exclude)
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </optgroup>
    ));
  const plain = (list: Option[]) =>
    list.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ));
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="back" value={back} />
      <Field label="Klasse oder Kurs" error={fe.groupIds}>
        <Select name="groupId" defaultValue={v.groupId} required>
          <option value="">Gruppe wählen</option>
          {groupOptions()}
        </Select>
      </Field>
      <Field label="Fach" error={fe.subjectId}>
        <Select name="subjectId" defaultValue={v.subjectId} required>
          <option value="">Fach wählen</option>
          {plain(options.subjects)}
        </Select>
      </Field>
      <Field label="Wochenstunden" error={fe.hours}>
        <Input type="number" name="hours" min={1} max={12} defaultValue={v.hours} required />
      </Field>
      <Field label="Doppelstunden je Woche" hint="0 = Einzelstunden" error={fe.doubleLessons}>
        <Input type="number" name="doubleLessons" min={0} max={6} defaultValue={v.doubleLessons} />
      </Field>
      <Field label="Lehrkraft" hint="leer = noch offen" error={fe.teacherIds}>
        <Select name="teacherId" defaultValue={v.teacherId}>
          <option value="">– noch offen –</option>
          {plain(options.teachers)}
        </Select>
      </Field>
      <Field label="Zweite Lehrkraft" hint="Teamteaching">
        <Select name="teacher2Id" defaultValue={v.teacher2Id}>
          <option value="">– keine –</option>
          {plain(options.teachers)}
        </Select>
      </Field>
      <Field label="Raumwunsch" error={fe.roomId}>
        <Select name="roomId" defaultValue={v.roomId}>
          <option value="">– kein Wunsch –</option>
          {plain(options.rooms)}
        </Select>
      </Field>
      <Field label="Hinweis" error={fe.note}>
        <Input name="note" maxLength={200} defaultValue={v.note} placeholder="z. B. nur 1. Halbjahr" />
      </Field>
      <Field label="Gekoppelt mit" hint="weitere Gruppen, die zur selben Zeit Unterricht haben (Strg/⌘ für mehrere)" className="sm:col-span-2">
        <Select name="coupledGroupIds" multiple defaultValue={coupled} className="h-36 py-2">
          {groupOptions(v.groupId)}
        </Select>
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Speichern"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={back}>Abbrechen</Link>
        </Button>
        {deleteAction && (
          <Button type="submit" formAction={deleteAction} formNoValidate variant="danger" className="ml-auto">
            Lehrauftrag löschen
          </Button>
        )}
      </div>
    </form>
  );
}
