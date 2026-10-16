import type { MetadataRoute } from "next";
import { logoUrl } from "@/core/school/logo-meta";
import { getSchoolSettings } from "@/core/settings";

export const dynamic = "force-dynamic";

/**
 * Web-App-Manifest (P4-73): Name und Farbe der Schule, Symbol aus dem Schullogo (P4-04) bzw. das SchulOS-Symbol. Ohne
 * Anmeldung abrufbar (Browser laden das Manifest ohne Cookies) – enthält nur Angaben, die auch die Anmeldeseite zeigt.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let school: Awaited<ReturnType<typeof getSchoolSettings>> | null = null;
  try {
    school = await getSchoolSettings();
  } catch {
    // Datenbank nicht erreichbar: Manifest mit Vorgaben
  }
  const name = school && school.name !== "SchulOS" ? `SchulOS · ${school.name}` : "SchulOS";
  const symbol = school?.logos.symbol;
  const icons: MetadataRoute.Manifest["icons"] = [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }];
  if (symbol)
    icons.unshift({
      src: logoUrl("symbol", symbol),
      type: symbol.mime,
      sizes: symbol.mime === "image/svg+xml" ? "any" : `${symbol.width}x${symbol.height}`,
      purpose: "any",
    });
  return {
    id: "/",
    name,
    short_name: "SchulOS",
    description: "Das Betriebssystem für die Schule",
    lang: "de",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f5f7",
    theme_color: school?.color ?? "#0e7c66",
    icons,
  };
}
