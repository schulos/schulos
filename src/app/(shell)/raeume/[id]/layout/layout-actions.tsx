"use client";

import { useTransition } from "react";
import { deleteRoomLayoutAction, setDefaultRoomLayoutAction } from "@/modules/verwaltung/raum-daten-actions";
import { Button } from "@schulos/ui/button";

/** RS-08: Layout zum Standard machen bzw. löschen (mit Rückfrage; Sitzpläne behalten ihre Kopie). */
export function LayoutActions({ roomId, layoutId, name, isDefault }: { roomId: string; layoutId: string; name: string; isDefault: boolean }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap gap-2">
      {!isDefault && (
        <Button type="button" size="sm" disabled={pending} onClick={() => start(() => setDefaultRoomLayoutAction(roomId, layoutId))}>
          Als Standard festlegen
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => {
          if (confirm(`Layout „${name}“ löschen? Sitzpläne, die daraus angelegt wurden, bleiben unverändert.`)) start(() => deleteRoomLayoutAction(roomId, layoutId));
        }}
      >
        Layout löschen
      </Button>
    </div>
  );
}
