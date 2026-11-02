"use client";

import { useTransition } from "react";
import { deleteAssetAction, renewAssetCodeAction } from "@/modules/gebaeude/actions";
import { Button } from "@schulos/ui/button";

/** INV-02: neuen Etikett-Code erzeugen – mit Rückfrage, der alte Code wird ungültig. */
export function RenewAssetCode({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm("Neuen Code erzeugen? Das bisherige Etikett führt danach nirgends mehr hin.")) start(() => renewAssetCodeAction(id));
      }}
    >
      Neuen Code erzeugen
    </Button>
  );
}

/** Ausgemustertes Inventar endgültig löschen (Recht `gebaeude.configure`). */
export function DeleteAsset({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm("Eintrag samt Etikett-Code und Prüfungen endgültig löschen?")) start(() => deleteAssetAction(id));
      }}
    >
      Endgültig löschen
    </Button>
  );
}
