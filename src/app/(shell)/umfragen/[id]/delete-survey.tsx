"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { deleteSurveyAction } from "@/modules/umfragen/actions";
import { Button } from "@schulos/ui/button";

export function DeleteSurvey({ id, responses }: { id: string; responses: number }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        const extra = responses > 0 ? ` Alle ${responses} Antworten gehen verloren.` : "";
        if (confirm(`Umfrage wirklich löschen?${extra}`)) start(() => deleteSurveyAction(id));
      }}
    >
      <Trash2 aria-hidden /> Löschen
    </Button>
  );
}
