"use client";

import { useState } from "react";

/** VT-03b: Aufklapper „Material“ – offen, wenn schon Material vorliegt; danach gehört der Zustand dem Nutzer (kein Zuklappen beim Speichern). */
export function MaterialPanel({ title, initialOpen, children }: { title: string; initialOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-xl border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </details>
  );
}
