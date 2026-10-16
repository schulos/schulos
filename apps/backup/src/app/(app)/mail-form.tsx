"use client";

import { useActionState } from "react";
import { Button } from "@schulos/ui/button";
import { testMailAction, type TestMailState } from "./mail-actions";

export function TestMailForm() {
  const [state, action, pending] = useActionState<TestMailState>(testMailAction, {});
  return (
    <form action={action} aria-label="Testmail" className="flex flex-col gap-2">
      <div>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Wird gesendet …" : "Testmail senden"}
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm whitespace-pre-line text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          {state.ok}
        </p>
      )}
    </form>
  );
}
