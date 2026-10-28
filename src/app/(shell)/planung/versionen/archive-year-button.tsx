"use client";

import { useTransition } from "react";
import { Archive } from "lucide-react";
import { archiveYearAction } from "@/modules/stundenplan/actions";
import { Button } from "@schulos/ui/button";

/** SP3-07: abgelaufenes Schuljahr archivieren – mit Rückfrage (offene Entwürfe werden verworfen). */
export function ArchiveYearButton({ yearId, yearName, open }: { yearId: string; yearName: string; open: number }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() => {
        const drafts = open > 0 ? ` ${open === 1 ? "Ein offener Entwurf wird" : `${open} offene Entwürfe werden`} verworfen.` : "";
        if (confirm(`Schuljahr ${yearName} archivieren? Die gültige Version wird archiviert und bleibt lesbar.${drafts}`)) start(() => archiveYearAction(yearId));
      }}
    >
      <Archive aria-hidden /> {pending ? "Wird archiviert …" : `Schuljahr ${yearName} archivieren`}
    </Button>
  );
}
