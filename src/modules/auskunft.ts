// Lesbare Zusatzteile der Auskunft (Art. 15 DSGVO, core/privacy/auskunft.ts): Module, deren Rohdaten nur Kennungen enthalten
// (z. B. Teilnoten mit Spalten-ID), liefern hier eine verständliche Zusammenstellung. Neue Module tragen sich hier ein.
import type { Db } from "@/core/db/client";
import type { PermissionSet } from "@/core/permissions";
import { buechereiAuskunft } from "./buecherei/auskunft";
import { notenbuchAuskunft } from "./notenbuch/auskunft";

export interface ReadableSection {
  /** Dateiname im ZIP (`daten/<modul>/<table>.json`) */
  table: string;
  purpose: string;
  categories: string[];
  rows: Record<string, unknown>[];
}

/**
 * GATE-5a (G5A-S01): Teile, die nur eine **ausdrücklich berechtigte** erzeugende Person in die Auskunft geben darf (z. B. Noten
 * aus dem Notenbuch – kein Admin-Override über `verwaltung.privacy`). Fehlt das Recht, enthält die Auskunft stattdessen
 * `note`; ist es da, steht ein Lesevermerk (`readAction`) im Protokoll.
 */
export interface RestrictedPart {
  /** Rohdaten-Tabellen, deren eigene Zeilen der Person nur mit Berechtigung hineingehen (Handlungen bleiben) */
  tables: string[];
  /** lesbare Abschnitte (`ReadableSection.table`), die nur mit Berechtigung hineingehen */
  sections: string[];
  /** darf die erzeugende Person den Teil erteilen? */
  allowed: (perms: PermissionSet) => boolean;
  /** Hinweis in der Auskunft, wenn der Teil fehlt */
  note: string;
  readAction: `lesen.${string}`;
}

export interface ReadableExport {
  moduleId: string;
  build: (db: Db, userId: string) => Promise<ReadableSection[]>;
  restricted?: RestrictedPart;
}

export const READABLE_EXPORTS: readonly ReadableExport[] = [notenbuchAuskunft, buechereiAuskunft];
