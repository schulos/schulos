"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { deletePostAction } from "@/modules/news/actions";
import { Button } from "@schulos/ui/button";

export function DeletePost({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm("Beitrag wirklich löschen?")) start(() => deletePostAction(id));
      }}
    >
      <Trash2 aria-hidden /> Löschen
    </Button>
  );
}
