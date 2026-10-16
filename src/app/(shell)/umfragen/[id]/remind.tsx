"use client";

import { Bell } from "lucide-react";
import { useActionState } from "react";
import { remindAction, type RemindState } from "@/modules/umfragen/actions";
import { Button } from "@schulos/ui/button";

export function Remind({ id, open }: { id: string; open: number }) {
  const [state, formAction, pending] = useActionState(remindAction.bind(null, id), {} as RemindState);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <Button type="submit" size="sm" disabled={pending || open === 0}>
        <Bell aria-hidden /> {open === 1 ? "1 Person erinnern" : `${open} Personen erinnern`}
      </Button>
      {state.message && (
        <p role="status" className="text-sm text-success">
          {state.message}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
