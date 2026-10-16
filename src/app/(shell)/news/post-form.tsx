"use client";

import { X } from "lucide-react";
import { useActionState, useState } from "react";
import type { Role } from "@/core/roles";
import { checkedAfter } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

const TARGET_ROLES: Role[] = ["schueler", "lehrkraft", "eltern", "personal", "beratung", "verwaltung"];
const ROLE_PLURAL: Record<Role, string> = {
  schueler: "Schüler:innen",
  lehrkraft: "Lehrkräfte",
  eltern: "Eltern",
  personal: "Personal",
  beratung: "Beratung (Schulsozialarbeit)",
  verwaltung: "Verwaltung",
  admin: "Administration",
};

export interface PostFormValues {
  title: string;
  body: string;
  pinned: boolean;
  onMonitor: boolean;
  expiresAt: string;
  targetRoles: Role[];
  targetGroupIds: string[];
}

export function PostForm({
  action,
  initial,
  groups,
  canPin,
  submitLabel,
  showNotify,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial?: PostFormValues;
  groups: { id: string; name: string }[];
  canPin: boolean;
  submitLabel: string;
  showNotify: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [roles, setRoles] = useState<Role[]>(initial?.targetRoles ?? []);
  const [groupIds, setGroupIds] = useState<string[]>(initial?.targetGroupIds ?? []);
  const fe = state.fieldErrors ?? {};
  // nach einem Fehler mit den eingegebenen Werten neu aufbauen (key) – React setzt das Formular sonst zurück (TD-02)
  const v = state.values;
  const nameOf = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const everyone = roles.length === 0 && groupIds.length === 0;

  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="flex flex-col gap-5">
      <Field label="Titel" error={fe.title}>
        <Input name="title" defaultValue={v?.title ?? initial?.title} maxLength={140} required />
      </Field>
      <Field label="Text" hint="Markdown: **fett**, *kursiv*, - Liste, [Link](https://…)" error={fe.body}>
        <Textarea name="body" defaultValue={v?.body ?? initial?.body} rows={10} required />
      </Field>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Für wen?</legend>
        <div className="flex flex-wrap gap-2">
          {TARGET_ROLES.map((r) => {
            const on = roles.includes(r);
            return (
              <label key={r} className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 has-checked:border-accent has-checked:bg-accent-soft">
                <input
                  type="checkbox"
                  name="targetRole"
                  value={r}
                  checked={on}
                  onChange={() => setRoles((cur) => (on ? cur.filter((x) => x !== r) : [...cur, r]))}
                  className="size-4 accent-[var(--accent)]"
                />
                {ROLE_PLURAL[r]}
              </label>
            );
          })}
        </div>
        <Select
          aria-label="Gruppe hinzufügen"
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && !groupIds.includes(id)) setGroupIds((cur) => [...cur, id]);
          }}
        >
          <option value="">Gruppe hinzufügen …</option>
          {groups
            .filter((g) => !groupIds.includes(g.id))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </Select>
        {groupIds.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {groupIds.map((id) => (
              <li key={id} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-1 pr-1 pl-3 text-sm text-accent-ink">
                <input type="hidden" name="targetGroup" value={id} />
                {nameOf(id)}
                <button type="button" aria-label={`${nameOf(id)} entfernen`} className="grid size-6 place-items-center rounded-full hover:bg-surface" onClick={() => setGroupIds((cur) => cur.filter((x) => x !== id))}>
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted" role="status">
          {everyone ? "Ohne Auswahl sehen alle den Beitrag." : "Eltern sehen Beiträge an die Klassen ihrer Kinder automatisch mit."}
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sichtbar bis" hint="Optional – danach verschwindet der Beitrag" error={fe.expiresAt}>
          <Input type="date" name="expiresAt" defaultValue={v?.expiresAt ?? initial?.expiresAt} />
        </Field>
        <div className="flex flex-col justify-end gap-2">
          {canPin && (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="pinned" defaultChecked={checkedAfter(v, "pinned", initial?.pinned)} className="size-4 accent-[var(--accent)]" /> Oben anheften
            </label>
          )}
          {canPin && (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="onMonitor" defaultChecked={checkedAfter(v, "onMonitor", initial?.onMonitor)} className="size-4 accent-[var(--accent)]" /> Im Laufband der Monitore zeigen
            </label>
          )}
          {showNotify && (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="notify" defaultChecked={checkedAfter(v, "notify", true)} className="size-4 accent-[var(--accent)]" /> Empfänger per Gong benachrichtigen
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : submitLabel}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
