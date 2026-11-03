// INV-01: Kategorien des Inventars als Vorlage – Daten, nicht Code (wie `pruefarten.ts`). Die ersten zehn Schlüssel sind die
// früheren Enum-Werte `gebaeude_asset_kind`; die Migration 0124 macht daraus Kategorien mit demselben Schlüssel, damit bestehende
// Anlagen und Prüfarten verlustfrei weiterlaufen. Prüfpflicht ist eine Eigenschaft der Kategorie (inv-1), die Prüfarten der
// Vorlage hängen über `categoryKey` daran. Abhängigkeitsfrei (auch für Client-Komponenten und die Migration).

export interface AssetCategoryTemplate {
  key: string;
  name: string;
  /** Präfix der automatischen Inventarnummer, 1–6 Zeichen A–Z/0–9 */
  prefix: string;
  /** Anlagen dieser Kategorie müssen erfasst werden (wiederkehrende Prüfungen) */
  inspectionRequired: boolean;
  sort: number;
}

/** Präfix: 1–6 Großbuchstaben/Ziffern. */
export const PREFIX_RE = /^[A-Z0-9]{1,6}$/;

export const ASSET_CATEGORY_TEMPLATE: readonly AssetCategoryTemplate[] = [
  // frühere Arten (P4-15) – Schlüssel bleiben
  { key: "elektro_ortsveraenderlich", name: "Elektrogerät (ortsveränderlich)", prefix: "EL", inspectionRequired: true, sort: 10 },
  { key: "feuerloescher", name: "Feuerlöscher", prefix: "FL", inspectionRequired: true, sort: 20 },
  { key: "spielgeraet", name: "Spielgerät (außen)", prefix: "SP", inspectionRequired: true, sort: 30 },
  { key: "sportgeraet", name: "Sport (Großgeräte, Zeitmessanlage)", prefix: "SG", inspectionRequired: true, sort: 40 },
  { key: "aufzug", name: "Aufzug", prefix: "AZ", inspectionRequired: true, sort: 50 },
  { key: "tor_tuer", name: "Kraftbetätigtes Tor/Tür", prefix: "TT", inspectionRequired: true, sort: 60 },
  { key: "leiter", name: "Leiter/Tritt", prefix: "LE", inspectionRequired: true, sort: 70 },
  { key: "erste_hilfe", name: "Erste-Hilfe-Material", prefix: "EH", inspectionRequired: true, sort: 80 },
  { key: "lueftung", name: "Lüftung", prefix: "LU", inspectionRequired: false, sort: 90 },
  { key: "sonstiges", name: "Sonstiges", prefix: "SO", inspectionRequired: false, sort: 900 },
  // neu mit dem Inventar (INV-01, Fragebogen Runde 12)
  { key: "it", name: "IT (Laptops, Tablets, PCs, Drucker, Server, Netzwerk, USV)", prefix: "IT", inspectionRequired: false, sort: 100 },
  { key: "praesentation", name: "Präsentation/AV (Beamer, Displays, Dokumentenkameras, Ton)", prefix: "AV", inspectionRequired: false, sort: 110 },
  { key: "sammlung", name: "Fachsammlungen (Mikroskope, Physik/Chemie/Bio, Messgeräte)", prefix: "FS", inspectionRequired: false, sort: 120 },
  { key: "werken", name: "Werken/Technik/Kunst (Maschinen, Brennofen)", prefix: "WK", inspectionRequired: true, sort: 130 },
  { key: "musik", name: "Musik (Instrumente, Verstärker)", prefix: "MU", inspectionRequired: false, sort: 140 },
  { key: "hauswirtschaft", name: "Hauswirtschaft/Mensa", prefix: "HW", inspectionRequired: false, sort: 150 },
  { key: "sicherheit", name: "Sicherheit (AED, Notbeleuchtung, Rauchmelder)", prefix: "SI", inspectionRequired: true, sort: 160 },
  { key: "hausmeisterei", name: "Hausmeisterei/Außen", prefix: "HM", inspectionRequired: false, sort: 170 },
  { key: "chemikalienschrank", name: "Chemikalienschrank (Verweis, kein Gefahrstoffkataster)", prefix: "CS", inspectionRequired: false, sort: 180 },
  { key: "moebel", name: "Möbel (Tafeln, Schränke; Tische/Stühle als Sammelposten)", prefix: "MO", inspectionRequired: false, sort: 190 },
  // GS-01: Fachraum-Anlagen (Chemie/Naturwissenschaften) – Prüfarten der Vorlage hängen daran (pruefarten.ts)
  { key: "abzug", name: "Laborabzug", prefix: "AB", inspectionRequired: true, sort: 182 },
  { key: "notdusche", name: "Augen-/Körpernotdusche", prefix: "ND", inspectionRequired: true, sort: 184 },
  { key: "sicherheitsschrank", name: "Sicherheitsschrank für Gefahrstoffe", prefix: "SSG", inspectionRequired: true, sort: 186 },
];

/** Kurzformen aus Inventarlisten des Schulträgers → Schlüssel (CSV-Import; die Namen der Kategorien gelten zusätzlich). */
export const CATEGORY_ALIASES: Record<string, string> = {
  elektro: "elektro_ortsveraenderlich",
  elektrogerät: "elektro_ortsveraenderlich",
  "elektrogerät (ortsveränderlich)": "elektro_ortsveraenderlich",
  feuerlöscher: "feuerloescher",
  spielgerät: "spielgeraet",
  sportgerät: "sportgeraet",
  sport: "sportgeraet",
  tor: "tor_tuer",
  tür: "tor_tuer",
  leiter: "leiter",
  tritt: "leiter",
  "erste hilfe": "erste_hilfe",
  "erste-hilfe": "erste_hilfe",
  verbandkasten: "erste_hilfe",
  "it/medien": "it",
  edv: "it",
  laptop: "it",
  tablet: "it",
  beamer: "praesentation",
  av: "praesentation",
  sammlung: "sammlung",
  fachsammlung: "sammlung",
  werkraum: "werken",
  instrument: "musik",
  mensa: "hauswirtschaft",
  küche: "hauswirtschaft",
  möbel: "moebel",
  mobiliar: "moebel",
  laborabzug: "abzug",
  digestorium: "abzug",
  augendusche: "notdusche",
  körperdusche: "notdusche",
  notdusche: "notdusche",
  gefahrstoffschrank: "sicherheitsschrank",
  sicherheitsschrank: "sicherheitsschrank",
};

/**
 * Rein: Kategorie aus Schlüssel, Name (ganz oder bis zur Klammer), Präfix oder Kurzform – Groß-/Kleinschreibung egal.
 * Arbeitet auf der Liste aus der Datenbank, damit eigene Kategorien der Schule mitzählen.
 */
export function matchCategory<T extends { key: string; name: string; prefix: string }>(raw: string, categories: readonly T[]): T | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const short = (n: string) => n.toLowerCase().replace(/\s*\(.*\)\s*$/, "");
  return (
    categories.find((c) => c.key === v) ??
    categories.find((c) => c.name.toLowerCase() === v || short(c.name) === v) ??
    categories.find((c) => c.prefix.toLowerCase() === v) ??
    (CATEGORY_ALIASES[v] ? (categories.find((c) => c.key === CATEGORY_ALIASES[v]) ?? null) : null)
  );
}

/** Rein: Schlüssel einer eigenen Kategorie aus dem Namen („Robotik-Koffer“ → „robotik-koffer“). */
export function categoryKeyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
