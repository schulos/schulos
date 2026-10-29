"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@schulos/ui/button";

/** RS-11: neuen Tür-QR-Code erzeugen – mit Rückfrage, weil das Schild an der Tür danach nicht mehr funktioniert. */
export function RenewQrButton({ action, roomId }: { action: () => Promise<void>; roomId: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Neuen QR-Code für Raum ${roomId} erzeugen? Der alte Code führt danach nirgends mehr hin – das Türschild neu drucken.`)) e.preventDefault();
      }}
    >
      <Button type="submit" variant="ghost" size="sm">
        <RefreshCw aria-hidden /> Neuen Code erzeugen
      </Button>
    </form>
  );
}
