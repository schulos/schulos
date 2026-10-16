// Ziel nach der Anmeldung (`?next=`) – gemeinsam für SchulOS und SchulOS Backup (SEC-04).

const ORIGIN = "http://schulos.invalid";

/**
 * Nur Pfade auf derselben Seite: beginnt mit genau einem `/`, kein `//` oder `/\` (Browser lösen `\` wie `/` auf →
 * `https://fremd.example`), keine Steuer- oder Leerzeichen (`/\t/x` wird beim Parsen zu `//x`). Zur Sicherheit wird das
 * Ziel zusätzlich gegen einen Platzhalter-Ursprung aufgelöst – landet es woanders, geht es auf die Startseite.
 */
export function safeNext(next: unknown): string {
  const n = typeof next === "string" ? next : "";
  // eslint-disable-next-line no-control-regex
  if (!n.startsWith("/") || n.startsWith("//") || n.startsWith("/\\") || /[\u0000- \u007f-\u009f\\]/.test(n)) return "/";
  let url: URL;
  try {
    url = new URL(n, ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== ORIGIN) return "/";
  const out = url.pathname + url.search + url.hash;
  // kodierte Schrägstriche am Anfang (`/%2F…`) entschärfen die Browser nicht in jedem Fall – lieber gar nicht erst zulassen
  return out.startsWith("//") || /^\/%(2f|5c)/i.test(out) ? "/" : out;
}
