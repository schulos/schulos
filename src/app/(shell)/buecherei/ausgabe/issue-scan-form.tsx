"use client";

import { useActionState, useEffect, useRef } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

/**
 * Scanfeld der Schulbuchausgabe (BU-11): Ausweis wählt die Person, ein ausgegebenes Schulbuch wird zurückgenommen, sonst an die
 * gewählte Person ausgegeben. Für die Rücknahme vorher Zustand, Vermerk oder Befund wählen – sie gelten für den nächsten Scan.
 */
export function IssueScanForm({ action, hint, conditions }: { action: (prev: FormState, form: FormData) => Promise<FormState>; hint: string; conditions: readonly string[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>("input[name=code]")?.focus();
  }, [state]);
  return (
    <form ref={form} action={formAction} aria-label="Schulbuch scannen" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Ausweis oder Schulbuch scannen" hint={hint} className="min-w-64 flex-1">
          <Input name="code" autoFocus autoComplete="off" spellCheck={false} maxLength={40} className="font-mono" />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Buchen …" : "Buchen"}
        </Button>
      </div>
      <details className="rounded-lg border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">Rücknahme: Zustand, Vermerk, Befund</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Zustand bei Rücknahme">
            <Select name="condition" defaultValue="">
              <option value="">unverändert</option>
              {conditions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Zustandsvermerk" hint="nur die Sache, keine Namen">
            <Input name="conditionNote" maxLength={200} placeholder="z. B. Einband lose" />
          </Field>
          <Field label="Befund (Ersatz prüfen)" hint="Schaden oder Verlust – bleibt bis zur Klärung">
            <Input name="finding" maxLength={200} placeholder="z. B. Wasserschaden" />
          </Field>
        </div>
      </details>
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
