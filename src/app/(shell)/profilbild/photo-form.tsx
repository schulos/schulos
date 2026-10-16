"use client";

import { startTransition, useActionState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

const SIZE = 512;

/**
 * Im Browser quadratisch zuschneiden und auf 512 px verkleinern: Drehung aus EXIF wird dabei angewandt, das Ergebnis
 * hat keinerlei Metadaten. Klappt das nicht (alter Browser), geht die Originaldatei – der Server entfernt EXIF ohnehin.
 */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const out = Math.min(SIZE, side);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = out;
    canvas.getContext("2d")!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

export function PhotoForm({
  action,
  userId,
  label,
  paper,
  consentText,
  today,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  userId: string;
  label: string;
  /** Verwaltung erfasst eine schriftliche Einwilligung (mit Datum) */
  paper: boolean;
  consentText: string;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form
      key={String(state.ok ?? "")}
      aria-label={label}
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const file = fd.get("photo");
        if (file instanceof File && file.size > 0) fd.set("photo", await shrink(file), "profilbild.jpg");
        startTransition(() => formAction(fd));
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <Field label="Foto (JPEG oder PNG)" error={fe.photo}>
        <Input type="file" name="photo" accept="image/jpeg,image/png" required />
      </Field>
      {paper && (
        <Field label="Datum der schriftlichen Einwilligung" error={fe.consentOn}>
          <Input type="date" name="consentOn" max={today} required className="w-48" />
        </Field>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="consent" value="1" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
        <span>{consentText}</span>
      </label>
      {fe.consent && <span className="text-xs text-danger">{fe.consent}</span>}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Foto speichern
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          Profilbild gespeichert.
        </p>
      )}
    </form>
  );
}
