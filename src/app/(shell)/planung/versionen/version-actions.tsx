"use client";

import { useTransition } from "react";
import { Copy, Trash2 } from "lucide-react";
import { createVariantAction, discardVersionAction } from "@/modules/stundenplan/actions";
import { Button } from "@schulos/ui/button";

/** SP3-01: Variante anlegen und Entwurf verwerfen (mit Rückfrage) – nur an offenen Entwürfen; die Karte (article) gibt den Bezug. */
export function VersionActions({ id, label }: { id: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <div className="mt-auto flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(() => createVariantAction(id))}>
        <Copy aria-hidden /> Variante anlegen
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          if (confirm(`Entwurf ${label} verwerfen? Der gültige Plan bleibt unverändert; der Entwurf bleibt als „verworfen“ in der Liste.`)) start(() => discardVersionAction(id));
        }}
      >
        <Trash2 aria-hidden /> Verwerfen
      </Button>
    </div>
  );
}
