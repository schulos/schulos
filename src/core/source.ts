// AGPL § 13 (Q-4E-31): Wer SchulOS als Netzdienst nutzt, bekommt den Quellcode angeboten – Link auf der Anmeldeseite und
// im Benutzermenü. Forks und veränderte Fassungen tragen ihr eigenes Repo in SCHULOS_SOURCE_URL ein (schulos.env).

export const DEFAULT_SOURCE_URL = "https://github.com/schulos/schulos";

export interface SourceInfo {
  /** Ziel des Links: eigenes Repo bzw. bei unveränderten Releases genau der Stand dieser Version */
  href: string;
  version: string;
}

/** Nur https-Adressen ohne Zugangsdaten – sonst die Vorgabe (ein kaputter Eintrag darf den Hinweis nicht verschwinden lassen). */
function validUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function sourceInfo(env: Record<string, string | undefined> = process.env): SourceInfo {
  const version = (env.SCHULOS_VERSION ?? "dev").replace(/[^A-Za-z0-9.+_-]/g, "").slice(0, 40) || "dev";
  const own = validUrl(env.SCHULOS_SOURCE_URL);
  if (own) return { href: own, version };
  // Release-Versionen zeigen auf ihren Tag, Entwicklungsstände auf das Repo
  const tagged = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/.test(version);
  return { href: tagged ? `${DEFAULT_SOURCE_URL}/tree/v${version}` : DEFAULT_SOURCE_URL, version };
}

/** Für die Shell: Ziel und fertige Beschriftung „Quellcode (AGPL) · <Version>“ */
export function sourceLink(env: Record<string, string | undefined> = process.env): { href: string; label: string } {
  const { href, version } = sourceInfo(env);
  return { href, label: `Quellcode (AGPL) · ${version}` };
}

/** Rollen, die „Problem melden“ sehen (Projektleitung 2026-10-16) – Schüler:innen und Eltern wenden sich an die Schule. */
export const ISSUE_ROLES = ["verwaltung", "admin"];

/**
 * „Problem melden“: öffnet ein vorausgefülltes Formular im Tracker des Projekts – nichts wird automatisch gesendet, kein
 * Token und keine Mailadresse im Code. Vorgabe: Fehler-Formular im öffentlichen Repo mit Version; eigene Fassungen tragen
 * ihren Tracker in SCHULOS_ISSUE_URL ein (nur https, wird unverändert verlinkt). `bereich` hängt die Shell an (issueHref).
 */
export function issueLink(env: Record<string, string | undefined> = process.env): { base: string; withArea: boolean } {
  const own = validUrl(env.SCHULOS_ISSUE_URL);
  if (own) return { base: own, withArea: false };
  const { version } = sourceInfo(env);
  return { base: `${DEFAULT_SOURCE_URL}/issues/new?template=fehler.yml&version=${encodeURIComponent(version)}`, withArea: true };
}

/**
 * Bereich für die Meldung aus dem Seitenpfad: höchstens zwei Segmente aus Kleinbuchstaben (z. B. „/stundenplan“,
 * „/verwaltung/benutzer“). Ab dem ersten Segment mit Ziffern, Punkt o. Ä. ist Schluss – das sind IDs und Namen
 * (z. B. „u-vorname.nachname“, „g-7b“), die nicht in ein öffentliches Formular gehören.
 */
export function issueArea(pathname: string): string {
  const parts: string[] = [];
  for (const seg of pathname.split("/").filter(Boolean)) {
    if (parts.length === 2 || !/^[a-z]+(?:-[a-z]+)*$/.test(seg)) break;
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

export function issueHref(link: { base: string; withArea: boolean }, pathname: string): string {
  return link.withArea ? `${link.base}&bereich=${encodeURIComponent(issueArea(pathname))}` : link.base;
}
