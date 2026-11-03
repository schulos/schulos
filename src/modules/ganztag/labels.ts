import type { GanztagExcused, GanztagMarkStatus, GanztagWayHome } from "@/core/db/schema";

/** Anzeige einer Zeile in Familien- und Klassenleitungsansicht */
export const MARK_LABEL: Record<GanztagMarkStatus, string> = { anwesend: "anwesend", fehlt: "gefehlt", verspaetet: "verspätet" };
export const MARK_TONE = { anwesend: "success", fehlt: "danger", verspaetet: "warn" } as const;
/** „entschuldigt?“ – Stand aus den Abwesenheiten (nur die Quelle, nie der Grund) */
export const EXCUSED_LABEL: Record<GanztagExcused, string> = { ja: "entschuldigt", nein: "nicht entschuldigt", offen: "ohne Meldung" };
/** GT-09: Heimweg – nur die Art der Regel, keine Namen Abholberechtigter */
export const WAY_LABEL: Record<GanztagWayHome, string> = { allein: "geht allein", abgeholt: "wird abgeholt", bus: "fährt mit dem Bus" };
