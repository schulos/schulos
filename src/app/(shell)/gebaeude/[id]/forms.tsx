"use client";

import { useActionState } from "react";
import { MAX_PHOTO_MB, TRANSITION_LABELS, type TicketStatus } from "@/modules/gebaeude/labels";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Option = { value: string; label: string };

function Feedback({ state, ok }: { state: FormState; ok?: string }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok && ok)
    return (
      <p role="status" className="text-sm text-success">
        {ok}
      </p>
    );
  return null;
}

/** Status weiterziehen: ein Knopf je erlaubtem Übergang, optional mit Kommentar; bei „erledigt“ Sperre beenden. */
export function StatusForm({ action, transitions, hasBlock }: { action: Action; transitions: readonly TicketStatus[]; hasBlock: boolean }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form key={String(state.ok ?? "") + JSON.stringify(state.values ?? null)} action={formAction} aria-label="Status ändern" className="flex flex-col gap-3">
      <Field label="Kommentar zum Statuswechsel" hint="optional, die meldende Person sieht ihn">
        <Input name="comment" maxLength={2000} defaultValue={state.values?.comment} placeholder="z. B. Ersatzteil bestellt" />
      </Field>
      {hasBlock && transitions.includes("erledigt") && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="endBlock" defaultChecked className="size-4 accent-[var(--accent)]" />
          Bei „Erledigt“ die Raumsperre ab heute beenden
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {transitions.map((s) => (
          <Button key={s} type="submit" name="status" value={s} size="sm" variant={s === "erledigt" || s === "angenommen" ? "primary" : "secondary"} disabled={pending}>
            {TRANSITION_LABELS[s]}
          </Button>
        ))}
      </div>
      <Feedback state={state} ok="Status geändert." />
    </form>
  );
}

export function CommentForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form key={String(state.ok ?? "") + JSON.stringify(state.values ?? null)} action={formAction} aria-label="Kommentar schreiben" className="flex flex-col gap-2">
      <Field label="Kommentar" error={state.fieldErrors?.comment}>
        <Textarea name="comment" maxLength={2000} defaultValue={state.values?.comment} className="min-h-20" required />
      </Field>
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          Kommentieren
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function AssignForm({ action, options, current }: { action: Action; options: Option[]; current: string | null }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form key={current ?? ""} action={formAction} aria-label="Zuweisen" className="flex flex-wrap items-end gap-2">
      <Field label="Bearbeitet von" error={state.fieldErrors?.assigneeId}>
        <Select name="assigneeId" defaultValue={current ?? ""} className="w-56">
          <option value="">niemand</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" size="sm" className="mb-1" disabled={pending}>
        Zuweisen
      </Button>
      <Feedback state={state} ok="Gespeichert." />
    </form>
  );
}

export function PhotoForm({ action, left }: { action: Action; left: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form key={String(state.ok ?? "")} action={formAction} aria-label="Fotos hinzufügen" className="flex flex-wrap items-end gap-2">
      <Field label={`Fotos hinzufügen (noch ${left})`} hint={`JPEG, PNG oder WebP, je höchstens ${MAX_PHOTO_MB} MB – nur Sachen, keine Personen`} error={state.fieldErrors?.photos}>
        <Input type="file" name="photos" accept="image/jpeg,image/png,image/webp" capture="environment" multiple className="py-2" />
      </Field>
      <Button type="submit" size="sm" className="mb-6" disabled={pending}>
        Hochladen
      </Button>
    </form>
  );
}

/** Raum aus der Meldung sperren: Zeitraum, optional nur einzelne Stunden (Grund „defekt“). */
export function BlockForm({ action, periods, today, roomId }: { action: Action; periods: Option[]; today: string; roomId: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Raum sperren" className="grid gap-3 sm:grid-cols-2">
      <Field label="von Tag" error={fe.startsOn}>
        <Input type="date" name="startsOn" defaultValue={v.startsOn ?? today} required />
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
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          Raum {roomId} sperren
        </Button>
      </div>
      <div className="sm:col-span-2">
        <Feedback state={state} />
      </div>
    </form>
  );
}
