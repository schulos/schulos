"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";

export function GradesForm({
  action,
  grades,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  grades: { level: number; code: string; name: string; stage: "sek1" | "oberstufe"; groups: number }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase">
          <thead>
            <tr>
              <th className="w-16">Nr.</th>
              <th className="w-32">Kürzel</th>
              <th>Name</th>
              <th className="w-56">Stufe</th>
              <th className="w-24 text-right">Gruppen</th>
            </tr>
          </thead>
          <tbody>
            {grades.map((g) => (
              <tr key={g.level}>
                <td className="tabular-nums text-muted">{g.level}</td>
                <td>
                  <Input name={`code-${g.level}`} defaultValue={v[`code-${g.level}`] ?? g.code} aria-label={`Kürzel Jahrgang ${g.level}`} aria-invalid={fe[`code-${g.level}`] ? true : undefined} maxLength={8} className="h-9" />
                  {fe[`code-${g.level}`] && <span className="text-xs text-danger">{fe[`code-${g.level}`]}</span>}
                </td>
                <td>
                  <Input name={`name-${g.level}`} defaultValue={v[`name-${g.level}`] ?? g.name} aria-label={`Name Jahrgang ${g.level}`} aria-invalid={fe[`name-${g.level}`] ? true : undefined} className="h-9" />
                </td>
                <td>
                  <Select name={`stage-${g.level}`} defaultValue={v[`stage-${g.level}`] ?? g.stage} aria-label={`Stufe Jahrgang ${g.level}`} className="h-9">
                    <option value="sek1">Sekundarstufe I</option>
                    <option value="oberstufe">Oberstufe</option>
                  </Select>
                </td>
                <td className="text-right tabular-nums text-muted">{g.groups}</td>
              </tr>
            ))}
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
        <Button type="submit" variant="primary" disabled={pending}>
          Jahrgänge speichern
        </Button>
      </div>
    </form>
  );
}
