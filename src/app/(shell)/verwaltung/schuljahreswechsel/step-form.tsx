"use client";

import { startTransition, useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";

/**
 * Formular eines Assistenten-Schritts. Absenden per onSubmit statt `action`, damit React die (vielen) Eingaben nach
 * einem Fehler nicht zurücksetzt.
 */
export function StepForm({
  action,
  label,
  submit,
  hidden,
  children,
  variant = "primary",
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  label: string;
  submit: string;
  hidden: Record<string, string>;
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => formAction(fd));
      }}
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
          {state.fieldErrors && Object.keys(state.fieldErrors).length > 1 && ` (und ${Object.keys(state.fieldErrors).length - 1} weitere)`}
        </p>
      )}
      <div>
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? "Bitte warten …" : submit}
        </Button>
      </div>
    </form>
  );
}
