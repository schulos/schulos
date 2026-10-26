"use client";

import { useActionState, useState, useTransition } from "react";
import { listAfter } from "@/core/form-values";
import type { PickTeacher } from "@/modules/stundenplan/lehrfaecher-auswahl";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";
import { TeacherSelect } from "../planung/teacher-select";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Option = { value: string; label: string };

export interface VerfahrenDefaults {
  title: string;
  kind: string;
  note: string;
  gradeLevel: string;
  classIds: string[];
  courseGrade: string;
  schoolYearId: string;
  opensOn: string;
  closesOn: string;
  choices: string;
  chooser: string;
  parentConfirm: boolean;
  /** P4-67 */
  minCourses: string;
  maxCourses: string;
}

/** Wahlverfahren anlegen bzw. ändern (Verwaltung). Klassen erscheinen nur beim Ändern (Jahrgang steht dann fest). */
export function VerfahrenForm({
  action,
  defaults,
  submitLabel,
  savedText,
  kinds,
  grades,
  years,
  classes,
}: {
  action: Action;
  defaults: VerfahrenDefaults;
  submitLabel: string;
  savedText?: string;
  kinds: Option[];
  grades: Option[];
  years: Option[];
  classes?: Option[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v: Record<string, string> = {
    title: defaults.title,
    kind: defaults.kind,
    note: defaults.note,
    gradeLevel: defaults.gradeLevel,
    courseGrade: defaults.courseGrade,
    schoolYearId: defaults.schoolYearId,
    opensOn: defaults.opensOn,
    closesOn: defaults.closesOn,
    choices: defaults.choices,
    minCourses: defaults.minCourses,
    maxCourses: defaults.maxCourses,
    chooser: defaults.chooser,
    parentConfirm: defaults.parentConfirm ? "on" : "",
    ...(state.values && { parentConfirm: "" }),
    ...state.values,
  };
  const fe = state.fieldErrors ?? {};
  const [chooser, setChooser] = useState(v.chooser);
  const chosenClasses = new Set(listAfter(state.values, "classIds", defaults.classIds));
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label={submitLabel} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Titel" error={fe.title} className="sm:col-span-2">
        <Input name="title" defaultValue={v.title} required maxLength={120} />
      </Field>
      <Field label="Art" error={fe.kind}>
        <Select name="kind" defaultValue={v.kind}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Wünsche je Kurs" error={fe.choices}>
        <Select name="choices" defaultValue={v.choices}>
          <option value="1">1 (nur ein Wunsch)</option>
          <option value="2">2 (1. und 2. Wunsch)</option>
          <option value="3">3 (1. bis 3. Wunsch)</option>
        </Select>
      </Field>
      <Field label="Kurse je Person: mindestens" hint="Mehrfachwahl, z. B. zwei AGs" error={fe.minCourses}>
        <Select name="minCourses" defaultValue={v.minCourses}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Kurse je Person: höchstens" error={fe.maxCourses}>
        <Select name="maxCourses" defaultValue={v.maxCourses}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Jahrgang der Wählenden" error={fe.gradeLevel}>
        <Select name="gradeLevel" defaultValue={v.gradeLevel}>
          {grades.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Jahrgang der Kurse" hint="bei der Wahl im Vorjahr der nächste" error={fe.courseGrade}>
        <Select name="courseGrade" defaultValue={v.courseGrade}>
          {grades.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Schuljahr der Kurse" error={fe.schoolYearId}>
        <Select name="schoolYearId" defaultValue={v.schoolYearId}>
          <option value="">aktuelles Schuljahr</option>
          {years.map((y) => (
            <option key={y.value} value={y.value}>
              {y.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Wer wählt" error={fe.chooser}>
        <Select name="chooser" defaultValue={v.chooser} onChange={(e) => setChooser(e.target.value)}>
          <option value="eltern">Eltern (Volljährige selbst)</option>
          <option value="schueler">Schüler:innen</option>
        </Select>
      </Field>
      <Field label="Wahl ab" error={fe.opensOn}>
        <Input type="date" name="opensOn" defaultValue={v.opensOn} required />
      </Field>
      <Field label="Wahl bis (einschließlich)" error={fe.closesOn}>
        <Input type="date" name="closesOn" defaultValue={v.closesOn} required />
      </Field>
      {chooser === "schueler" && (
        <label className="flex min-h-11 items-center gap-2 self-end text-sm sm:col-span-2">
          <input type="checkbox" name="parentConfirm" defaultChecked={v.parentConfirm === "on"} className="size-4 accent-[var(--accent)]" />
          Eltern minderjähriger Kinder bestätigen die Wahl
        </label>
      )}
      {classes && (
        <fieldset className="flex flex-col gap-2 sm:col-span-full">
          <legend className="mb-1 text-sm font-medium">Nur diese Klassen (keine = alle des Jahrgangs)</legend>
          <div className="flex flex-wrap gap-2">
            {classes.map((c) => (
              <label key={c.value} className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm has-[:checked]:bg-accent-soft">
                <input type="checkbox" name="classIds" value={c.value} defaultChecked={chosenClasses.has(c.value)} className="size-4 accent-[var(--accent)]" />
                {c.label}
              </label>
            ))}
          </div>
          {fe.classIds && <p className="text-xs text-danger">{fe.classIds}</p>}
        </fieldset>
      )}
      <Field label="Hinweis an die Familien" hint="z. B. Infoabend, Beratung, was bei Nichtwahl passiert" error={fe.note} className="sm:col-span-full">
        <Textarea name="note" defaultValue={v.note} rows={3} maxLength={2000} />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && savedText && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          {savedText}
        </p>
      )}
      <div className="sm:col-span-full">
        <Button type="submit" variant="primary" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export interface AngebotDefaults {
  title: string;
  subjectId: string;
  level: string;
  minSize: string;
  maxSize: string;
  teacherId: string;
  hours: string;
  note: string;
}

export const EMPTY_ANGEBOT: AngebotDefaults = { title: "", subjectId: "", level: "", minSize: "0", maxSize: "", teacherId: "", hours: "", note: "" };

/** Angebot anlegen bzw. ändern. */
export function AngebotForm({
  action,
  defaults,
  submitLabel,
  subjects,
  teachers,
  levels,
}: {
  action: Action;
  defaults: AngebotDefaults;
  submitLabel: string;
  subjects: Option[];
  /** SP2-12b: Lehrkräfte mit Lehrfächern und Restdeputat (wie bei der Zuweisung im Stundenplan) */
  teachers: PickTeacher[];
  levels: Option[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v: Record<string, string> = { ...defaults, ...(state.ok ? {} : state.values) };
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label={submitLabel} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <AngebotFields v={v} fe={fe} subjects={subjects} teachers={teachers} levels={levels} />
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          Gespeichert.
        </p>
      )}
      <div className="sm:col-span-full">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Felder des Angebots; der Zustand (gewähltes Fach) lebt hier und wird mit dem Formular (key) zurückgesetzt. */
function AngebotFields({ v, fe, subjects, teachers, levels }: { v: Record<string, string>; fe: Record<string, string>; subjects: Option[]; teachers: PickTeacher[]; levels: Option[] }) {
  const [subjectId, setSubjectId] = useState(v.subjectId ?? "");
  const subjectName = subjects.find((s) => s.value === subjectId)?.label ?? "";
  return (
    <>
      <Field label="Titel" error={fe.title} className="sm:col-span-2">
        <Input name="title" defaultValue={v.title} required maxLength={120} />
      </Field>
      <Field label="Fach" error={fe.subjectId}>
        <Select name="subjectId" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
          <option value="">ohne Fach</option>
          {subjects.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Niveau" error={fe.level}>
        <Select name="level" defaultValue={v.level}>
          <option value="">ohne</option>
          {levels.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Mindestgröße" hint="darunter fällt der Kurs aus" error={fe.minSize}>
        <Input type="number" name="minSize" min={0} max={200} defaultValue={v.minSize} />
      </Field>
      <Field label="Höchstzahl" hint="leer = unbegrenzt" error={fe.maxSize}>
        <Input type="number" name="maxSize" min={1} max={500} defaultValue={v.maxSize} />
      </Field>
      {/* SP2-12b: nur Lehrkräfte mit dem Fach, nach Restdeputat; andere über „alle anzeigen“ mit Warnhinweis und „Trotzdem zuweisen“ */}
      <TeacherSelect
        name="teacherId"
        label="Lehrkraft"
        hint="leitet die Gruppe"
        error={fe.teacherId}
        emptyLabel="noch offen"
        subjectId={subjectId}
        subjectName={subjectName}
        teachers={teachers}
        defaultValue={v.teacherId ?? ""}
        confirmed={v.offSubjectOk === "1"}
      />
      <Field label="Wochenstunden" hint="für den Lehrauftrag" error={fe.hours}>
        <Input type="number" name="hours" min={1} max={12} defaultValue={v.hours} />
      </Field>
      <Field label="Beschreibung für die Familien" error={fe.note} className="sm:col-span-full">
        <Textarea name="note" defaultValue={v.note} rows={2} maxLength={1000} />
      </Field>
    </>
  );
}

/** Knopf mit Rückfrage (Löschen). */
export function ConfirmButton({
  action,
  question,
  label,
  ariaLabel,
}: {
  action: () => Promise<void | { error?: string }>;
  question: string;
  label: string;
  ariaLabel?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={ariaLabel}
        onClick={() => {
          if (confirm(question))
            start(async () => {
              const r = await action();
              setError(r?.error ?? null);
            });
        }}
      >
        {label}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
