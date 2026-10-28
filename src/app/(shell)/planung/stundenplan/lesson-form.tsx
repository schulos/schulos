"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { offSubjectKey, type PickTeacher } from "@/modules/stundenplan/lehrfaecher-auswahl";
import { TeacherSelect } from "../teacher-select";
import { LiveReason } from "./live-reason";

export interface LessonFormValues {
  groupId: string;
  weekday: number;
  periodNr: number;
  subjectId: string;
  teacherId: string;
  roomId: string;
  week: string;
  validFrom: string;
  validUntil: string;
}

interface Option {
  value: string;
  label: string;
}

export function LessonForm({
  action,
  deleteAction,
  initial,
  options,
  cancelHref,
  couplingHref,
  suggestions,
  liveNote,
}: {
  couplingHref?: string;
  /** SP3-05: laufende Stunde im gültigen Plan – Hinweis „Sofort-Korrektur ab …“ und Begründung */
  liveNote?: string;
  /** Raumvorschlag je Fach (Raumwunsch des Fachs, sonst Stammraum) */
  suggestions?: Record<string, string>;
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  deleteAction?: () => Promise<void>;
  initial: LessonFormValues;
  options: { weekdays: Option[]; periods: Option[]; subjects: Option[]; teachers: PickTeacher[]; rooms: Option[] };
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const roomRef = useRef<HTMLSelectElement>(null);
  // Raum folgt dem Fach, bis jemand den Raum selbst wählt
  const roomTouched = useRef(false);
  const fe = state.fieldErrors ?? {};
  // Nach einem Fehler mit den eingegebenen Werten neu aufbauen (key), sonst gehen sie verloren
  const v: Record<string, string> = {
    ...Object.fromEntries(Object.entries(initial).map(([k, val]) => [k, String(val)])),
    ...state.values,
  };
  const [subjectId, setSubjectId] = useState(v.subjectId ?? "");
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="groupId" value={initial.groupId} />
      <Field label="Fach" error={fe.subjectId}>
        <Select
          name="subjectId"
          defaultValue={v.subjectId}
          required
          onChange={(e) => {
            setSubjectId(e.target.value);
            const room = suggestions?.[e.target.value];
            if (room !== undefined && roomRef.current && !roomTouched.current) roomRef.current.value = room;
          }}
        >
          <option value="">Fach wählen</option>
          {options.subjects.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {/* SP2-12: nur Lehrkräfte mit dem Fach, nach Restdeputat; andere über „alle anzeigen“ mit Warnhinweis */}
      <TeacherSelect
        name="teacherId"
        label="Lehrkraft"
        error={fe.teacherId}
        emptyLabel="– keine –"
        subjectId={subjectId}
        subjectName={options.subjects.find((s) => s.value === subjectId)?.label ?? ""}
        teachers={options.teachers}
        defaultValue={v.teacherId ?? ""}
        confirmed={v[offSubjectKey("teacherId")]}
      />
      <Field label="Wochentag" error={fe.weekday}>
        <Select name="weekday" defaultValue={v.weekday}>
          {options.weekdays.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Stunde" error={fe.periodNr}>
        <Select name="periodNr" defaultValue={v.periodNr}>
          {options.periods.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Raum" hint={suggestions ? "Vorschlag: Raumwunsch des Fachs, sonst Stammraum" : undefined} error={fe.roomId}>
        <Select ref={roomRef} name="roomId" defaultValue={v.roomId} onChange={() => {
            roomTouched.current = true;
          }}>
          <option value="">– kein Raum –</option>
          {options.rooms.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Woche" error={fe.week}>
        <Select name="week" defaultValue={v.week}>
          <option value="all">jede Woche</option>
          <option value="A">nur A-Woche (ungerade KW)</option>
          <option value="B">nur B-Woche (gerade KW)</option>
        </Select>
      </Field>
      <Field label="Gültig ab" error={fe.validFrom}>
        <Input type="date" name="validFrom" defaultValue={v.validFrom} required />
      </Field>
      <Field label="Gültig bis" hint="leer = unbefristet" error={fe.validUntil}>
        <Input type="date" name="validUntil" defaultValue={v.validUntil} />
      </Field>
      {liveNote && <LiveReason note={liveNote} error={fe.reason} defaultValue={v.reason} className="sm:col-span-2" />}
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
          <Link href={cancelHref}>Abbrechen</Link>
        </Button>
        {couplingHref && (
          <Button asChild variant="ghost">
            <Link href={couplingHref}>{deleteAction ? "Zur Kopplung erweitern" : "Stattdessen Kopplung anlegen"}</Link>
          </Button>
        )}
        {deleteAction && (
          <Button type="submit" formAction={deleteAction} formNoValidate variant="danger" className="ml-auto">
            Stunde löschen
          </Button>
        )}
      </div>
    </form>
  );
}
