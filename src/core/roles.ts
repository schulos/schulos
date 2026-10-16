// Abhängigkeitsfrei, damit auch Client-Komponenten die Rollen importieren können
// (das DB-Schema würde Drizzle ins Browser-Bundle ziehen).
// `personal` (P4-10, Q-20): weiteres Personal – Hausmeisterei, Schulsozialarbeit, IT des Schulträgers, Mensa. Minimale
// Vorgaben, Fachrechte kommen über Gruppen (z. B. „Hausmeisterei“ → gebaeude.manage); sieht keine Schüler-/Elterndaten.
// `beratung` (Q5-17, F-05): Schulsozialarbeit/Beratung – für Schüler:innen und Eltern im Adressbuch sichtbar (mit Sprechzeiten),
// sieht selbst nur Erwachsene der Schule, Mitglieder eigener Gruppen und Personen mit bestehendem Chat; keine Fallakte.
export const ROLES = ["schueler", "lehrkraft", "eltern", "personal", "beratung", "verwaltung", "admin"] as const;
export type Role = (typeof ROLES)[number];
