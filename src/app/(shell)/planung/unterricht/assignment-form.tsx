"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { offSubjectKey, type PickTeacher } from "@/modules/stundenplan/lehrfaecher-auswahl";
import { TeacherSelect } from "../teacher-select";

export interface AssignmentFormValues {
  groupId: string;
  /** SP2-01: Band (leer = eigenständig) */
  bandId: string;
  subjectId: string;
  hours: string;
  doubleLessons: string;
  teacherId: string;
  teacher2Id: string;
  roomId: string;
  note: string;
  /** SP2-09: gültig ab/bis (leer = ganzes Schuljahr) */
  validFrom: string;
  validUntil: string;
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
  year,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  deleteAction?: () => Promise<void>;
  initial: AssignmentFormValues;
  options: { groups: { label: string; options: Option[] }[]; subjects: Option[]; teachers: PickTeacher[]; rooms: Option[]; bands: (Option & { hours: number; doubleLessons: number })[] };
  back: string;
  /** SP2-09: Grenzen für „gültig ab/bis“ */
  year: { startsOn: string; endsOn: string };
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  // Nach einem Fehler mit den eingegebenen Werten neu aufbauen (key), sonst gehen sie verloren
  const v: Record<string, string> = { ...initial, ...state.values };
  const [bandId, setBandId] = useState(v.bandId ?? "");
  const band = options.bands.find((b) => b.value === bandId);
  const [subjectId, setSubjectId] = useState(v.subjectId ?? "");
  const subjectName = options.subjects.find((s) => s.value === subjectId)?.label ?? "";
  const groupOptions = () =>
    options.groups.map((g) => (
      <optgroup key={g.label} label={g.label}>
        {g.options.map((o) => (
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
      <Field label="Klasse oder Kurs" error={fe.groupId}>
        <Select name="groupId" defaultValue={v.groupId} required>
          <option value="">Gruppe wählen</option>
          {groupOptions()}
        </Select>
      </Field>
      <Field label="Fach" error={fe.subjectId}>
        <Select name="subjectId" defaultValue={v.subjectId} required onChange={(e) => setSubjectId(e.target.value)}>
          <option value="">Fach wählen</option>
          {plain(options.subjects)}
        </Select>
      </Field>
      {band ? (
        <>
          <Field label="Wochenstunden" hint={`vom Band „${band.label}“`}>
            <Input type="number" value={band.hours} disabled readOnly />
          </Field>
          <Field label="Doppelstunden je Woche" hint="vom Band">
            <Input type="number" value={band.doubleLessons} disabled readOnly />
          </Field>
        </>
      ) : (
        <>
          <Field label="Wochenstunden" error={fe.hours}>
            <Input type="number" name="hours" min={1} max={12} defaultValue={v.hours} required />
          </Field>
          <Field label="Doppelstunden je Woche" hint="0 = Einzelstunden" error={fe.doubleLessons}>
            <Input type="number" name="doubleLessons" min={0} max={6} defaultValue={v.doubleLessons} />
          </Field>
        </>
      )}
      {/* SP2-12: nur Lehrkräfte mit dem Fach, nach Restdeputat; andere über „alle anzeigen“ mit Warnhinweis */}
      <TeacherSelect
        name="teacherId"
        label="Lehrkraft"
        hint="leer = noch offen"
        error={fe.teacherIds}
        emptyLabel="– noch offen –"
        subjectId={subjectId}
        subjectName={subjectName}
        teachers={options.teachers}
        defaultValue={v.teacherId ?? ""}
        confirmed={v[offSubjectKey("teacherId")]}
      />
      <TeacherSelect
        name="teacher2Id"
        label="Zweite Lehrkraft"
        hint="Teamteaching"
        error={fe.teacher2Id}
        emptyLabel="– keine –"
        subjectId={subjectId}
        subjectName={subjectName}
        teachers={options.teachers}
        defaultValue={v.teacher2Id ?? ""}
        confirmed={v[offSubjectKey("teacher2Id")]}
      />
      <Field label="Raumwunsch" error={fe.roomId}>
        <Select name="roomId" defaultValue={v.roomId}>
          <option value="">– kein Wunsch –</option>
          {plain(options.rooms)}
        </Select>
      </Field>
      <Field label="Hinweis" error={fe.note}>
        <Input name="note" maxLength={200} defaultValue={v.note} placeholder="z. B. Epoche Physik" />
      </Field>
      <Field label="Gültig ab" hint="leer = Beginn des Schuljahrs" error={fe.validFrom}>
        <Input type="date" name="validFrom" min={year.startsOn} max={year.endsOn} defaultValue={v.validFrom} />
      </Field>
      <Field label="Gültig bis" hint="leer = Ende des Schuljahrs (z. B. nur 1. Halbjahr)" error={fe.validUntil}>
        <Input type="date" name="validUntil" min={year.startsOn} max={year.endsOn} defaultValue={v.validUntil} />
      </Field>
      <Field label="Band" hint="Lehraufträge eines Bands liegen zur selben Zeit (z. B. Religion/Philosophie, WP, E-/G-Kurse); Bänder pflegen unter „Bänder“" error={fe.bandId} className="sm:col-span-2">
        <Select name="bandId" value={bandId} onChange={(e) => setBandId(e.target.value)}>
          <option value="">– kein Band –</option>
          {options.bands.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label} ({b.hours} Std.)
            </option>
          ))}
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
