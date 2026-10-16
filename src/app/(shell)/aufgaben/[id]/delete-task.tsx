"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { deleteTaskAction } from "@/modules/aufgaben/actions";
import { Button } from "@schulos/ui/button";

export function DeleteTask({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm("Aufgabe samt allen Abgaben löschen?")) start(() => deleteTaskAction(id));
      }}
    >
      <Trash2 aria-hidden /> Aufgabe löschen
    </Button>
  );
}
