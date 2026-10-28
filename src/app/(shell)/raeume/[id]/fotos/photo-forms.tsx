"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** RS-04: ein Foto hochladen (mit Bildunterschrift) – Hinweis „keine Personen“, der Server verkleinert und entfernt Metadaten. */
export function PhotoUploadForm({ action, maxMb, captionMax }: { action: Action; maxMb: number; captionMax: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Foto hochladen" className="flex flex-col gap-4">
      <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
        Nur den Raum und seine Ausstattung fotografieren – <strong>keine Personen</strong>, auch nicht im Hintergrund, und keine
        Aushänge mit Namen. Das Foto wird auf 1600 Pixel verkleinert, Aufnahmeort und andere Metadaten werden entfernt.
      </p>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Foto hochgeladen.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Foto" hint={`JPEG, PNG oder WebP, höchstens ${maxMb} MB`} error={fe.photo}>
          <Input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required className="py-2" />
        </Field>
        <Field label="Bildunterschrift" hint="optional, z. B. „Blick zur Tafel“" error={fe.caption}>
          <Input name="caption" maxLength={captionMax} defaultValue={state.values?.caption ?? ""} />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird hochgeladen …" : "Hochladen"}
        </Button>
      </div>
    </form>
  );
}

/** Bildunterschrift eines Fotos ändern. */
export function CaptionForm({ action, caption, name, captionMax }: { action: Action; caption: string; name: string; captionMax: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values;
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label={name} className="flex flex-wrap items-end gap-2">
      <Field label="Bildunterschrift" error={state.fieldErrors?.caption} className="min-w-0 flex-1">
        <Input name="caption" maxLength={captionMax} defaultValue={v ? (v.caption ?? "") : caption} />
      </Field>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        Speichern
      </Button>
      {state.ok && (
        <p role="status" className="w-full text-xs text-success">
          Gespeichert.
        </p>
      )}
    </form>
  );
}

/** Foto löschen mit Rückfrage. */
export function DeletePhotoButton({ action, label }: { action: () => Promise<void>; label: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`${label} wirklich löschen?`)) e.preventDefault();
      }}
    >
      <Button type="submit" variant="ghost" size="sm" className="text-danger" aria-label={`${label} löschen`}>
        Löschen
      </Button>
    </form>
  );
}
