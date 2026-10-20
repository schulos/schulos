"use client";

import { Undo2 } from "lucide-react";
import { useTransition } from "react";
import { undoSolverAction } from "@/modules/stundenplan/actions";
import { Button } from "@schulos/ui/button";

/** „Übernahme zurücknehmen“ mit Rückfrage (SP-09) – bis zum Stichtag; die Rückfrage nennt, was dabei verloren geht. */
export function UndoApply({ id, lessons, substitutions, lostSubstitutions }: { id: string; lessons: number; substitutions: number; lostSubstitutions: number }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="primary"
      disabled={pending}
      onClick={() => {
        const parts = [
          `Übernahme wirklich zurücknehmen? ${lessons} Stunden dieses Laufs werden entfernt, der vorherige Plan gilt wieder.`,
          substitutions ? `${substitutions} Vertretungen an diesen Stunden gehen verloren.` : null,
          lostSubstitutions ? `${lostSubstitutions} bei der Übernahme entfernte Vertretungen kommen nicht zurück.` : null,
        ].filter(Boolean);
        if (confirm(parts.join(" "))) start(() => undoSolverAction(id));
      }}
    >
      <Undo2 aria-hidden /> Übernahme zurücknehmen
    </Button>
  );
}
