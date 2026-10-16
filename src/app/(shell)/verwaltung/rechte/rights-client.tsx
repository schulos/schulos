"use client";

import { Trash2 } from "lucide-react";
import { useActionState, useOptimistic, useState, useTransition } from "react";
import type { Role } from "@/core/roles";
import { addGroupGrantAction, removeGrantAction, setModuleSettingAction, setRoleGrantAction, toggleModuleAction } from "@/modules/verwaltung/rights-actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";

export function GrantCheckbox({ role, permission, label, checked }: { role: Role; permission: string; label: string; checked: boolean }) {
  const [optimistic, setOptimistic] = useOptimistic(checked);
  const [, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <>
      <input
        type="checkbox"
        aria-label={label}
        className="size-4 cursor-pointer accent-[var(--accent)]"
        checked={optimistic}
        onChange={() =>
          start(async () => {
            setOptimistic(!optimistic);
            const res = await setRoleGrantAction(role, permission, !optimistic);
            setError(res.error);
          })
        }
      />
      {error && (
        <span className="mt-1 block max-w-40 text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

export function ModuleToggle({
  id,
  name,
  description,
  core,
  enabled,
  blockedHint,
}: {
  id: string;
  name: string;
  description: string;
  core: boolean;
  enabled: boolean;
  /** Einschalten gerade nicht möglich (z. B. ohne SMTP) – Hinweis statt Haken */
  blockedHint?: string;
}) {
  const [optimistic, setOptimistic] = useOptimistic(enabled);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  return (
    <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-border p-3 has-disabled:cursor-default">
      <input
        type="checkbox"
        className="mt-1 size-4 accent-[var(--accent)]"
        checked={optimistic}
        disabled={core || (Boolean(blockedHint) && !optimistic)}
        aria-label={`Modul ${name}`}
        onChange={() =>
          start(async () => {
            setOptimistic(!optimistic);
            const r = await toggleModuleAction(id, !optimistic);
            setError(r.error ?? null);
          })
        }
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 font-medium">
          {name} {core && <Badge>Kern</Badge>}
        </span>
        <span className="text-xs text-muted">{description}</span>
        {blockedHint && !optimistic && (
          <span role="note" className="text-xs text-warn">
            {blockedHint}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        )}
      </span>
    </label>
  );
}

export function GroupGrants({
  grants,
  groups,
  permissions,
}: {
  grants: { id: string; permission: string; groupId: string; groupName: string }[];
  groups: { id: string; name: string }[];
  permissions: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(addGroupGrantAction, {});
  const [removing, start] = useTransition();
  const labelOf = (id: string) => permissions.find((p) => p.id === id)?.label ?? id;
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-border">
        {grants.map((g) => (
          <li key={g.id} className="flex items-center gap-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="font-medium">{g.groupName}</span>
              <span className="text-xs text-muted">{labelOf(g.permission)}</span>
            </span>
            <Button size="sm" variant="ghost" disabled={removing} aria-label={`${g.groupName}: ${labelOf(g.permission)} entziehen`} onClick={() => start(() => removeGrantAction(g.id))}>
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
        {grants.length === 0 && <li className="py-4 text-sm text-muted">Noch keine Gruppen-Rechte.</li>}
      </ul>
      <form action={formAction} className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Gruppe">
          <Select name="groupId" required defaultValue="">
            <option value="" disabled>
              Gruppe wählen …
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Recht">
          <Select name="permission" required defaultValue="">
            <option value="" disabled>
              Recht wählen …
            </option>
            {permissions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={pending}>
          Recht vergeben
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-danger sm:col-span-3">
            {state.error}
          </p>
        )}
      </form>
    </div>
  );
}

/** Eine Moduleinstellung (Q5-14) – speichert sofort beim Ändern. */
export function ModuleSettingSelect({
  moduleId,
  settingKey,
  label,
  help,
  options,
  value,
  disabled,
}: {
  moduleId: string;
  settingKey: string;
  label: string;
  help?: string;
  options: readonly { value: string; label: string }[];
  value: string;
  /** DS-15: Einstellung braucht ein weiteres Recht (z. B. Datenschutz) */
  disabled?: boolean;
}) {
  const [optimistic, setOptimistic] = useOptimistic(value);
  const [error, setError] = useState<string>();
  const [, start] = useTransition();
  return (
    <Field label={label} hint={help} error={error}>
      <Select
        value={optimistic}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          start(async () => {
            setOptimistic(next);
            const r = await setModuleSettingAction(moduleId, settingKey, next);
            setError(r.error);
          });
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}
