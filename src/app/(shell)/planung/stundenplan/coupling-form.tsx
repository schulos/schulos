"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Plus, X } from "lucide-react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { offSubjectKey, type PickTeacher } from "@/modules/stundenplan/lehrfaecher-auswahl";
import { TeacherSelect } from "../teacher-select";
import { LiveReason } from "./live-reason";

export interface CouplingPartValues {
  id: string;
  groupId: string;
  subjectId: string;
  teacherId: string;
  roomId: string;
}

export interface CouplingFormValues {
  weekday: string;
  periodNr: string;
  week: string;
  validFrom: string;
  validUntil: string;
  parts: CouplingPartValues[];
}

interface Option {
  value: string;
  label: string;
}

const FIELDS = ["id", "groupId", "subjectId", "teacherId", "roomId"] as const;

export function CouplingForm({
  action,
  deleteAction,
  initial,
  options,
  cancelHref,
  liveNote,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  deleteAction?: () => Promise<void>;
  initial: CouplingFormValues;
  options: { weekdays: Option[]; periods: Option[]; groups: { label: string; options: Option[] }[]; subjects: Option[]; teachers: PickTeacher[]; rooms: Option[] };
  cancelHref: string;
  /** SP3-05: laufende Kopplung im gültigen Plan – Hinweis „Sofort-Korrektur ab …“ und Begründung */
  liveNote?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    // nach einem Fehler mit den eingegebenen Werten neu aufbauen (key)
    <CouplingFields
      key={JSON.stringify(state.values ?? null)}
      state={state}
      formAction={formAction}
      pending={pending}
      deleteAction={deleteAction}
      initial={initial}
      options={options}
      cancelHref={cancelHref}
      liveNote={liveNote}
    />
  );
}

/** SP2-12: Fach und Lehrkraft eines Teils – die Lehrkraft-Auswahl folgt dem gewählten Fach. */
function SubjectTeacher({
  partKey,
  n,
  v,
  fe,
  subjects,
  teachers,
  confirmed,
}: {
  partKey: string;
  n: number;
  v: CouplingPartValues;
  fe: Record<string, string>;
  subjects: Option[];
  teachers: PickTeacher[];
  confirmed?: string;
}) {
  const [subjectId, setSubjectId] = useState(v.subjectId);
  return (
    <>
      <Field label={`Fach ${n}`} error={fe[`p${partKey}-subjectId`]}>
        <Select name={`p${partKey}-subjectId`} defaultValue={v.subjectId} required onChange={(e) => setSubjectId(e.target.value)}>
          <option value="">Fach wählen</option>
          {subjects.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <TeacherSelect
        name={`p${partKey}-teacherId`}
        label={`Lehrkraft ${n}`}
        error={fe[`p${partKey}-teacherId`]}
        emptyLabel="– keine –"
        subjectId={subjectId}
        subjectName={subjects.find((s) => s.value === subjectId)?.label ?? ""}
        teachers={teachers}
        defaultValue={v.teacherId}
        confirmed={confirmed}
      />
    </>
  );
}

function CouplingFields({
  state,
  formAction,
  pending,
  deleteAction,
  initial,
  options,
  cancelHref,
  liveNote,
}: {
  state: FormState;
  formAction: (form: FormData) => void;
  pending: boolean;
  deleteAction?: () => Promise<void>;
  initial: CouplingFormValues;
  options: { weekdays: Option[]; periods: Option[]; groups: { label: string; options: Option[] }[]; subjects: Option[]; teachers: PickTeacher[]; rooms: Option[] };
  cancelHref: string;
  liveNote?: string;
}) {
  const fe = state.fieldErrors ?? {};
  const sv = state.values;
  // Zeilen: nach einem Fehler die abgeschickten, sonst die Vorbelegung
  const start: { key: string; v: CouplingPartValues }[] = sv?.parts
    ? sv.parts.split(",").map((key) => ({ key, v: Object.fromEntries(FIELDS.map((f) => [f, sv[`p${key}-${f}`] ?? ""])) as unknown as CouplingPartValues }))
    : initial.parts.map((v, i) => ({ key: String(i), v }));
  const [rows, setRows] = useState(start);
  const [next, setNext] = useState(start.length);
  const slot = { ...initial, ...sv };
  const add = () => {
    const last = rows.at(-1)?.v;
    setRows([...rows, { key: String(next), v: { id: "", groupId: last?.groupId ?? "", subjectId: "", teacherId: "", roomId: "" } }]);
    setNext(next + 1);
  };
  const plain = (list: Option[]) =>
    list.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ));
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Wochentag" error={fe.weekday}>
          <Select name="weekday" defaultValue={slot.weekday}>
            {plain(options.weekdays)}
          </Select>
        </Field>
        <Field label="Stunde" error={fe.periodNr}>
          <Select name="periodNr" defaultValue={slot.periodNr}>
            {plain(options.periods)}
          </Select>
        </Field>
        <Field label="Woche" error={fe.week}>
          <Select name="week" defaultValue={slot.week}>
            <option value="all">jede Woche</option>
            <option value="A">nur A-Woche (ungerade KW)</option>
            <option value="B">nur B-Woche (gerade KW)</option>
          </Select>
        </Field>
        <Field label="Gültig ab" error={fe.validFrom}>
          <Input type="date" name="validFrom" defaultValue={slot.validFrom} required />
        </Field>
        <Field label="Gültig bis" hint="leer = unbefristet" error={fe.validUntil}>
          <Input type="date" name="validUntil" defaultValue={slot.validUntil} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">Teile der Kopplung (je Zeile Gruppe, Fach, Lehrkraft, Raum)</legend>
        {rows.map(({ key, v }, i) => {
          const n = i + 1;
          return (
            <div key={key} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1.3fr_1.3fr_1.3fr_1fr_auto] sm:items-start">
              <input type="hidden" name="part" value={key} />
              <input type="hidden" name={`p${key}-id`} value={v.id} />
              <Field label={`Gruppe ${n}`} error={fe[`p${key}-groupId`]}>
                <Select name={`p${key}-groupId`} defaultValue={v.groupId} required>
                  <option value="">Gruppe wählen</option>
                  {options.groups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {plain(g.options)}
                    </optgroup>
                  ))}
                </Select>
              </Field>
              <SubjectTeacher partKey={key} n={n} v={v} fe={fe} subjects={options.subjects} teachers={options.teachers} confirmed={sv?.[offSubjectKey(`p${key}-teacherId`)]} />
              <Field label={`Raum ${n}`} error={fe[`p${key}-roomId`]}>
                <Select name={`p${key}-roomId`} defaultValue={v.roomId}>
                  <option value="">– kein Raum –</option>
                  {plain(options.rooms)}
                </Select>
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Teil ${n} entfernen`}
                disabled={rows.length <= 2}
                onClick={() => setRows(rows.filter((r) => r.key !== key))}
              >
                <X aria-hidden />
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="ghost" className="self-start" onClick={add}>
          <Plus aria-hidden /> Teil hinzufügen
        </Button>
      </fieldset>
      {liveNote && <LiveReason note={liveNote} error={fe.reason} defaultValue={sv?.reason} />}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Kopplung speichern"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Abbrechen</Link>
        </Button>
        {deleteAction && (
          <Button type="submit" formAction={deleteAction} formNoValidate variant="danger" className="ml-auto">
            Kopplung löschen
          </Button>
        )}
      </div>
    </form>
  );
}
