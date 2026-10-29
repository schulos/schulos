// „?“ in der Kopfzeile (HB-03, HB-07): Ziel des Hilfe-Knopfs je aktueller Seite. Kontexthilfe: erstes Pfadsegment (Modul) → Adresse
// der passenden Handbuchseite. Fehlt die Zuordnung oder darf die Person die Seite nicht sehen (Zielgruppe, Entwurf, gelöscht),
// führt der Knopf ins Handbuch. Rein und ohne DB, damit die Kopfzeile es im Browser nutzen kann.
import type { Role } from "@/core/roles";

/** Modulpfad (z. B. "abwesenheiten") → Adresse einer Starter-Seite (`/hilfe/<adresse>`), für alle Rollen gleich. */
export const CONTEXT_PAGES: Readonly<Record<string, string>> = {
  abwesenheiten: "krankmeldung",
  kurswahl: "kurswahl",
  konto: "zwei-faktor-anmeldung-einrichten",
};

/** „Erste Schritte“ je Rolle – Ziel auf der Startseite und in den Alltagsmodulen. */
export const FIRST_STEPS: Readonly<Partial<Record<Role, string>>> = {
  eltern: "erste-schritte-fuer-eltern",
  schueler: "erste-schritte-fuer-schuelerinnen-und-schueler",
  lehrkraft: "erste-schritte-fuer-lehrkraefte-und-personal",
  personal: "erste-schritte-fuer-lehrkraefte-und-personal",
  beratung: "erste-schritte-fuer-lehrkraefte-und-personal",
  verwaltung: "erste-schritte-fuer-lehrkraefte-und-personal",
};

/** Pfade (erstes Segment), auf denen „?“ die Seite „Erste Schritte“ der Rolle öffnet. Die Startseite führt ins Handbuch selbst. */
export const FIRST_STEPS_PATHS = ["news", "kalender", "stundenplan", "messenger", "elternbriefe", "sprechtag"] as const;

/** Zuordnung Modulpfad → Adresse für eine Rolle. */
export function contextPagesFor(role: Role): Record<string, string> {
  const first = FIRST_STEPS[role];
  return { ...Object.fromEntries(first ? FIRST_STEPS_PATHS.map((p) => [p, first]) : []), ...CONTEXT_PAGES };
}

/** Ziel des „?“ für den aktuellen Pfad. */
export function helpHref(pathname: string, pages: Readonly<Record<string, string>> = CONTEXT_PAGES): string {
  const slug = pages[pathname.split("/")[1] ?? ""];
  return slug ? `/hilfe/${slug}` : "/hilfe";
}
