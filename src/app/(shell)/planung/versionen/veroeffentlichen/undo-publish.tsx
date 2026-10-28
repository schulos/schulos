"use client";

import { Undo2 } from "lucide-react";
import { useTransition } from "react";
import { undoPublishAction } from "@/modules/stundenplan/actions";
import { Button } from "@schulos/ui/button";

/** „Veröffentlichung zurücknehmen“ mit Rückfrage (SP3-04) – bis zum Stichtag; die Rückfrage nennt, was dabei verloren geht. */
export function UndoPublish({ id, label, lessons, lost }: { id: string; label: string; lessons: number; lost: number }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="primary"
      disabled={pending}
      onClick={() => {
        const parts = [
          `Veröffentlichung von Version ${label} wirklich zurücknehmen? ${lessons} neue Stunden werden entfernt, der bisherige Plan gilt wieder; die Version ist danach wieder freigegeben.`,
          lost ? `${lost} Vertretungen, Materialien oder Klassenbuch-Bezüge an neuen Stunden kommen nicht zurück.` : null,
        ].filter(Boolean);
        if (confirm(parts.join(" "))) start(() => undoPublishAction(id));
      }}
    >
      <Undo2 aria-hidden /> Veröffentlichung zurücknehmen
    </Button>
  );
}
