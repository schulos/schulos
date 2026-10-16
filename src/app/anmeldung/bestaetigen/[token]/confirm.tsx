"use client";

import { useActionState } from "react";
import { confirmAntragAction, type PublicFormState } from "@/modules/anmeldung/public-actions";
import { Button } from "@schulos/ui/button";

export function ConfirmButton({ token }: { token: string }) {
  const [state, action, pending] = useActionState<PublicFormState>(() => confirmAntragAction(token), {});
  return (
    <form action={action} aria-label="Bestätigen" className="flex flex-col gap-2">
      <Button type="submit" variant="primary" className="w-fit" disabled={pending}>
        {pending ? "Wird bestätigt …" : "Anmeldung bestätigen"}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
