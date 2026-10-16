"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { activityTracker, type ActivityTracker } from "./passive";

// G4E-C01: automatisches Neuladen zählt nicht als Aktivität (Erklärung in passive.ts). Der Tracker startet beim Laden des Moduls
// im Browser – die Shell lädt es immer mit (Gong), Eingaben vor dem ersten Neuladen zählen also mit.
let tracker: ActivityTracker | null = null;

function activity(): ActivityTracker {
  if (!tracker) {
    const t = activityTracker(document);
    tracker = t;
    const onInput = () => t.input();
    for (const e of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(e, onInput, { capture: true, passive: true });
    window.addEventListener("popstate", onInput);
    // Seitenaufruf = Aktivität; ein liegengebliebenes Kennzeichen vom letzten Besuch gilt nicht
    t.input();
  }
  return tracker;
}

if (typeof window !== "undefined") activity();

/** Server-Daten automatisch neu laden (Live-Ereignis, Zeitgeber) – ohne Eingabe der Person keine Aktivität. */
export function passiveRefresh(router: { refresh(): void }): void {
  activity().beforeAutomatic();
  router.refresh();
}

/** Kopfzeilen für eigene automatische Anfragen (Herzschlag von Tafeln/Texten). */
export function passiveHeaders(): Record<string, string> {
  return activity().headers();
}

/** Lädt die Server-Daten der Seite regelmäßig neu (z. B. „noch 23 Min.“ in der Tagesleiste) – zählt nicht als Aktivität. */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") passiveRefresh(router);
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
