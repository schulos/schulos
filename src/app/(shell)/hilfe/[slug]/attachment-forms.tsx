"use client";

import { Trash2 } from "lucide-react";
import { useActionState, useTransition } from "react";
import { addAttachmentAction, deleteAttachmentAction } from "@/modules/hilfe/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

/** HB-05: Datei an die Seite hängen – Typ, Größe und Virenscan prüft der Server. */
export function AttachmentUploadForm({ pageId, accept, formats, maxMb }: { pageId: string; accept: string; formats: string; maxMb: number }) {
  const [state, formAction, pending] = useActionState(addAttachmentAction.bind(null, pageId), {});
  return (
    <form action={formAction} aria-label="Anhang hochladen" className="flex flex-col gap-3">
      <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
        Bitte keine Dateien mit Namen oder Daten von Schülerinnen und Schülern sowie keine Gesundheits- oder Notendaten anhängen.
      </p>
      {state.ok && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          {state.message}
        </p>
      )}
      <Field label="Datei" hint={`${formats}, höchstens ${maxMb} MB`} error={state.fieldErrors?.file}>
        <Input type="file" name="file" accept={accept} required className="py-2" />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird hochgeladen …" : "Anhängen"}
        </Button>
      </div>
    </form>
  );
}

export function DeleteAttachment({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      aria-label={`Anhang ${name} löschen`}
      onClick={() => {
        if (confirm(`Anhang „${name}“ wirklich löschen?`)) start(() => deleteAttachmentAction(id));
      }}
    >
      <Trash2 aria-hidden /> Löschen
    </Button>
  );
}
