"use client";

import { useActionState, useTransition } from "react";
import { deleteAssetAction, renewAssetCodeAction } from "@/modules/gebaeude/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { cn } from "@schulos/ui/cn";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Option = { value: string; label: string };

/** INV-02: neuen Etikett-Code erzeugen – mit Rückfrage, der alte Code wird ungültig. */
export function RenewAssetCode({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm("Neuen Code erzeugen? Das bisherige Etikett führt danach nirgends mehr hin.")) start(() => renewAssetCodeAction(id));
      }}
    >
      Neuen Code erzeugen
    </Button>
  );
}

/** Ausgemustertes Inventar endgültig löschen (Recht `gebaeude.configure`). */
export function DeleteAsset({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm("Eintrag samt Etikett-Code, Fotos und Prüfungen endgültig löschen?")) start(() => deleteAssetAction(id));
      }}
    >
      Endgültig löschen
    </Button>
  );
}

function Feedback({ state, ok }: { state: FormState; ok: string }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        {ok}
      </p>
    );
  return null;
}

/**
 * INV-03: Zustand per Knopf – große Schaltflächen für das Handy, der aktuelle Zustand ist gedrückt (`aria-pressed`). Ein Druck
 * speichert sofort.
 */
export function ConditionButtons({ action, current, options }: { action: Action; current: string | null; options: Option[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label="Zustand setzen" className="flex flex-col gap-2">
      <div role="group" aria-labelledby="zustand-h" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {options.map((o) => {
          const active = o.value === current;
          return (
            <Button
              key={o.value}
              type="submit"
              name="condition"
              value={o.value}
              variant={active ? "primary" : "secondary"}
              aria-pressed={active}
              disabled={pending}
              className={cn(o.value === "defekt" && !active && "text-danger")}
            >
              {o.label}
            </Button>
          );
        })}
      </div>
      <Feedback state={state} ok="Zustand gespeichert." />
    </form>
  );
}

/** INV-03: Standort ändern – Raum wählen, speichern. */
export function MoveForm({ action, rooms, current }: { action: Action; rooms: Option[]; current: string | null }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label="Standort ändern" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Neuer Raum" error={state.fieldErrors?.roomId} className="min-w-0 flex-1 basis-48">
          <Select name="roomId" defaultValue={current ?? ""} required>
            <option value="" disabled>
              Raum wählen
            </option>
            {rooms.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Speichern …" : "Umziehen"}
        </Button>
      </div>
      {!state.fieldErrors?.roomId && <Feedback state={state} ok="Standort gespeichert." />}
    </form>
  );
}

/** INV-03: Foto aufnehmen bzw. hochladen – mobil öffnet sich die Kamera; Hinweis „keine Personen“. */
export function AssetPhotoForm({ action, maxMb, left }: { action: Action; maxMb: number; left: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label="Foto hinzufügen" className="flex flex-col gap-3">
      <p role="note" className="text-xs text-muted">
        Nur das Gerät fotografieren – <strong>keine Personen</strong> und keine Zettel mit Namen. Das Foto wird verkleinert, Aufnahmeort und
        andere Metadaten werden entfernt. Noch {left} {left === 1 ? "Foto" : "Fotos"} möglich.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Foto" hint={`JPEG, PNG oder WebP, höchstens ${maxMb} MB`} error={state.fieldErrors?.photo} className="min-w-0 flex-1 basis-56">
          <Input type="file" name="photo" accept="image/jpeg,image/png,image/webp" capture="environment" required className="py-2" />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Wird hochgeladen …" : "Hochladen"}
        </Button>
      </div>
      {!state.fieldErrors?.photo && <Feedback state={state} ok="Foto hinzugefügt." />}
    </form>
  );
}

/** Foto löschen mit Rückfrage. */
export function DeleteAssetPhoto({ action, label }: { action: () => Promise<void>; label: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`${label} wirklich löschen?`)) e.preventDefault();
      }}
    >
      <Button type="submit" variant="ghost" size="sm" className="w-full text-danger" aria-label={`${label} löschen`}>
        Löschen
      </Button>
    </form>
  );
}
