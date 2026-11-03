import { dayOptions, defineSetting } from "@/core/modules/settings";

/**
 * DS-15: Karenz zwischen Abgang und Löschung eines Kontos (LK-KONTO, `ACCOUNT_GRACE_DAYS` als Vorgabe). Kürzer als 30 Tage
 * nicht (Eigenexport, Rückfragen), länger als ein Jahr nicht (Grenze der Löschklasse).
 */
export const ACCOUNT_GRACE = defineSetting({
  key: "verwaltung.account_grace",
  label: "Konten nach dem Abgang löschen",
  help: "Bis dahin ist das Konto gesperrt; Eigenexport und Rückfragen bleiben möglich. Löschsperren und die Klassenbuch-Akte gehen vor.",
  options: dayOptions([30, 90, 180, 365], 90),
  default: "90",
  permission: "verwaltung.privacy",
});

/**
 * RS-02/RS-03 (Projektleitung 2026-10-28): Schüler:innen und Eltern sehen im Raumsteckbrief die Belegung nur als frei/belegt –
 * ohne Klasse, Fach oder Lehrkraft. Die Schule kann die Belegung für sie auch ganz ausblenden.
 */
export const ROOM_OCCUPANCY_FAMILY = defineSetting({
  key: "verwaltung.room_occupancy_family",
  label: "Raumsteckbrief: Belegung für Schüler:innen und Eltern",
  help: "Beschäftigte sehen die Belegung immer mit Klasse und Lehrkraft; Schüler:innen und Eltern höchstens „frei“ oder „belegt“.",
  options: [
    { value: "frei_belegt", label: "nur frei/belegt (Vorgabe)" },
    { value: "aus", label: "nicht zeigen" },
  ],
  default: "frei_belegt",
});

/**
 * RS-13 (Projektleitung 2026-11-03): Grundrisse der Etagen sehen alle Angemeldeten; die Schule kann sie auf Beschäftigte
 * beschränken (z. B. wenn der Plan mehr zeigt, als Schüler:innen und Eltern wissen müssen).
 */
export const FLOOR_PLAN_VISIBILITY = defineSetting({
  key: "verwaltung.floor_plan_visibility",
  label: "Grundriss je Etage: wer sieht ihn",
  help: "Der Grundriss zeigt, wo ein Raum liegt (Raumfinder, „Lage“ im Raumsteckbrief). Die Raumliste bleibt für alle sichtbar.",
  options: [
    { value: "alle", label: "alle Angemeldeten (Vorgabe)" },
    { value: "personal", label: "nur Personal" },
  ],
  default: "alle",
});

export const VERWALTUNG_SETTINGS = [ACCOUNT_GRACE, ROOM_OCCUPANCY_FAMILY, FLOOR_PLAN_VISIBILITY];
