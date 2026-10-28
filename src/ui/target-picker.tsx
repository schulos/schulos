"use client";

// Zielgruppen-Auswahl „Für wen?“ (Rollen und Gruppen, keine Auswahl = alle) – gemeinsam für News und Handbuch (HB-02).
// Schickt `targetRole` (je Rolle) und `targetGroup` (je Gruppe) mit dem Formular.
import { X } from "lucide-react";
import { useState } from "react";
import type { Role } from "@/core/roles";
import { Select } from "@schulos/ui/field";

export const TARGET_ROLES: Role[] = ["schueler", "lehrkraft", "eltern", "personal", "beratung", "verwaltung"];
export const ROLE_PLURAL: Record<Role, string> = {
  schueler: "Schüler:innen",
  lehrkraft: "Lehrkräfte",
  eltern: "Eltern",
  personal: "Personal",
  beratung: "Beratung (Schulsozialarbeit)",
  verwaltung: "Verwaltung",
  admin: "Administration",
};

export function TargetPicker({
  initialRoles,
  initialGroupIds,
  groups,
  everyoneText,
  hint,
  legend = "Für wen?",
}: {
  initialRoles: Role[];
  initialGroupIds: string[];
  groups: { id: string; name: string }[];
  /** Hinweis ohne Auswahl, z. B. „Ohne Auswahl sehen alle den Beitrag.“ */
  everyoneText: string;
  /** Hinweis mit Auswahl */
  hint: string;
  legend?: string;
}) {
  const [roles, setRoles] = useState<Role[]>(initialRoles);
  const [groupIds, setGroupIds] = useState<string[]>(initialGroupIds);
  const nameOf = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const everyone = roles.length === 0 && groupIds.length === 0;

  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
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
        {everyone ? everyoneText : hint}
      </p>
    </fieldset>
  );
}
