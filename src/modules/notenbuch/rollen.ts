// GATE-5a (Schülerzugriff): Schüler:innen und Eltern bekommen **nie** ein Notenbuch-Recht – auch nicht, wenn ein Admin es der
// Rolle oder einer Gruppe gibt, in der sie Mitglied sind. Einzige Ausnahme ist die Schüler-/Elternsicht (P5-14, einsicht.ts):
// nur die eigenen Noten bzw. die der Kinder, lesend, nach Moduleinstellung (Vorgabe aus). Abhängigkeitsfrei (Manifest, Rechte).
import { ROLES, type Role } from "@/core/roles";

/** Rollen ohne jedes Notenbuch-Recht (Notentabelle, Bücher, Übergabeliste, Export, Übertragen, Entsperren, Auskunft). */
export const FAMILY_ROLES = [
  "schueler",
  "eltern",
] as const satisfies readonly Role[];

/** Schüler:in oder Elternteil? */
export function isFamilyRole(role: Role): boolean {
  return (FAMILY_ROLES as readonly Role[]).includes(role);
}

/** Rollen, für die der Navigationseintrag „Notenbuch“ (Arbeitsbereich der Lehrkräfte) überhaupt in Frage kommt. */
export const NOTENBUCH_ROLES: Role[] = ROLES.filter((r) => !isFamilyRole(r));

/** Deckt dieses Grant-Muster ein Notenbuch-Recht ab? (`notenbuch.<recht>`, `notenbuch.*` oder `*`) */
export function coversNotenbuchRight(permission: string): boolean {
  return permission === "*" || permission.startsWith("notenbuch.");
}
