"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Textarea } from "@schulos/ui/field";

export function ConfirmForm({
  action,
  childName,
  responseType,
  question,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  childName: string;
  responseType: "none" | "yesno" | "text";
  question: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label={`Rückmeldung für ${childName}`} className="flex flex-col gap-3">
      {responseType === "yesno" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{question}</legend>
          <div className="flex gap-4">
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="answer" value="ja" defaultChecked={v.answer === "ja"} className="size-4 accent-[var(--accent)]" /> Ja
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="answer" value="nein" defaultChecked={v.answer === "nein"} className="size-4 accent-[var(--accent)]" /> Nein
            </label>
          </div>
        </fieldset>
      )}
      {responseType === "text" && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{question}</span>
          <Textarea name="answerText" defaultValue={v.answerText} rows={3} maxLength={1000} />
        </label>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {responseType === "none" ? `Gelesen – für ${childName} bestätigen` : `Für ${childName} absenden`}
        </Button>
      </div>
    </form>
  );
}
