"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useSyncExternalStore } from "react";

const STORE = "schulos.vertretung.tasten";
// Schalter „Tastenkürzel verwenden“: Browser-Speicher, Rückfall auf den Stand der offenen Seite (Speicher kann gesperrt sein)
let memory = true;
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function readOn(): boolean {
  try {
    const stored = window.localStorage.getItem(STORE);
    if (stored) return stored !== "aus";
  } catch {
    // gesperrt
  }
  return memory;
}

/** Steht der Fokus in einem Eingabefeld (auch Auswahl, Radio-Gruppe, Textfeld-Rolle), gehören die Tasten dem Feld. */
function inField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return true;
  return el.closest('[role="textbox"],[role="combobox"],[role="listbox"],[role="radiogroup"],[role="slider"],[role="spinbutton"]') !== null;
}

/**
 * VT-03b: Tastenkürzel des Arbeitsplatzes – ↑/↓ durch die offenen Stunden, 1–3 Vorschlag übernehmen, Esc Stunde schließen.
 * Nur ohne Strg/Alt/Meta/Umschalt und nur, wenn kein Eingabefeld den Fokus hat; mit Schalter „Tastenkürzel verwenden“ (WCAG 2.1.4,
 * gemerkt im Browser). Die Ziele tragen `aria-keyshortcuts`; Screenreader-Tasten im Lesemodus erreichen die Seite nicht.
 */
export function ArbeitsplatzTasten({ prev, next, close, suggestions }: { prev: string | null; next: string | null; close: string | null; suggestions: number }) {
  const router = useRouter();
  const on = useSyncExternalStore(subscribe, readOn, () => true);
  const id = useId();
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || inField(e.target)) return;
      if (e.key === "ArrowDown" && next) router.push(next);
      else if (e.key === "ArrowUp" && prev) router.push(prev);
      else if (e.key === "Escape" && close) router.push(close);
      else if (/^[1-3]$/.test(e.key) && Number(e.key) <= suggestions) {
        const button = document.querySelector<HTMLButtonElement>(`[data-suggest-key="${e.key}"]`);
        if (!button || button.disabled) return;
        button.click();
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on, prev, next, close, suggestions, router]);
  const toggle = (checked: boolean) => {
    memory = checked;
    try {
      window.localStorage.setItem(STORE, checked ? "an" : "aus");
    } catch {
      // Speicher gesperrt: gilt nur, solange die Seite offen ist
    }
    listeners.forEach((l) => l());
  };
  return (
    <details className="rounded-xl border border-border bg-surface px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Tastenkürzel</summary>
      <div className="mt-2 flex flex-col gap-2">
        <ul className="flex flex-col gap-1">
          <li>
            <kbd className="rounded border border-border bg-surface-2 px-1.5 font-mono text-xs">↑</kbd> / <kbd className="rounded border border-border bg-surface-2 px-1.5 font-mono text-xs">↓</kbd> vorherige/nächste offene Stunde
          </li>
          <li>
            <kbd className="rounded border border-border bg-surface-2 px-1.5 font-mono text-xs">1</kbd>–<kbd className="rounded border border-border bg-surface-2 px-1.5 font-mono text-xs">3</kbd> Vorschlag 1 bis 3 übernehmen
            (danach die nächste offene Stunde)
          </li>
          <li>
            <kbd className="rounded border border-border bg-surface-2 px-1.5 font-mono text-xs">Esc</kbd> Stunde schließen
          </li>
        </ul>
        <p className="text-muted">Die Tasten gelten nur, wenn kein Eingabefeld den Fokus hat (Strg, Alt, Umschalt und Meta gehören dem Browser).</p>
        <label htmlFor={id} className="flex min-h-11 items-center gap-2">
          <input id={id} type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          Tastenkürzel verwenden
        </label>
      </div>
    </details>
  );
}
