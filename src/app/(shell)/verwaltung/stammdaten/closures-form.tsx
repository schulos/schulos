"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";

interface Row {
  id: string;
  kind: "ferien" | "frei";
  name: string;
  startsOn: string;
  endsOn: string;
  /** gesetzt = automatisch abgerufen (wird beim Ändern zur Handpflege) */
  source?: string | null;
}

const KINDS = [
  { value: "ferien", label: "Ferien" },
  { value: "frei", label: "unterrichtsfrei" },
] as const;

export function ClosuresForm({ action, closures }: { action: (prev: FormState, form: FormData) => Promise<FormState>; closures: Row[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  const err = (k: string) => fe[k] && <span className="block text-xs text-danger">{fe[k]}</span>;
  const cells = (k: string, r: { kind: string; name: string; startsOn: string; endsOn: string; source?: string | null }, label: string) => (
    <>
      <td>
        <Select name={`kind-${k}`} defaultValue={v[`kind-${k}`] ?? r.kind} aria-label={`Art ${label}`} className="h-9">
          {KINDS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        {err(`kind-${k}`)}
      </td>
      <td>
        <Input name={`name-${k}`} defaultValue={v[`name-${k}`] ?? r.name} placeholder={k === "new" ? "z. B. Herbstferien" : undefined} aria-label={`Bezeichnung ${label}`} aria-invalid={fe[`name-${k}`] ? true : undefined} className="h-9" />
        {r.source && (
          <Badge tone="soft" className="mt-1" title="Automatisch abgerufen – wird beim Ändern zur Handpflege">
            automatisch
          </Badge>
        )}
        {err(`name-${k}`)}
      </td>
      <td>
        <Input type="date" name={`start-${k}`} defaultValue={v[`start-${k}`] ?? r.startsOn} aria-label={`Von ${label}`} aria-invalid={fe[`start-${k}`] ? true : undefined} className="h-9" />
        {err(`start-${k}`)}
      </td>
      <td>
        <Input type="date" name={`end-${k}`} defaultValue={v[`end-${k}`] ?? r.endsOn} aria-label={`Bis ${label}`} aria-invalid={fe[`end-${k}`] ? true : undefined} className="h-9" />
        {err(`end-${k}`)}
      </td>
    </>
  );
  return (
    <form key={JSON.stringify([state.values ?? null, closures])} action={formAction} className="flex flex-col gap-4">
      <button type="submit" name="intent" value="save" className="sr-only" tabIndex={-1} aria-hidden>
        Speichern
      </button>
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase">
          <thead>
            <tr>
              <th className="w-44">Art</th>
              <th>Bezeichnung</th>
              <th className="w-44">Von</th>
              <th className="w-44">Bis (einschl.)</th>
              <th className="w-28">
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {closures.map((c) => (
              <tr key={c.id}>
                {cells(c.id, c, c.name)}
                <td className="text-right">
                  <Button type="submit" name="intent" value={`delete:${c.id}`} variant="ghost" size="icon" className="size-9 text-danger" disabled={pending} aria-label={`${c.name} löschen`}>
                    <Trash2 aria-hidden />
                  </Button>
                </td>
              </tr>
            ))}
            <tr className="bg-surface-2/50">
              {cells("new", { kind: "ferien", name: "", startsOn: "", endsOn: "" }, "neuer Eintrag")}
              <td className="text-right">
                <Button type="submit" name="intent" value="add" size="sm" disabled={pending}>
                  Hinzufügen
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Gespeichert.
        </p>
      )}
      <div>
        <Button type="submit" name="intent" value="save" variant="primary" disabled={pending}>
          Ferien speichern
        </Button>
      </div>
    </form>
  );
}
