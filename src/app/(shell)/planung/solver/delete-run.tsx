"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { deleteSolverAction } from "@/modules/stundenplan/actions";
import { Button } from "@schulos/ui/button";

/** Lauf löschen mit Rückfrage (SP-07). Übernommene Stunden bleiben, nur ihre Herkunft wird leer. */
export function DeleteRun({ id, applied }: { id: string; applied: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        const text = applied
          ? "Lauf wirklich löschen? Die übernommenen Stunden bleiben im Stundenplan, verlieren aber den Verweis auf diesen Lauf."
          : "Lauf wirklich löschen? Parameter, Kennzahlen, Protokoll und Vorschlag gehen verloren.";
        if (confirm(text)) start(() => deleteSolverAction(id));
      }}
    >
      <Trash2 aria-hidden /> Lauf löschen
    </Button>
  );
}
