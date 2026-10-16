"use client";

import { useActionState, useState, useTransition } from "react";
import { copyPlanAction, createPlanAction, deletePlanAction, updatePlanMetaAction } from "@/modules/sitzplan/actions";
import { PRESETS, PRESET_LABELS } from "@/modules/sitzplan/layout";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

type Option = { id: string; name: string };

function Status({ state, saved }: { state: FormState; saved?: string }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="text-sm text-danger sm:col-span-full">
          {state.error}
        </p>
      )}
      {state.ok && saved && (
        <p role="status" className="text-sm text-success sm:col-span-full">
          {saved}
        </p>
      )}
    </>
  );
}

function SubjectRoom({ subjects, rooms, subjectId, roomId, fe }: { subjects: Option[]; rooms: Option[]; subjectId: string; roomId: string; fe: Record<string, string> }) {
  return (
    <>
      <Field label="Fach" hint="optional – im Klassenbuch passt der Plan dann zu den Stunden dieses Fachs" error={fe.subjectId}>
        <Select name="subjectId" defaultValue={subjectId}>
          <option value="">alle Fächer</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Raum" hint="optional" error={fe.roomId}>
        <Select name="roomId" defaultValue={roomId}>
          <option value="">jeder Raum</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id === r.name || r.name.endsWith(r.id) ? r.name : `${r.id} – ${r.name}`}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

/** Neuer Sitzplan: Lerngruppe, Titel, Fach/Raum (optional), Raster und Tischanordnung als Vorlage. */
export function NewPlanForm({
  groups,
  subjects,
  rooms,
  defaultGroupId,
}: {
  groups: { id: string; name: string; subjectId: string | null; roomId: string | null }[];
  subjects: Option[];
  rooms: Option[];
  defaultGroupId: string;
}) {
  const [state, formAction, pending] = useActionState(createPlanAction, {});
  const [groupId, setGroupId] = useState(state.values?.groupId ?? defaultGroupId);
  const group = groups.find((g) => g.id === groupId) ?? groups[0]!;
  const v: Record<string, string> = { title: group.name, rows: "5", cols: "8", preset: "reihen", ...state.values };
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Neuer Sitzplan" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Lerngruppe" error={fe.groupId}>
        <Select name="groupId" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Titel" error={fe.title} className="lg:col-span-3">
        <Input key={`t-${group.id}`} name="title" defaultValue={state.values ? v.title : group.name} required maxLength={80} />
      </Field>
      <SubjectRoom key={group.id} subjects={subjects} rooms={rooms} subjectId={state.values?.subjectId ?? group.subjectId ?? ""} roomId={state.values?.roomId ?? group.roomId ?? ""} fe={fe} />
      <Field label="Tischanordnung" error={fe.preset}>
        <Select name="preset" defaultValue={v.preset}>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Reihen" hint="von vorn (Tafel) nach hinten" error={fe.rows}>
        <Input type="number" name="rows" defaultValue={v.rows} min={1} max={12} required />
      </Field>
      <Field label="Plätze je Reihe" error={fe.cols}>
        <Input type="number" name="cols" defaultValue={v.cols} min={1} max={12} required />
      </Field>
      <Status state={state} />
      <div className="sm:col-span-full">
        <Button type="submit" variant="primary" disabled={pending}>
          Sitzplan anlegen
        </Button>
      </div>
    </form>
  );
}

/** Titel, Fach, Raum ändern. */
export function MetaForm({ id, title, subjectId, roomId, subjects, rooms }: { id: string; title: string; subjectId: string; roomId: string; subjects: Option[]; rooms: Option[] }) {
  const [state, formAction, pending] = useActionState(updatePlanMetaAction.bind(null, id), {});
  const v = { title, subjectId, roomId, ...state.values };
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state)} action={formAction} aria-label="Angaben zum Sitzplan" className="grid gap-4 sm:grid-cols-3">
      <Field label="Titel" error={fe.title}>
        <Input name="title" defaultValue={v.title} required maxLength={80} />
      </Field>
      <SubjectRoom subjects={subjects} rooms={rooms} subjectId={v.subjectId} roomId={v.roomId} fe={fe} />
      <Status state={state} saved="Angaben gespeichert." />
      <div className="sm:col-span-full">
        <Button type="submit" disabled={pending}>
          Angaben speichern
        </Button>
      </div>
    </form>
  );
}

/** Kopie anlegen (mit Tischen und Plätzen), z. B. für ein anderes Fach. */
export function CopyForm({ id, title }: { id: string; title: string }) {
  const [state, formAction, pending] = useActionState(copyPlanAction.bind(null, id), {});
  return (
    <form action={formAction} aria-label="Sitzplan kopieren" className="flex flex-wrap items-end gap-3">
      <Field label="Titel der Kopie" error={state.fieldErrors?.title}>
        <Input name="title" defaultValue={state.values?.title ?? `${title} (Kopie)`} required maxLength={80} className="w-72" />
      </Field>
      <Button type="submit" disabled={pending}>
        Kopie anlegen
      </Button>
      <Status state={state} />
    </form>
  );
}

export function DeletePlanButton({ id, title }: { id: string; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <span className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Sitzplan „${title}“ löschen?`)) return;
          start(async () => {
            const r = await deletePlanAction(id);
            if (r?.error) setError(r.error);
          });
        }}
      >
        Sitzplan löschen
      </Button>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
