import { defineSetting, gradeOptions } from "@/core/modules/settings";

/**
 * P5-14 (F5-06): Noten für Schüler:innen sichtbar – Vorgabe aus. „Halbjahresnoten“ zeigt die festgelegte Note erst, wenn das
 * Buch abgeschlossen ist; „Teilnoten“ zusätzlich die eingetragenen Teilnoten mit Titel und Datum. Nie Kommentare, nie der
 * berechnete Vorschlag (Q-5A-15).
 */
export const STUDENT_VIEW = defineSetting({
  key: "notenbuch.student_view",
  label: "Noten für Schüler:innen sichtbar",
  help: "Schüler:innen sehen nur ihre eigenen Noten – Halbjahresnoten erst nach dem Abschluss des Notenbuchs, nie Kommentare oder den berechneten Vorschlag.",
  options: [
    { value: "aus", label: "aus" },
    { value: "halbjahr", label: "nur Halbjahresnoten (nach dem Abschluss)" },
    { value: "teilnoten", label: "Halbjahresnoten und Teilnoten" },
  ],
  default: "aus",
});

/**
 * P5-14: Eltern sehen dasselbe wie ihr Kind (Umfang aus `STUDENT_VIEW`), nur bis zum gewählten Jahrgang (Sek I) – Vorgabe aus.
 * Bei eigenständigen (volljährigen) Schüler:innen nur mit deren Einwilligung „Eltern weiter informieren“.
 */
export const PARENTS_VIEW = defineSetting({
  key: "notenbuch.parents_view",
  label: "Noten für Eltern sichtbar",
  help: "Eltern sehen dasselbe wie ihr Kind (nur wenn die Noten für Schüler:innen sichtbar sind) – bis zum gewählten Jahrgang, nie in der Oberstufe; bei eigenständigen Schüler:innen nur mit deren Einwilligung.",
  options: gradeOptions(5, 10),
  default: "0",
});

/**
 * P5-20 (F5-15): Offline-Eingabe nur auf Dienstgeräten (§ 2 Abs. 1 VO-DV I). Vorgabe `zertifikat`: nur Geräte mit gültigem
 * Gerätezertifikat der Schule (P4-40b) – der einzige Nachweis, den SchulOS für „dienstlich“ hat; ohne Schul-CA gibt es damit
 * keine Offline-Eingabe (wie bisher, kein neues Risiko). `schulnetz` lässt zusätzlich Geräte im Schulnetz zu – dort kann SchulOS
 * private von dienstlichen Geräten nicht unterscheiden, deshalb bestätigt die Lehrkraft beim Einschalten je Gerät, dass es ein
 * Dienstgerät ist (Dienstanweisung, Q-5A-24). Auf Privatgeräten von außen nie.
 */
export const OFFLINE = defineSetting({
  key: "notenbuch.offline",
  label: "Offline-Eingabe auf Dienstgeräten",
  help: "Teilnoten lassen sich ohne Verbindung eintragen und später abgleichen – verschlüsselter Zwischenspeicher nur auf Dienstgeräten, nie auf Privatgeräten von außen. „Schulnetz“ verlangt je Gerät die Bestätigung, dass es ein Dienstgerät ist.",
  options: [
    { value: "aus", label: "aus" },
    { value: "zertifikat", label: "nur Geräte mit Gerätezertifikat der Schule" },
    { value: "schulnetz", label: "Gerätezertifikat oder Schulnetz (mit Bestätigung je Gerät)" },
  ],
  default: "zertifikat",
});

export type OfflineMode = (typeof OFFLINE.options)[number]["value"];

/**
 * Q-5A-1 (Projektleitung 2026-10-14: Einstellung je Schule): Rundung des Halbjahresvorschlags genau auf der Grenze x,5 – Vorgabe
 * „zugunsten der Schüler:in“ (2,5 → 2), sonst „kaufmännisch“ (2,5 → 3). Nur der Vorschlag; festlegen tut die Lehrkraft.
 * Ändern berechnet die Vorschläge aller offenen Bücher neu.
 */
export const ROUNDING = defineSetting({
  key: "notenbuch.rounding",
  label: "Rundung des Halbjahresvorschlags auf der Grenze (x,5)",
  help: "Nur für den berechneten Vorschlag – die Halbjahresnote legt die Lehrkraft selbst fest. Bei 15 Punkten gilt in beiden Fällen: 10,5 → 11.",
  options: [
    { value: "schueler", label: "zugunsten der Schüler:in (2,5 → 2)" },
    { value: "kaufmaennisch", label: "kaufmännisch (2,5 → 3)" },
  ],
  default: "schueler",
  onChange: async (db) => {
    const { recomputeOpenBooks } = await import("./service");
    await recomputeOpenBooks(db);
  },
});

export const NOTENBUCH_SETTINGS = [STUDENT_VIEW, PARENTS_VIEW, OFFLINE, ROUNDING];
