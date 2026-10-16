"use client";

import { logoutAction } from "@/app/(auth)/login/actions";
import { queuedBookCount } from "@/app/(shell)/notenbuch/[id]/offline-store";
import { clearAppCaches } from "@/ui/pwa";

/** Text der Rückfrage vor dem Abmelden, wenn im Notenbuch noch Offline-Eingaben liegen (G5A-C01, Q-5A-25). */
export function offlineLogoutWarning(books: number): string {
  return (
    `Im Notenbuch liegen auf diesem Gerät noch nicht übertragene Offline-Eingaben (${books} ${books === 1 ? "Notenbuch" : "Notenbücher"}). ` +
    "Beim Abmelden wird der Zwischenspeicher unlesbar und sie gehen verloren – zum Übertragen das Notenbuch mit Verbindung öffnen. Trotzdem abmelden?"
  );
}

/**
 * Abmelden mit Warnung (GATE-5a, G5A-C01): Echtes Abmelden beendet die Offline-Eingabe des Notenbuchs auf diesem Gerät. Liegen
 * im Zwischenspeicher dieses Kontos noch Warteschlangen, fragt der Browser vorher nach.
 */
export async function logoutWithOfflineCheck(userId: string): Promise<void> {
  const books = await queuedBookCount(userId).catch(() => 0);
  if (books > 0 && !window.confirm(offlineLogoutWarning(books))) return;
  // P4-73: Programmdateien der PWA mit löschen (Inhalte liegen dort nie)
  await clearAppCaches();
  await logoutAction();
}
