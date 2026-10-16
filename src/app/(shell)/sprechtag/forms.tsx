"use client";

import { useActionState, useTransition } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export interface EventDefaults {
  title: string;
  date: string;
  startsAt: string;
  endsAt: string;
  slotMinutes: string;
  breaks: string;
  bookingOpensOn: string;
  bookingClosesOn: string;
}

/** Sprechtag anlegen bzw. ändern (Verwaltung). */
export function EventForm({ action, defaults, submitLabel, savedText }: { action: Action; defaults: EventDefaults; submitLabel: string; savedText?: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v: Record<string, string> = { ...defaults, ...state.values };
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label={submitLabel} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Titel" error={fe.title} className="sm:col-span-2">
        <Input name="title" defaultValue={v.title} required maxLength={120} />
      </Field>
      <Field label="Datum" error={fe.date}>
        <Input type="date" name="date" defaultValue={v.date} required />
      </Field>
      <Field label="Gesprächslänge" error={fe.slotMinutes}>
        <Select name="slotMinutes" defaultValue={v.slotMinutes}>
          {[5, 10, 15, 20, 30].map((m) => (
            <option key={m} value={m}>
              {m} Minuten
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Beginn" error={fe.startsAt}>
        <Input type="time" name="startsAt" defaultValue={v.startsAt} required />
      </Field>
      <Field label="Ende" error={fe.endsAt}>
        <Input type="time" name="endsAt" defaultValue={v.endsAt} required />
      </Field>
      <Field label="Pausen" hint="z. B. 17:30–17:45, mehrere mit Komma" error={fe.breaks} className="sm:col-span-2">
        <Input name="breaks" defaultValue={v.breaks} placeholder="17:30–17:45" />
      </Field>
      <Field label="Buchung ab" error={fe.bookingOpensOn}>
        <Input type="date" name="bookingOpensOn" defaultValue={v.bookingOpensOn} required />
      </Field>
      <Field label="Buchung bis (einschließlich)" error={fe.bookingClosesOn}>
        <Input type="date" name="bookingClosesOn" defaultValue={v.bookingClosesOn} required />
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

/** Lehrkraft: Raum und angebotene Zeiten (Vorgabe: alle). */
export function AvailabilityForm({
  action,
  slots,
  offered,
  booked,
  rooms,
  roomId,
  released,
}: {
  action: Action;
  slots: { value: string; label: string }[];
  offered: string[];
  booked: string[];
  rooms: { value: string; label: string }[];
  roomId: string;
  released: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const offeredSet = new Set(offered);
  const bookedSet = new Set(booked);
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label="Meine Zeiten" className="flex flex-col gap-4">
      <Field label="Raum" error={fe.roomId} className="max-w-sm">
        <Select name="roomId" defaultValue={state.values?.roomId ?? roomId}>
          <option value="">ohne Raum</option>
          {rooms.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Angebotene Zeiten</legend>
        <div className="flex flex-wrap gap-2">
          {slots.map((s) => (
            <label key={s.value} className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm tabular-nums has-[:checked]:bg-accent-soft">
              <input type="hidden" name="allSlots" value={s.value} />
              <input type="checkbox" name="slot" value={s.value} defaultChecked={offeredSet.has(s.value)} disabled={bookedSet.has(s.value)} className="size-4 accent-[var(--accent)]" />
              {s.label}
              {bookedSet.has(s.value) && <span className="text-xs text-muted">gebucht</span>}
              {/* gebuchte Zeiten bleiben angeboten (deaktivierte Felder werden nicht gesendet) */}
              {bookedSet.has(s.value) && <input type="hidden" name="slot" value={s.value} />}
            </label>
          ))}
        </div>
        {fe.blockedSlots && <p className="text-xs text-danger">{fe.blockedSlots}</p>}
      </fieldset>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Gespeichert – Eltern können diese Zeiten buchen.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {released ? "Zeiten speichern" : "Zeiten freigeben"}
        </Button>
      </div>
    </form>
  );
}

/** Lehrkraft: Gesprächswunsch an die Eltern einer Schülerin/eines Schülers. */
export function InviteForm({ action, students }: { action: Action; students: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label="Gesprächswunsch" className="flex flex-wrap items-end gap-2">
      <Field label="Schüler:in" error={state.fieldErrors?.studentId} className="min-w-64 flex-1">
        <Select name="studentId" defaultValue={state.values?.studentId ?? ""} required>
          <option value="">Bitte wählen</option>
          {students.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>
        Gesprächswunsch schicken
      </Button>
      {state.ok && (
        <p role="status" className="w-full text-sm text-success">
          Verschickt – die Eltern haben eine Nachricht bekommen.
        </p>
      )}
    </form>
  );
}

/** Knopf mit Rückfrage (Löschen, Absagen). */
export function ConfirmButton({ action, question, label, ariaLabel }: { action: () => Promise<void>; question: string; label: string; ariaLabel?: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      aria-label={ariaLabel}
      onClick={() => {
        if (confirm(question)) start(() => action());
      }}
    >
      {label}
    </Button>
  );
}
