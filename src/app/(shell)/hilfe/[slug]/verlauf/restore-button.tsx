"use client";

import { RotateCcw } from "lucide-react";
import { useTransition } from "react";
import { restoreRevisionAction } from "@/modules/hilfe/actions";
import { Button } from "@schulos/ui/button";

export function RestoreButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() => {
        if (confirm("Diese Fassung wiederherstellen? Der aktuelle Stand bleibt im Verlauf erhalten.")) start(() => restoreRevisionAction(id));
      }}
    >
      <RotateCcw aria-hidden /> Wiederherstellen
    </Button>
  );
}
