"use client";

import { EyeOff, Flag, Lock, LockOpen, Eye } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { hidePostAction, reportPostAction, setTopicLockedAction, unhidePostAction } from "@/modules/foren/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

/** Kleines Formular „Grund angeben“ hinter einem Knopf – fürs Melden und Ausblenden. */
function ReasonForm({
  action,
  label,
  submitLabel,
  done,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  label: string;
  submitLabel: string;
  done: string;
}) {
  const [reason, setReason] = useState("");
  const [state, formAction, pending] = useActionState(action, {});
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        {done}
      </p>
    );
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <Field label={label} error={state.fieldErrors?.reason} className="min-w-0 flex-1">
        <Input name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required />
      </Field>
      <Button type="submit" size="sm" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function ReportPost({ postId }: { postId: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen(true)}>
        <Flag aria-hidden /> Melden
      </Button>
    );
  return <ReasonForm action={reportPostAction.bind(null, postId)} label="Warum meldest du den Beitrag?" submitLabel="Melden" done="Danke – die Moderation sieht sich den Beitrag an." />;
}

export function HidePost({ topicId, postId }: { topicId: string; postId: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen(true)}>
        <EyeOff aria-hidden /> Ausblenden
      </Button>
    );
  return <ReasonForm action={hidePostAction.bind(null, topicId, postId)} label="Grund (sehen alle)" submitLabel="Ausblenden" done="Ausgeblendet." />;
}

export function UnhidePost({ topicId, postId }: { topicId: string; postId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" className="self-start" disabled={pending} onClick={() => start(() => unhidePostAction(topicId, postId))}>
      <Eye aria-hidden /> Wieder einblenden
    </Button>
  );
}

export function LockToggle({ topicId, locked }: { topicId: string; locked: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" disabled={pending} onClick={() => start(() => setTopicLockedAction(topicId, !locked))}>
      {locked ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
      {locked ? "Entsperren" : "Sperren"}
    </Button>
  );
}
