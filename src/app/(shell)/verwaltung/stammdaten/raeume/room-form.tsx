"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { ROOM_KINDS } from "@/core/db/schema";
import { ROOM_KIND_LABELS } from "@/core/labels";
import { roomHref } from "@/core/room-href";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export interface RoomFormValues {
  code: string;
  name: string;
  kind: string;
  /** RS-10: Auswahlwert f:<etage>, b:<gebäude> oder leer */
  place: string;
  capacity: number | null;
  accessible: boolean;
  active: boolean;
}

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function RoomForm({
  action,
  deleteAction,
  initial,
  buildings,
  used = 0,
  submitLabel,
}: {
  action: Action;
  deleteAction?: Action;
  initial?: RoomFormValues;
  /** RS-10: Gebäude mit Etagen aus den Stammdaten */
  buildings: { id: string; name: string; floors: { id: string; name: string }[] }[];
  used?: number;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [delState, delAction, deleting] = useActionState(deleteAction ?? action, {});
  const v = state.values;
  const fe = { ...state.fieldErrors, ...delState.fieldErrors };
  const error = state.error ?? delState.error;
  // nach einem Fehler gelten die Eingaben, sonst die gespeicherten Werte
  const val = (k: keyof RoomFormValues, fallback: string) => (v ? (v[k] ?? "") : fallback);
  const checked = (k: "accessible" | "active", fallback: boolean) => (v ? v[k] === "on" : fallback);

  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <Field label="Kürzel" hint="z. B. 112, NW2, TH1" error={fe.code}>
        <Input name="code" defaultValue={val("code", initial?.code ?? "")} maxLength={10} required />
      </Field>
      <Field label="Name" error={fe.name}>
        <Input name="name" defaultValue={val("name", initial?.name ?? "")} required />
      </Field>
      <Field label="Raumart" error={fe.kind}>
        <Select name="kind" defaultValue={val("kind", initial?.kind ?? "klassenraum")}>
          {ROOM_KINDS.map((k) => (
            <option key={k} value={k}>
              {ROOM_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Kapazität" hint="Plätze, optional" error={fe.capacity}>
        <Input name="capacity" type="number" min={1} max={2000} inputMode="numeric" defaultValue={val("capacity", initial?.capacity?.toString() ?? "")} />
      </Field>
      <Field label="Gebäude und Etage" hint="Optional" error={fe.place}>
        <Select name="place" defaultValue={val("place", initial?.place ?? "")}>
          <option value="">keine Angabe</option>
          {buildings.map((b) => (
            <optgroup key={b.id} label={b.name}>
              <option value={`b:${b.id}`}>{b.name} (ohne Etage)</option>
              {b.floors.map((f) => (
                <option key={f.id} value={`f:${f.id}`}>
                  {b.name} · {f.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <p className="self-end text-sm text-muted">
        <Link href="/verwaltung/stammdaten/raeume/gebaeude" className="font-medium text-accent-ink hover:underline">
          Gebäude und Etagen verwalten
        </Link>
      </p>

      <p className="text-sm text-muted sm:col-span-2">
        {initial ? (
          <>
            Ausstattung (mit Menge) und Fotos pflegen Sie im{" "}
            <Link href={roomHref(initial.code)} className="font-medium text-accent-ink hover:underline">
              Raumsteckbrief
            </Link>
            .
          </>
        ) : (
          "Ausstattung und Fotos kommen nach dem Anlegen im Raumsteckbrief dazu."
        )}
      </p>

      <div className="flex flex-col gap-2 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="accessible" defaultChecked={checked("accessible", initial?.accessible ?? false)} className="size-4 accent-[var(--accent)]" /> barrierefrei erreichbar
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={checked("active", initial?.active ?? true)} className="size-4 accent-[var(--accent)]" /> aktiv (in Stundenplan, Vertretungen und Buchungen auswählbar)
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending || deleting}>
          {submitLabel}
        </Button>
        {deleteAction && (
          <Button
            type="submit"
            formAction={delAction}
            formNoValidate
            variant="ghost"
            className="text-danger"
            disabled={pending || deleting || used > 0}
            title={used > 0 ? `Noch ${used}× verplant – stattdessen „aktiv“ abwählen` : undefined}
            onClick={(e) => {
              if (!confirm(`Raum „${initial?.code}“ wirklich löschen?`)) e.preventDefault();
            }}
          >
            <Trash2 aria-hidden /> Löschen
          </Button>
        )}
      </div>
    </form>
  );
}
