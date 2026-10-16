import { getSchoolSettings } from "@/core/settings";

/**
 * Setzt die Schulfarbe als --school; alle Akzent-Tokens leiten sich daraus ab (globals.css).
 * Zusätzlich auf :root, damit auch Portale (Dialoge, Menüs) außerhalb des Wrappers sie bekommen.
 * Die Farbe ist in getSchoolSettings auf #rrggbb validiert – kein CSS-Injection-Risiko.
 */
export async function SchoolTheme({ children, className }: { children: React.ReactNode; className?: string }) {
  const { color } = await getSchoolSettings();
  return (
    <div data-school className={className} style={{ "--school": color } as React.CSSProperties}>
      <style>{`:root{--school:${color}}`}</style>
      {children}
    </div>
  );
}
