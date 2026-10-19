"use client";

import { useActionState, useEffect, useRef } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

/**
 * Scanfeld der Theke: Ein Hand-Scanner verhält sich wie eine Tastatur (Code + Enter). Das Feld bleibt nach jedem Scan
 * fokussiert und leer, die Meldung des letzten Scans steht darunter.
 */
export function ScanForm({ action, hint }: { action: (prev: FormState, form: FormData) => Promise<FormState>; hint: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>("input[name=code]")?.focus();
  }, [state]);
  return (
    <form ref={form} action={formAction} aria-label="Scannen" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Exemplar scannen" hint={hint} className="min-w-64 flex-1">
          <Input name="code" autoFocus autoComplete="off" spellCheck={false} maxLength={40} className="font-mono" />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Buchen …" : "Buchen"}
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && state.values?.result && (
        <p role="status" className="text-sm font-medium text-success">
          {state.values.result}
        </p>
      )}
    </form>
  );
}
