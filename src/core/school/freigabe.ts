// Freigabe je Bundesland (Entscheidung 2026-10-04, QUESTIONS.md): Rechtsgrundlagen, Datenschutzhinweise und VVT
// sind als Vorlage nur für NRW ausgearbeitet (DS-14: keine rechtliche Prüfung – die prüft die Schule). Andere Länder bleiben wählbar (Ferien, Schulformen), werden aber deutlich markiert.
import { STATES, type StateCode } from "./catalog";

export const RELEASED_STATES: readonly StateCode[] = ["NW"];

export function isReleasedState(state: string): boolean {
  return (RELEASED_STATES as readonly string[]).includes(state);
}

/** Hinweis für nicht freigegebene Länder, sonst null. */
export function releaseNote(state: string): string | null {
  if (isReleasedState(state)) return null;
  const name = STATES.find((s) => s.code === state)?.name ?? state;
  return `SchulOS ist derzeit nur für Schulen in Nordrhein-Westfalen freigegeben. Für ${name} sind die Vorlagen für Rechtsgrundlagen, Datenschutzhinweise und Verzeichnis der Verarbeitungstätigkeiten nicht ausgearbeitet – vor dem Einsatz mit echten Daten mit der bzw. dem Datenschutzbeauftragten klären.`;
}
