"use client";

import { Search } from "lucide-react";
import { Kbd } from "@schulos/ui/misc";

/** Öffnet die Kommandopalette (P0-10 lauscht auf dieses Event). */
export function openPalette() {
  window.dispatchEvent(new CustomEvent("schulos:palette"));
}

export function SearchButton() {
  return (
    <button
      type="button"
      onClick={openPalette}
      className="flex min-h-11 flex-1 items-center gap-2.5 rounded-xl border border-border bg-surface px-3.5 text-left text-muted transition hover:border-border-strong sm:max-w-[560px]"
    >
      <Search className="size-[18px] shrink-0" aria-hidden />
      <span className="flex-1 truncate">
        <span className="sm:hidden">Suchen …</span>
        <span className="hidden sm:inline">Suchen oder Befehl eingeben …</span>
      </span>
      <span className="hidden gap-1 sm:flex">
        <Kbd>Strg</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}

