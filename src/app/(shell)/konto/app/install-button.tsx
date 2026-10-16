"use client";

import { useState } from "react";
import { useInstallPrompt, useStandalone } from "@/ui/pwa";
import { Button } from "@schulos/ui/button";

/** Knopf „Jetzt installieren“ – nur wenn der Browser die Installation anbietet (P4-73). */
export function InstallButton() {
  const { available, install } = useInstallPrompt();
  const standalone = useStandalone();
  const [done, setDone] = useState(false);
  if (standalone || done)
    return (
      <p role="status" className="text-sm text-success">
        SchulOS läuft bereits als App.
      </p>
    );
  if (!available)
    return (
      <p className="text-sm text-muted" data-testid="pwa-kein-angebot">
        Dieser Browser bietet die Installation gerade nicht direkt an – so geht es von Hand:
      </p>
    );
  return (
    <div>
      <Button type="button" variant="primary" onClick={() => void install().then(setDone)}>
        Jetzt installieren
      </Button>
    </div>
  );
}
