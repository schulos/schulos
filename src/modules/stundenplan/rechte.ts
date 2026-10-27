// SP-02 (docs/STUNDENPLAN-UMBAU.md §2.1/2.2): zwei Planungsrechte und die Funktionsgruppe „Stundenplanung“.
// Ohne DB-Zugriff, damit Seed, Rechte-Seite und Tests dieselben Namen nutzen.

/** Jahresplanung: Pflege, Unterrichtsverteilung, Deputate, Zeitwünsche, Aufsichtsplan, Solver, Kurswahl-Übernahme */
export const PLAN_MANAGE = "stundenplan.manage";
/** Tagesgeschäft: Vertretungen, Abwesenheiten, Vorschläge, Veröffentlichen, Raumsperren, Aufsichtsvertretung, „Offen für dich“ */
export const PLAN_SUBSTITUTE = "stundenplan.substitute";

/** Funktionsgruppe, die Migration 0088 anlegt (feste ID, Slug `stundenplanung`, Art `gremium`, ohne Mitglieder) */
export const PLANNING_GROUP = {
  id: "g-stundenplanung",
  slug: "stundenplanung",
  name: "Stundenplanung",
  description: "Funktionsgruppe: Stundenplan planen und Vertretungen planen",
} as const;

/** SP2-12: Fachbedarf und Prognose lesen – nur Summen je Fach, keine Namen (Schulleitung); Details und Pflege nur mit `manage` */
export const PLAN_FORECAST = "stundenplan.forecast_view";

/**
 * SP3-03 (F-10-3): Planentwurf prüfen und freigeben (Schulleitung). Liest Versionen ab Status „in Prüfung“, kommentiert, gibt frei oder
 * zurück an die Planung. Kein Vier-Augen-Zwang: wer auch `manage` hat, darf den eigenen Entwurf freigeben (das Audit vermerkt es).
 */
export const PLAN_REVIEW = "stundenplan.review";

/** SP-05 (Projektleitung 2026-10-19): Kurswahlen lesen, um daraus Lehraufträge anzulegen (Recht des Moduls `kurswahl`) */
export const KURSWAHL_VIEW = "kurswahl.view";

/** Rechte der Funktionsgruppe (Migration 0088: die beiden Planungsrechte, Migration 0092 ff.: Kurswahl lesen) */
export const PLANNING_GROUP_PERMISSIONS = [PLAN_MANAGE, PLAN_SUBSTITUTE, KURSWAHL_VIEW] as const;
