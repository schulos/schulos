"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { deleteEventAction } from "@/modules/kalender/actions";
import { Button } from "@schulos/ui/button";

export function DeleteEvent({ id, recurring }: { id: string; recurring: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm(recurring ? "Die ganze Serie löschen?" : "Termin löschen?")) start(() => deleteEventAction(id));
      }}
    >
      <Trash2 aria-hidden /> Löschen
    </Button>
  );
}
