"use client";

import { useState, useTransition } from "react";
import { setConferenceLinkAction } from "@/modules/kurse/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

type Link = { url: string; label: string; host: string };

/** V-01: Knopf zum externen Konferenzraum; Leitung, Lehrkräfte der Gruppe und Verwaltung können den Link setzen. */
export function ConferenceLink({ groupId, link, canEdit }: { groupId: string; link: Link | null; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  if (!link && !canEdit) return null;

  function save(form: FormData) {
    start(async () => {
      const res = await setConferenceLinkAction(groupId, String(form.get("url") ?? ""), String(form.get("label") ?? ""));
      setError(res.error);
      if (!res.error) setEditing(false);
    });
  }

  return (
    <section aria-label="Konferenzraum" className="flex flex-col gap-3">
      {link && !editing && (
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="primary">
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              {link.label} öffnen
            </a>
          </Button>
          <span className="text-sm text-muted">
            öffnet {link.host} · externer Dienst, es gelten dessen Datenschutzhinweise
          </span>
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Link ändern
            </Button>
          )}
        </div>
      )}
      {!link && !editing && (
        <div>
          <Button size="sm" onClick={() => setEditing(true)}>
            Konferenzraum-Link hinterlegen
          </Button>
        </div>
      )}
      {editing && (
        <form action={save} className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border p-4">
          <Field label="Adresse des Konferenzraums" hint="Nur https://. Alle Mitglieder des Kurses sehen den Link." error={error}>
            <Input name="url" type="url" inputMode="url" defaultValue={link?.url ?? ""} placeholder="https://" maxLength={500} />
          </Field>
          <Field label="Bezeichnung" hint="z. B. „Videoraum Mathe“ – leer lassen für „Konferenzraum“">
            <Input name="label" defaultValue={link?.label ?? ""} maxLength={60} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={pending}>
              Speichern
            </Button>
            {link && (
              <Button
                variant="danger"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await setConferenceLinkAction(groupId, "", "");
                    setError(res.error);
                    if (!res.error) setEditing(false);
                  })
                }
              >
                Link entfernen
              </Button>
            )}
            <Button variant="ghost" disabled={pending} onClick={() => (setEditing(false), setError(undefined))}>
              Abbrechen
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
