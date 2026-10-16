"use client";

import { useActionState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { ROOM_KINDS } from "@/core/db/schema";
import { ROOM_KIND_LABELS } from "@/core/labels";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";

interface Row {
  id: string;
  name: string;
  color: string;
  roomKind: string | null;
  used: number;
}

export function SubjectsForm({ action, subjects }: { action: (prev: FormState, form: FormData) => Promise<FormState>; subjects: Row[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  const err = (k: string) => fe[k] && <span className="block text-xs text-danger">{fe[k]}</span>;
  return (
    // Server-Werte im key: nach Umbenennen/Verschieben/Löschen startet das Formular mit dem neuen Stand
    <form key={JSON.stringify([state.values ?? null, subjects])} action={formAction} className="flex flex-col gap-4">
      {/* Enter in einem Feld löst „Speichern“ aus, nicht den ersten Pfeil-Knopf */}
      <button type="submit" name="intent" value="save" className="sr-only" tabIndex={-1} aria-hidden>
        Speichern
      </button>
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase">
          <thead>
            <tr>
              <th className="w-28">Kürzel</th>
              <th>Name</th>
              <th className="w-20">Farbe</th>
              <th className="w-60">Raumart</th>
              <th className="w-24 text-right">Verplant</th>
              <th className="w-36">
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((s, i) => (
              <tr key={s.id}>
                <td>
                  <Input name={`code-${s.id}`} defaultValue={v[`code-${s.id}`] ?? s.id} aria-label={`Kürzel ${s.name}`} aria-invalid={fe[`code-${s.id}`] ? true : undefined} maxLength={6} className="h-9" />
                  {err(`code-${s.id}`)}
                </td>
                <td>
                  <Input name={`name-${s.id}`} defaultValue={v[`name-${s.id}`] ?? s.name} aria-label={`Name ${s.id}`} aria-invalid={fe[`name-${s.id}`] ? true : undefined} className="h-9" />
                  {err(`name-${s.id}`)}
                </td>
                <td>
                  <input type="color" name={`color-${s.id}`} defaultValue={(v[`color-${s.id}`] ?? s.color).toLowerCase()} aria-label={`Farbe ${s.id}`} className="h-9 w-12 cursor-pointer rounded-lg border border-border bg-surface p-1" />
                </td>
                <td>
                  <Select name={`roomKind-${s.id}`} defaultValue={v[`roomKind-${s.id}`] ?? s.roomKind ?? ""} aria-label={`Raumart ${s.id}`} className="h-9">
                    <option value="">egal</option>
                    {ROOM_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {ROOM_KIND_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="text-right tabular-nums text-muted">{s.used}</td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button type="submit" name="intent" value={`up:${s.id}`} variant="ghost" size="icon" className="size-9" disabled={pending || i === 0} aria-label={`${s.id} nach oben`}>
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button type="submit" name="intent" value={`down:${s.id}`} variant="ghost" size="icon" className="size-9" disabled={pending || i === subjects.length - 1} aria-label={`${s.id} nach unten`}>
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="submit"
                      name="intent"
                      value={`delete:${s.id}`}
                      variant="ghost"
                      size="icon"
                      className="size-9 text-danger"
                      disabled={pending || s.used > 0}
                      aria-label={`${s.id} löschen`}
                      title={s.used > 0 ? "Wird noch verwendet" : undefined}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            <tr className="bg-surface-2/50">
              <td>
                <Input name="code-new" defaultValue={v["code-new"] ?? ""} placeholder="Neu" aria-label="Kürzel neues Fach" aria-invalid={fe["code-new"] ? true : undefined} maxLength={6} className="h-9" />
                {err("code-new")}
              </td>
              <td>
                <Input name="name-new" defaultValue={v["name-new"] ?? ""} placeholder="z. B. Spanisch" aria-label="Name neues Fach" aria-invalid={fe["name-new"] ? true : undefined} className="h-9" />
                {err("name-new")}
              </td>
              <td>
                <input type="color" name="color-new" defaultValue={v["color-new"] ?? "#868e96"} aria-label="Farbe neues Fach" className="h-9 w-12 cursor-pointer rounded-lg border border-border bg-surface p-1" />
              </td>
              <td>
                <Select name="roomKind-new" defaultValue={v["roomKind-new"] ?? ""} aria-label="Raumart neues Fach" className="h-9">
                  <option value="">egal</option>
                  {ROOM_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ROOM_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </td>
              <td />
              <td className="text-right">
                <Button type="submit" name="intent" value="add" size="sm" disabled={pending}>
                  Hinzufügen
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">Ein geändertes Kürzel wird in Stundenplan, Klassenbuch, Klausurplan und Gruppen übernommen. Löschen geht nur bei Fächern, die nirgends verplant sind.</p>
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
          Fächer speichern
        </Button>
      </div>
    </form>
  );
}
