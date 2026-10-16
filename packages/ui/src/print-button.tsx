"use client";

import { Printer } from "lucide-react";
import { Button } from "./button";

/** Öffnet den Druckdialog (dort auch „Als PDF speichern“); im Ausdruck unsichtbar. */
export function PrintButton({ label = "Drucken / als PDF speichern" }: { label?: string }) {
  return (
    <Button type="button" variant="primary" className="print:hidden" onClick={() => window.print()}>
      <Printer aria-hidden /> {label}
    </Button>
  );
}
