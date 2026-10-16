"use client";

import { useOptimistic, useTransition } from "react";
import { setCourseFeatureAction } from "@/modules/kurse/actions";

type Area = { id: string; label: string; moduleName: string; enabled: boolean };

/** P3-02: Leitung schaltet die Bereiche ihres Kurses (Gruppenmerkmale) selbst an/aus – sofort sichtbar, Server bestätigt. */
export function CourseAreas({ groupId, features }: { groupId: string; features: Area[] }) {
  const [pending, start] = useTransition();
  const [areas, toggle] = useOptimistic(features, (list: Area[], id: string) => list.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f)));
  return (
    <ul className="flex flex-col gap-2">
      {areas.map((f) => (
        <li key={f.id}>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={f.enabled}
              disabled={pending}
              onChange={() =>
                start(async () => {
                  toggle(f.id);
                  await setCourseFeatureAction(groupId, f.id, !f.enabled);
                })
              }
            />
            <span className="flex flex-col leading-tight">
              <span className="font-medium">{f.label}</span>
              <span className="text-xs text-muted">{f.moduleName}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
