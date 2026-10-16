"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";

/** Übernahme in Gruppen – bei Hinweisen erst nach Bestätigung. */
export function TransferForm({ action, conflicts }: { action: (prev: FormState, form: FormData) => Promise<FormState>; conflicts: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} aria-label="Übernahme" className="flex flex-col gap-3">
      {conflicts > 0 && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="acceptConflicts" className="size-4 accent-[var(--accent)]" />
          Hinweise gesehen – trotzdem übernehmen
        </label>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          In Gruppen übernehmen
        </Button>
      </div>
    </form>
  );
}
