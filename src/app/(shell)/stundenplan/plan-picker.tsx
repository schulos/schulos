"use client";

import type { ChangeEvent, ReactNode } from "react";

/**
 * Q5-28: Klasse, Lehrkraft und Raum stehen in einem Formular – abgeschickt werden alle drei, und die Seite nimmt Klasse vor
 * Lehrkraft vor Raum. Ohne Zurücksetzen blieb so nach „Klasse“ die Wahl einer Lehrkraft wirkungslos (Befund 0.5.0).
 * Wer ein Feld wählt, leert deshalb die beiden anderen.
 */
export function PlanPicker({ children }: { children: ReactNode }) {
  function onChange(e: ChangeEvent<HTMLFormElement>) {
    const changed = e.target;
    if (!(changed instanceof HTMLSelectElement) || !changed.value) return;
    for (const el of Array.from(e.currentTarget.elements)) {
      if (el instanceof HTMLSelectElement && el !== changed) el.value = "";
    }
  }
  return (
    <form onChange={onChange} className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[1fr_1fr_1fr_auto]" aria-label="Plan wählen">
      {children}
    </form>
  );
}
