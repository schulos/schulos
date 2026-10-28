// „?“ in der Kopfzeile (HB-03): Ziel des Hilfe-Knopfs je aktueller Seite. Stufe 1 führt immer ins Handbuch; die Kontexthilfe
// (HB-07) trägt in CONTEXT_PAGES die Zuordnung erstes Pfadsegment (Modul) → Adresse der Handbuchseite ein. Rein und ohne DB,
// damit die Kopfzeile es im Browser nutzen kann.

/** HB-07: Modulpfad (z. B. "abwesenheiten") → Adresse einer Handbuchseite (`/hilfe/<adresse>`). */
export const CONTEXT_PAGES: Readonly<Record<string, string>> = {};

/** Ziel des „?“ für den aktuellen Pfad. */
export function helpHref(pathname: string, pages: Readonly<Record<string, string>> = CONTEXT_PAGES): string {
  const slug = pages[pathname.split("/")[1] ?? ""];
  return slug ? `/hilfe/${slug}` : "/hilfe";
}
