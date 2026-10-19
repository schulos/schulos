"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, FieldActions, Input, Select } from "@schulos/ui/field";

type Option = { value: string; label: string };

/** Abwesenheit einer Lehrkraft oder einer Klasse/eines Kurses eintragen (ganztägig oder stundenweise). */
export function AbsenceForm({
  action,
  date,
  teachers,
  groups,
  periods,
  teacherReasons,
  groupReasons,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  date: string;
  teachers: Option[];
  groups: Option[];
  periods: Option[];
  teacherReasons: Option[];
  groupReasons: Option[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const [who, setWho] = useState<"teacher" | "group">(v.groupId ? "group" : "teacher");
  const reasons = who === "teacher" ? teacherReasons : groupReasons;
  return (
    <div className="flex flex-col gap-3">
      <fieldset aria-label="Wer fehlt?" className="flex flex-wrap items-center gap-4">
        <legend className="sr-only">Wer fehlt?</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="absence-who" checked={who === "teacher"} onChange={() => setWho("teacher")} className="size-4 accent-[var(--accent)]" />
          Lehrkraft fehlt
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="absence-who" checked={who === "group"} onChange={() => setWho("group")} className="size-4 accent-[var(--accent)]" />
          Klasse/Kurs fehlt
        </label>
      </fieldset>
      <form
        key={JSON.stringify(state.values ?? null) + String(state.ok ?? "")}
        action={formAction}
        aria-label="Abwesenheit eintragen"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {who === "teacher" ? (
          <Field label="Lehrkraft" error={fe.target}>
            <Select name="teacherId" defaultValue={v.teacherId ?? ""} required>
              <option value="">Lehrkraft wählen</option>
              {teachers.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Klasse/Kurs" error={fe.target}>
            <Select name="groupId" defaultValue={v.groupId ?? ""} required>
              <option value="">Klasse oder Kurs wählen</option>
              {groups.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Grund" hint={who === "teacher" ? "keine Diagnose – nur „krank“" : undefined} error={fe.reason}>
          <Select name="reason" defaultValue={v.reason ?? ""} required>
            <option value="">Grund wählen</option>
            {reasons.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="von Tag" error={fe.startsOn}>
          <Input type="date" name="startsOn" defaultValue={v.startsOn ?? date} required />
        </Field>
        <Field label="bis Tag" hint="leer = nur ein Tag" error={fe.endsOn}>
          <Input type="date" name="endsOn" defaultValue={v.endsOn ?? ""} />
        </Field>
        <Field label="ab Stunde" hint="leer = ganzer Tag" error={fe.fromPeriod}>
          <Select name="fromPeriod" defaultValue={v.fromPeriod ?? ""}>
            <option value="">ganzer Tag</option>
            {periods.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="bis Stunde" error={fe.toPeriod}>
          <Select name="toPeriod" defaultValue={v.toPeriod ?? ""}>
            <option value="">ganzer Tag</option>
            {periods.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ergänzung" hint="ohne Gesundheitsangaben" error={fe.note}>
          <Input name="note" maxLength={80} defaultValue={v.note ?? ""} />
        </Field>
        <FieldActions>
          <Button type="submit" variant="primary" disabled={pending}>
            Abwesenheit eintragen
          </Button>
        </FieldActions>
        {state.error && (
          <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-4">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-sm text-success sm:col-span-2 lg:col-span-4">
            Abwesenheit eingetragen.
          </p>
        )}
      </form>
    </div>
  );
}
