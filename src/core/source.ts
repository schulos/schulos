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
