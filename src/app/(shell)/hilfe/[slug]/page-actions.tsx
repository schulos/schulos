"use client";

import { ArrowDown, ArrowUp, CheckCheck, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { deletePageAction, markReviewedAction, movePageAction } from "@/modules/hilfe/actions";
import { Button } from "@schulos/ui/button";

/** „Geprüft, unverändert“ (HB-04): Frist neu setzen, ohne den Inhalt zu ändern. */
export function ReviewButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  return (
    <>
      <Button size="sm" disabled={pending || done} onClick={() => start(async () => {
        await markReviewedAction(id);
        setDone(true);
      })}>
        <CheckCheck aria-hidden /> Geprüft, unverändert
      </Button>
      {done && (
        <span role="status" className="text-sm text-muted">
          Als geprüft vermerkt.
        </span>
      )}
    </>
  );
}

export function MoveButtons({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <span className="flex gap-1">
      <Button size="sm" variant="ghost" disabled={pending} aria-label="Seite nach oben schieben" onClick={() => start(() => movePageAction(id, -1))}>
        <ArrowUp aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} aria-label="Seite nach unten schieben" onClick={() => start(() => movePageAction(id, 1))}>
        <ArrowDown aria-hidden />
      </Button>
    </span>
  );
}

export function DeletePage({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm("Seite wirklich löschen? Das lässt sich nicht rückgängig machen.")) start(() => deletePageAction(id));
      }}
    >
      <Trash2 aria-hidden /> Löschen
    </Button>
  );
}
