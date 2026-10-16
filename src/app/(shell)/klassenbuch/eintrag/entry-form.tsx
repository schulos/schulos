"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Textarea } from "@schulos/ui/field";
import { cn } from "@schulos/ui/cn";
import { SeatAttendance, type SeatPlanProps } from "./seat-attendance";

type Status = "present" | "absent" | "late";

const OPTIONS: { value: Status; label: string }[] = [
  { value: "present", label: "Anwesend" },
  { value: "absent", label: "Fehlt" },
  { value: "late", label: "Verspätet" },
];

function StudentRow({ id, name, initial, minutes, error, excused, onLeave }: { id: string; name: string; initial: Status; minutes: string; error?: string; excused: boolean | null; onLeave?: boolean }) {
  const [status, setStatus] = useState<Status>(initial);
  // Radios sind unkontrolliert: ein Klick vor der Hydrierung bleibt erhalten; danach Zustand aus dem DOM übernehmen
  const group = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const checked = group.current?.querySelector<HTMLInputElement>("input:checked");
    if (checked && checked.value !== initial) setStatus(checked.value as Status);
  }, [initial]);
  return (
    <li className="flex flex-col gap-2 border-t border-border py-2.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-center gap-2 font-medium">
        {name}
        {onLeave ? (
          <span className="text-xs font-normal text-success">beurlaubt</span>
        ) : (
          status !== "present" && excused === true && <span className="text-xs font-normal text-success">entschuldigt</span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span ref={group} role="radiogroup" aria-label={name} className="flex rounded-xl border border-border bg-surface-2 p-0.5">
          {OPTIONS.map((o) => (
            <label
              key={o.value}
              className={cn(
                "flex min-h-9 cursor-pointer items-center rounded-lg px-3 text-sm text-muted",
                status === o.value && o.value === "present" && "bg-surface font-semibold text-ink shadow-sm",
                status === o.value && o.value === "absent" && "bg-danger-soft font-semibold text-danger",
                status === o.value && o.value === "late" && "bg-warn-soft font-semibold text-warn",
              )}
            >
              <input type="radio" name={`status-${id}`} value={o.value} defaultChecked={initial === o.value} onChange={() => setStatus(o.value)} className="sr-only" />
              {o.label}
            </label>
          ))}
        </span>
        {status === "late" && (
          <span className="flex items-center gap-1.5">
            <Input
              type="number"
              name={`late-${id}`}
              defaultValue={minutes}
              min={1}
              max={90}
              aria-label={`Minuten verspätet: ${name}`}
              aria-invalid={error ? true : undefined}
              className="h-9 w-20"
              required
            />
            <span className="text-sm text-muted">Min.</span>
          </span>
        )}
      </span>
      {error && <span className="text-xs text-danger sm:basis-full">{error}</span>}
    </li>
  );
}

export function EntryForm({
  action,
  lessonId,
  date,
  initial,
  dueMin,
  students,
  cancelHref,
  coupledLabel,
  seatPlan,
}: {
  /** P5-03: Sitzplan zur Stunde (Klick am Platz setzt „Fehlt“/„Anwesend“ in der Liste) */
  seatPlan?: SeatPlanProps;
  /** „7a“ usw., wenn die Stunde gekoppelt ist und dieselbe Lehrkraft weitere Gruppen hat */
  coupledLabel?: string;
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  lessonId: string;
  date: string;
  initial: { topic: string; homework: string; homeworkDue: string };
  /** frühestes „fällig am“ (morgen bzw. Tag nach der Stunde) */
  dueMin: string;
  students: { id: string; name: string; status: Status; minutes: string; excused: boolean | null; onLeave?: boolean }[];
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v: Record<string, string> = { topic: initial.topic, homework: initial.homework, homeworkDue: initial.homeworkDue, ...state.values };
  const fe = state.fieldErrors ?? {};
  const formRef = useRef<HTMLFormElement>(null);
  // Stand der Anwesenheit für den Sitzplan – folgt den Radios der Liste (Ereignis „change“ am Formular)
  const [statuses, setStatuses] = useState<Record<string, Status>>(() =>
    Object.fromEntries(students.map((s) => [s.id, (v[`status-${s.id}`] as Status | undefined) ?? s.status])),
  );
  const toggleSeat = (id: string, next: Status) => {
    const radio = formRef.current?.querySelector<HTMLInputElement>(`input[name="status-${CSS.escape(id)}"][value="${next}"]`);
    radio?.click();
  };
  return (
    <form
      ref={formRef}
      key={JSON.stringify(state.values ?? null)}
      action={formAction}
      onChange={(e) => {
        const t = e.target as unknown as HTMLInputElement;
        if (t.type === "radio" && t.name.startsWith("status-")) setStatuses((s) => ({ ...s, [t.name.slice(7)]: t.value as Status }));
      }}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="lessonId" value={lessonId} />
      <input type="hidden" name="date" value={date} />
      <Field label="Thema der Stunde" error={fe.topic}>
        <Input name="topic" defaultValue={v.topic} required maxLength={500} />
      </Field>
      <Field label="Hausaufgabe" hint="optional · sehen die Schüler:innen der Gruppe (ggf. auch Eltern) – bitte keine Namen von Schüler:innen" error={fe.homework}>
        <Textarea name="homework" defaultValue={v.homework} rows={2} maxLength={1000} />
      </Field>
      <Field label="Fällig am" hint="optional · nur Schultage · leer = zur nächsten Stunde dieser Gruppe im Fach" error={fe.homeworkDue}>
        <Input type="date" name="homeworkDue" defaultValue={v.homeworkDue} min={initial.homeworkDue && initial.homeworkDue < dueMin ? initial.homeworkDue : dueMin} className="w-48" />
      </Field>
      {coupledLabel && (
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" name="alsoCoupled" defaultChecked={state.values ? state.values.alsoCoupled === "on" : true} className="size-4 accent-[var(--accent)]" />
          Thema und Hausaufgabe auch für {coupledLabel} eintragen (Kopplung)
        </label>
      )}
      {seatPlan && <SeatAttendance plan={seatPlan} statuses={statuses} onToggle={toggleSeat} />}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">
          Anwesenheit <span className="font-normal text-muted">· {students.length} Schüler:innen</span>
        </legend>
        <ul className="rounded-card border border-border bg-surface px-4">
          {students.map((s) => (
            <StudentRow
              key={s.id}
              id={s.id}
              name={s.name}
              initial={(v[`status-${s.id}`] as Status | undefined) ?? s.status}
              minutes={v[`late-${s.id}`] ?? s.minutes}
              excused={s.excused}
              onLeave={s.onLeave}
              error={fe[`late-${s.id}`]}
            />
          ))}
        </ul>
      </fieldset>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Eintrag speichern"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Abbrechen</Link>
        </Button>
      </div>
    </form>
  );
}
