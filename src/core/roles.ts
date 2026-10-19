// Abhängigkeitsfrei, damit auch Client-Komponenten die Rollen importieren können
// (das DB-Schema würde Drizzle ins Browser-Bundle ziehen).
// `personal` (P4-10, Q-20): weiteres Personal – Hausmeisterei, Schulsozialarbeit, IT des Schulträgers, Mensa. Minimale
// Vorgaben, Fachrechte kommen über Gruppen (z. B. „Hausmeisterei“ → gebaeude.manage); sieht keine Schüler-/Elterndaten.
// `beratung` (Q5-17, F-05): Schulsozialarbeit/Beratung – für Schüler:innen und Eltern im Adressbuch sichtbar (mit Sprechzeiten),
// sieht selbst nur Erwachsene der Schule, Mitglieder eigener Gruppen und Personen mit bestehendem Chat; keine Fallakte.
export const ROLES = ["schueler", "lehrkraft", "eltern", "personal", "beratung", "verwaltung", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * SP-05 (FEINSCHLIFF L-01): Beschäftigte der Schule – alle außer Schüler:innen und Eltern. Sie sehen Stundenpläne aller Klassen,
 * Lehrkräfte und Räume sowie die Raumbelegung (keine Schüler- oder Elterndaten). Ersetzt die verstreuten `STAFF`-Listen
 * `["lehrkraft","verwaltung","admin"]` im Stundenplan-Umfeld, an denen Personal und Beratung mit 404 scheiterten.
 */
export const STAFF_ROLES = ["lehrkraft", "personal", "beratung", "verwaltung", "admin"] as const satisfies readonly Role[];

export function isStaffRole(role: string): boolean {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * Rollen, die unterrichten bzw. Unterricht verwalten (Klassenbuch, Lehrkraft-Pläne). Personal und Beratung bewusst nicht:
 * das Klassenbuch enthält Schülerdaten (Fehlzeiten, Bemerkungen).
 */
export const TEACHING_ROLES = ["lehrkraft", "verwaltung", "admin"] as const satisfies readonly Role[];

export function isTeachingRole(role: string): boolean {
  return (TEACHING_ROLES as readonly string[]).includes(role);
}
