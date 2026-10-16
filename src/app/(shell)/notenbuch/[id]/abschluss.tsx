"use client";

import { useState, useTransition } from "react";
import { adoptSuggestionsAction, lockBookAction } from "@/modules/notenbuch/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";

/**
 * Halbjahresabschluss (P5-13): Vorschläge übernehmen (nur wo noch nichts festgelegt ist), einzelne Noten in der Tabelle
 * abweichend festlegen, dann abschließen und sperren. Danach keine Änderungen – entsperren nur die Schulleitung (protokolliert).
 */
export function TermClose({ bookId, open, total, locked, lockedAt }: { bookId: string; open: number; total: number; locked: boolean; lockedAt: string | null }) {
  const [state, setState] = useState<FormState & { count?: number }>({});
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();

  if (locked)
    return (
      <p className="text-sm text-muted">
        Abgeschlossen{lockedAt ? ` am ${lockedAt}` : ""}. Die Halbjahresnoten stehen in der Übergabeliste der Klasse; Änderungen gehen nur, wenn die
        Schulleitung das Notenbuch wieder öffnet (wird protokolliert).
      </p>
    );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        {total - open} von {total} Halbjahresnoten festgelegt. Abweichungen vom Vorschlag trägst du in der Spalte „Halbjahresnote“ ein. Amtlich ist die
        Schulverwaltungssoftware – SchulOS liefert nur die Übergabeliste und den Export, keine Zeugnisse.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || open === 0} onClick={() => start(async () => setState(await adoptSuggestionsAction(bookId)))}>
          Vorschläge übernehmen ({open} offen)
        </Button>
        {!confirm ? (
          <Button variant="primary" disabled={pending} onClick={() => setConfirm(true)}>
            Abschließen und sperren
          </Button>
        ) : (
          <span role="alert" className="flex flex-wrap items-center gap-2 text-sm">
            Danach sind keine Änderungen mehr möglich.
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setState(await lockBookAction(bookId));
                  setConfirm(false);
                })
              }
            >
              Endgültig abschließen
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Abbrechen
            </Button>
          </span>
        )}
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && state.count !== undefined && (
        <p role="status" className="text-sm text-success">
          {state.count === 1 ? "1 Vorschlag übernommen." : `${state.count} Vorschläge übernommen.`}
        </p>
      )}
    </div>
  );
}
