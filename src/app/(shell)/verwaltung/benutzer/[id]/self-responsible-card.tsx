"use client";

import { useState, useTransition } from "react";
import { setSelfResponsibleAction, type FormState } from "@/modules/verwaltung/actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";

/**
 * Q5-05: Kennzeichen „eigenständig (volljährig)“. Ab dann handelt die Person selbst (Elternbriefe, Eltern-Umfragen,
 * Abwesenheiten), verknüpfte Eltern sehen nichts mehr – außer die Person willigt selbst ein („Eltern weiter informieren“).
 */
export function SelfResponsibleCard({ id, on, parentsInformed, canEdit }: { id: string; on: boolean; parentsInformed: boolean; canEdit: boolean }) {
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2">
        {on ? <Badge tone="success">eigenständig</Badge> : <Badge>minderjährig</Badge>}
        {on && <span className="text-sm text-muted">{parentsInformed ? "Eltern werden mit Einwilligung weiter informiert" : "Eltern sehen nichts"}</span>}
      </p>
      <p className="text-sm text-muted">
        Eigenständige Schüler:innen bekommen Elternbriefe und Eltern-Umfragen selbst und melden Abwesenheiten selbst. Verknüpfte
        Eltern sehen keine Daten mehr – außer die Person willigt selbst ein (unter „Mein Konto → Eltern informieren“).
      </p>
      {canEdit && (
        <Button
          size="sm"
          className="w-fit"
          disabled={pending}
          onClick={() => {
            const msg = on
              ? "Kennzeichen entfernen? Die Eltern handeln dann wieder für das Kind; eine Einwilligung „Eltern weiter informieren“ entfällt."
              : "Als eigenständig (volljährig) kennzeichnen? Die verknüpften Eltern sehen danach keine Daten mehr.";
            if (confirm(msg)) start(async () => setState(await setSelfResponsibleAction(id, !on)));
          }}
        >
          {on ? "Kennzeichen entfernen" : "Als eigenständig kennzeichnen"}
        </Button>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}
