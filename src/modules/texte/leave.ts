// TD-06: Wann der Texte-Editor beim Schließen oder Verlassen warnt. Nur „gespeichert“ (und der Zustand ohne Schreibrecht
// bzw. nach Löschung) ist bestätigt; alles andere liegt noch in der Warteschlange des Tabs oder wurde abgelehnt.
export type EditorStatus = "synced" | "pending" | "offline" | "readonly" | "removed" | { error: string };

/** `queued`: Es gibt noch nicht bestätigte Updates (Warteschlange oder laufender POST), egal was die Statuszeile zeigt */
export function hasUnconfirmedChanges(status: EditorStatus, queued: boolean): boolean {
  if (typeof status === "object") return true; // abgelehnt: der Serverstand weicht ab
  return status === "pending" || status === "offline" || queued;
}

/**
 * Review R3 N3: Rückfrage des Browsers auslösen – `preventDefault()` **und** `returnValue` (manche Browser fragen nur mit
 * gesetztem `returnValue` nach; so hält es auch das Offline-Notenbuch).
 */
export function warnBeforeLeave(e: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">, unconfirmed: boolean): void {
  if (!unconfirmed) return;
  e.preventDefault();
  e.returnValue = "";
}
