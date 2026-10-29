"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setListFeatureAction } from "@/modules/ganztag/actions";

/** Schalter „Anwesenheitsliste“ je Gruppe (Merkmal `ganztag.liste`) – zeigt den neuen Stand sofort. */
export function ListToggle({ groupId, name, on }: { groupId: string; name: string; on: boolean }) {
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic(on);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1 sm:items-end">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3">
        <input
          type="checkbox"
          role="switch"
          className="size-4 accent-[var(--accent)]"
          checked={shown}
          disabled={pending}
          onChange={() =>
            start(async () => {
              setShown(!on);
              const r = await setListFeatureAction(groupId, !on);
              setError(r.error ?? null);
            })
          }
        />
        <span className="text-sm font-medium">
          Anwesenheitsliste<span className="sr-only"> für {name}</span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
