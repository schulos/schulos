"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import { ROOM_EQUIPMENT, ROOM_KINDS } from "@/core/db/schema";
import { ROOM_EQUIPMENT_LABELS, ROOM_KIND_LABELS } from "@/core/labels";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

export interface RoomFormValues {
  code: string;
  name: string;
  kind: string;
  building: string | null;
  floor: string | null;
  capacity: number | null;
  equipment: string[];
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
  /** vorhandene Gebäude als Vorschläge */
  buildings: string[];
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
  const equipment = v ? (v.equipment ?? "").split(",") : (initial?.equipment ?? []);
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
      <Field label="Gebäude" hint="Optional" error={fe.building}>
        <Input name="building" list="buildings" defaultValue={val("building", initial?.building ?? "")} />
      </Field>
      <datalist id="buildings">
        {buildings.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <Field label="Etage" hint="z. B. EG, 1. OG" error={fe.floor}>
        <Input name="floor" defaultValue={val("floor", initial?.floor ?? "")} />
      </Field>

      <fieldset className="flex flex-col gap-2 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Ausstattung</legend>
        <div className="grid gap-2 sm:grid-cols-4">
          {ROOM_EQUIPMENT.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="equipment" value={e} defaultChecked={equipment.includes(e)} className="size-4 accent-[var(--accent)]" /> {ROOM_EQUIPMENT_LABELS[e]}
            </label>
          ))}
        </div>
        {fe.equipment && <span className="text-xs text-danger">{fe.equipment}</span>}
      </fieldset>

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
