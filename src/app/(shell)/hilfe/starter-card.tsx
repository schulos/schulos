"use client";

import { useActionState } from "react";
import { installStarterPagesAction } from "@/modules/hilfe/actions";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";

/** HB-07: fehlende Starter-Seiten übernehmen – danach gehören sie der Schule und werden nicht mehr automatisch aktualisiert. */
export function StarterCard({ titles }: { titles: string[] }) {
  const [state, formAction, pending] = useActionState(() => installStarterPagesAction(), {});
  return (
    <Card aria-labelledby="starter" className="gap-3">
      <h2 id="starter" className="text-lg font-semibold">
        Starter-Seiten übernehmen
      </h2>
      <p className="text-sm text-muted">
        Neutrale Vorlagen zum Anpassen: {titles.join(", ")}. Sie landen veröffentlicht im Bereich „Erste Schritte“, sichtbar für die Gruppen, für die sie
        gedacht sind. Danach gehören sie Ihrer Schule und werden nicht automatisch aktualisiert; das „?“ in der Kopfzeile führt auf sie.
      </p>
      <form action={formAction} className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird angelegt …" : "Starter-Seiten anlegen"}
        </Button>
        {state.ok && (
          <span role="status" className="text-sm text-success">
            {state.message}
          </span>
        )}
      </form>
    </Card>
  );
}
