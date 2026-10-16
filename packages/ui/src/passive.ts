// GATE-4e (G4E-C01): Automatisches Neuladen ist keine Aktivität der Person (Inaktivitätsablauf P4-71, Q-4E-6/Q-4E-41).
//
// Tagesleiste und Vertretungsplan laden jede Minute neu, Gong/Pinnwand/Messenger bei Live-Ereignissen, Tafeln/Texte schicken
// alle 2 Minuten einen Herzschlag. Ohne Kennzeichen frischte jede dieser Anfragen `sessions.last_active_at` auf – die Sitzung
// lief bei offenem Tab nie ab. Deshalb:
//   - Der Browser merkt sich die letzte echte Eingabe (Zeiger, Taste, Mausrad, Berührung, Zurück/Vor; Seitenaufruf).
//   - Vor einem automatischen Neuladen ohne Eingabe in der letzten Minute setzt er das Cookie `schulos_passiv=1`
//     (`router.refresh()` kann keine Kopfzeilen setzen); eigene `fetch`-Aufrufe schicken stattdessen `x-schulos-passiv: 1`.
//   - Jede echte Eingabe löscht das Cookie sofort (noch bevor der Klick eine Anfrage auslöst).
//   - Der Server zählt gekennzeichnete Anfragen nicht als Aktivität – außer Seitenaufrufen (`Sec-Fetch-Mode: navigate`, z. B.
//     Adresse eingetippt oder neu geladen), die immer zählen.
// Das Kennzeichen kann nur die eigene Sitzung früher ablaufen lassen; wer die Sitzung absichtlich wachhalten will, kann das mit
// jeder Anfrage ohnehin – es ist also kein Sicherheitsmerkmal, sondern Schutz vor dem eigenen offenen Tab.
// Rein (ohne `"use client"`): vom Server (Prüfung) und vom Browser (Tracker in `auto-refresh.tsx`) genutzt, in Vitest getestet.

export const PASSIVE_COOKIE = "schulos_passiv";
export const PASSIVE_HEADER = "x-schulos-passiv";
/** Eine Eingabe so kurz vorher zählt noch als „die Person ist da“ – das Neuladen gilt dann als Aktivität */
export const RECENT_INPUT_MS = 60_000;

const hasPassiveCookie = (cookie: string) => cookie.split(";").some((c) => c.trim() === `${PASSIVE_COOKIE}=1`);

/** Server: automatisches Neuladen ohne Eingabe (Cookie oder Kopfzeile) und kein Seitenaufruf? Dann keine Aktivität. */
export function isPassiveRequest(headers: Headers): boolean {
  if (headers.get("sec-fetch-mode") === "navigate") return false;
  if (headers.get(PASSIVE_HEADER) === "1") return true;
  return hasPassiveCookie(headers.get("cookie") ?? "");
}

export interface ActivityTracker {
  /** echte Eingabe der Person: merken, Kennzeichen sofort löschen */
  input(): void;
  /** keine Eingabe in der letzten Minute */
  idle(): boolean;
  /** vor einem automatischen `router.refresh()`: ohne Eingabe Kennzeichen setzen */
  beforeAutomatic(): void;
  /** Kopfzeilen für eigene automatische `fetch`-Aufrufe (Herzschlag) */
  headers(): Record<string, string>;
}

/** Browser: Tracker über `document` (Cookie) und eine Uhr – in Tests mit Attrappen. Beginnt „aktiv“ (Seitenaufruf). */
export function activityTracker(doc: { cookie: string }, now: () => number = Date.now): ActivityTracker {
  let lastInput = now();
  const t: ActivityTracker = {
    input() {
      lastInput = now();
      if (hasPassiveCookie(doc.cookie)) doc.cookie = `${PASSIVE_COOKIE}=; path=/; max-age=0; samesite=lax`;
    },
    idle: () => now() - lastInput >= RECENT_INPUT_MS,
    beforeAutomatic() {
      if (t.idle()) doc.cookie = `${PASSIVE_COOKIE}=1; path=/; samesite=lax`;
    },
    headers: (): Record<string, string> => (t.idle() ? { [PASSIVE_HEADER]: "1" } : {}),
  };
  return t;
}
