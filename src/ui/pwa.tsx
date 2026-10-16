"use client";

// PWA ohne Push (P4-73): Service Worker registrieren, Installationsangebot des Browsers merken, Caches beim Abmelden leeren.
// Regeln des Service Workers: src/core/pwa/service-worker.ts.
import { useEffect, useSyncExternalStore } from "react";

const CACHE_PREFIX = "schulos-";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Installationsangebot (Chrome/Edge/Android) – kommt einmal je Seitenaufruf, deshalb prozessweit gemerkt
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

/** Registriert den Service Worker (nur im Produktionsbau – im Dev-Server würden Entwicklungs-Dateien im Cache landen). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      // Update-Strategie: bei jedem Laden der Shell nach einer neuen Fassung fragen; sie übernimmt sofort (skipWaiting)
      .then((r) => r.update().catch(() => undefined))
      .catch(() => undefined);
  }, []);
  return null;
}

/** Löscht alle SchulOS-Caches dieses Browsers (Abmelden, Anmeldeseite) – auch ohne aktiven Service Worker. */
export async function clearAppCaches(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "clear" });
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
  } catch {
    // privater Modus o. Ä.: es gibt nichts zu leeren
  }
}

/** Auf der Anmeldeseite: Reste einer abgelaufenen bzw. anderswo beendeten Sitzung wegräumen. */
export function ClearAppCaches() {
  useEffect(() => {
    void clearAppCaches();
  }, []);
  return null;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Installationsangebot des Browsers, falls vorhanden – `install()` zeigt den Dialog des Browsers. */
export function useInstallPrompt(): { available: boolean; install: () => Promise<boolean> } {
  const available = useSyncExternalStore(
    subscribe,
    () => deferred !== null,
    () => false,
  );
  return {
    available,
    install: async () => {
      const e = deferred;
      if (!e) return false;
      deferred = null;
      notify();
      await e.prompt();
      return (await e.userChoice).outcome === "accepted";
    },
  };
}

/** Läuft SchulOS gerade als installierte App? */
export function useStandalone(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    () => false,
  );
}
