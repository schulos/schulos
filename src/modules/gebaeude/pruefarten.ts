// Vorlage der Prüfarten (P4-15, Q-23): zwölf typische wiederkehrende Prüfungen an Schulen, seit GS-01 dazu sieben Fachraum-Prüfungen – als Daten, nicht als Code.
// Intervalle sind Annahmen, Quellen Hinweise. Alles ist „zu prüfen“: SchulOS behauptet keine Rechtsverbindlichkeit,
// die Schule bzw. der Schulträger legt die Fristen fest (Fachkraft für Arbeitssicherheit, Gefährdungsbeurteilung).
import type { InspectionResponsible, InspectionTarget } from "./labels";

export interface InspectionTemplate {
  key: string;
  name: string;
  appliesTo: InspectionTarget;
  /** Prüfungen für alle Anlagen dieser Kategorie automatisch planen (Schlüssel aus `kategorien.ts`, INV-01) */
  categoryKey: string | null;
  intervalMonths: number;
  warnDays: number;
  source: string;
  responsible: InspectionResponsible;
  note: string | null;
}

/** Hinweis an jeder Quelle der Vorlage. */
export const TEMPLATE_DISCLAIMER = "zu prüfen";

const src = (s: string) => `${s} – ${TEMPLATE_DISCLAIMER}`;

export const INSPECTION_TEMPLATE: readonly InspectionTemplate[] = [
  {
    key: "elektro-ortsveraenderlich",
    name: "Ortsveränderliche elektrische Betriebsmittel",
    appliesTo: "anlage",
    categoryKey: "elektro_ortsveraenderlich",
    intervalMonths: 24,
    warnDays: 30,
    source: src("DGUV Vorschrift 3, DGUV Information 203-071, TRBS 1201"),
    responsible: "extern",
    note: "Annahme 12–24 Monate: Schule meist 24, Werk- und Fachräume eher 12",
  },
  {
    key: "elektro-ortsfest",
    name: "Ortsfeste elektrische Anlagen",
    appliesTo: "gebaeude",
    categoryKey: null,
    intervalMonths: 48,
    warnDays: 60,
    source: src("DGUV Vorschrift 3"),
    responsible: "schultraeger",
    note: null,
  },
  {
    key: "feuerloescher",
    name: "Feuerlöscher",
    appliesTo: "anlage",
    categoryKey: "feuerloescher",
    intervalMonths: 24,
    warnDays: 30,
    source: src("DIN 14406-4, ASR A2.2"),
    responsible: "extern",
    note: null,
  },
  {
    key: "brandschutz-technik",
    name: "Brandmeldeanlage, Rauchwarnmelder, Sicherheitsbeleuchtung",
    appliesTo: "gebaeude",
    categoryKey: null,
    intervalMonths: 12,
    warnDays: 30,
    source: src("DIN 14675, DIN VDE 0833, ASR A3.4/7"),
    responsible: "schultraeger",
    note: "zusätzlich monatliche Sichtprüfung (Annahme)",
  },
  {
    key: "spielgeraete",
    name: "Spielplatz- und Außenspielgeräte (Hauptinspektion)",
    appliesTo: "anlage",
    categoryKey: "spielgeraet",
    intervalMonths: 12,
    warnDays: 30,
    source: src("DIN EN 1176-7, DGUV Information 202-022"),
    responsible: "schultraeger",
    note: "operative Inspektion alle 1–3 Monate, Sichtkontrolle wöchentlich durch die Hausmeisterei (Annahme)",
  },
  {
    key: "sportgeraete",
    name: "Sportgeräte und Sporthallen",
    appliesTo: "anlage",
    categoryKey: "sportgeraet",
    intervalMonths: 12,
    warnDays: 30,
    source: src("DGUV Information 202-048 („Sichere Schule – Sporthalle“)"),
    responsible: "schultraeger",
    note: null,
  },
  {
    key: "tore-tueren",
    name: "Kraftbetätigte Tore und Türen",
    appliesTo: "anlage",
    categoryKey: "tor_tuer",
    intervalMonths: 12,
    warnDays: 30,
    source: src("ASR A1.7"),
    responsible: "schultraeger",
    note: null,
  },
  {
    key: "leitern",
    name: "Leitern und Tritte",
    appliesTo: "anlage",
    categoryKey: "leiter",
    intervalMonths: 12,
    warnDays: 30,
    source: src("DGUV Information 208-016"),
    responsible: "schule",
    note: "Prüfung durch die Hausmeisterei (Annahme)",
  },
  {
    key: "erste-hilfe",
    name: "Erste-Hilfe-Material",
    appliesTo: "anlage",
    categoryKey: "erste_hilfe",
    intervalMonths: 12,
    warnDays: 30,
    source: src("DGUV Vorschrift 1, DIN 13157/13169"),
    responsible: "schule",
    note: "Verfallsdaten beachten; Sicherheitsbeauftragte (Annahme)",
  },
  {
    key: "trinkwasser",
    name: "Trinkwasser (Legionellen)",
    appliesTo: "gebaeude",
    categoryKey: null,
    intervalMonths: 36,
    warnDays: 60,
    source: src("§ 31 TrinkwV"),
    responsible: "schultraeger",
    note: "bei Großanlagen zur Trinkwassererwärmung in öffentlichen Gebäuden (Annahme)",
  },
  {
    key: "aufzuege",
    name: "Aufzüge",
    appliesTo: "anlage",
    categoryKey: "aufzug",
    intervalMonths: 12,
    warnDays: 30,
    source: src("BetrSichV"),
    responsible: "extern",
    note: "Hauptprüfung und Zwischenprüfung durch eine zugelassene Überwachungsstelle im Wechsel (Annahme)",
  },
  {
    key: "begehung-arbeitsschutz",
    name: "Begehung Arbeitsschutz / Gefährdungsbeurteilung",
    appliesTo: "gebaeude",
    categoryKey: null,
    intervalMonths: 12,
    warnDays: 30,
    source: src("ArbSchG § 5, DGUV Vorschrift 1"),
    responsible: "schule",
    note: "Schulleitung",
  },
  // GS-01 (Runde 13, Projektleitung 2026-11-02): Fachraum-Prüfungen Chemie/Naturwissenschaften und Strahlenschutz Physik;
  // Biologie (Biostoffe) später. Wie oben alles „zu prüfen“ und ausgeschaltet; die zuständige Gruppe (z. B. Fachschaft Chemie)
  // trägt die Schule unter Prüfarten ein (GS-02). Kein Chemikalienkataster – nur die Frist „Verzeichnis aktualisiert“ mit PDF.
  {
    key: "laborabzuege",
    name: "Laborabzüge (Fachraum)",
    appliesTo: "anlage",
    categoryKey: "abzug",
    intervalMonths: 12,
    warnDays: 30,
    source: src("DIN EN 14175, DGUV Regel 113-018, RISU-NRW"),
    responsible: "extern",
    note: "Funktion und Luftführung durch eine Fachfirma; arbeitstäglich Sichtkontrolle der Strömungsanzeige (Annahme)",
  },
  {
    key: "notduschen",
    name: "Augen- und Körpernotduschen (Funktionsprobe)",
    appliesTo: "anlage",
    categoryKey: "notdusche",
    intervalMonths: 1,
    warnDays: 7,
    source: src("DIN EN 15154, DGUV Regel 113-018, RISU-NRW"),
    responsible: "schule",
    note: "monatlich auslösen und durchspülen (Annahme); jährliche Prüfung je nach Gefährdungsbeurteilung",
  },
  {
    key: "sicherheitsschraenke",
    name: "Sicherheitsschränke für Gefahrstoffe",
    appliesTo: "anlage",
    categoryKey: "sicherheitsschrank",
    intervalMonths: 12,
    warnDays: 30,
    source: src("DIN EN 14470-1, TRGS 510, DGUV Regel 113-018"),
    responsible: "extern",
    note: "Selbstschließung, Türfeststeller und Abluft durch eine Fachfirma (Annahme)",
  },
  {
    key: "gasversorgung-not-aus",
    name: "Gasversorgung und Not-Aus im Fachraum",
    appliesTo: "raum",
    categoryKey: null,
    intervalMonths: 12,
    warnDays: 30,
    source: src("DGUV Regel 113-018, RISU-NRW, DGUV Vorschrift 3"),
    responsible: "schule",
    note: "Funktionsprobe Not-Aus und Gasabsperrung je Fachraum; Leitungsprüfung durch den Schulträger (Annahme)",
  },
  {
    key: "gefahrstoffverzeichnis",
    name: "Gefahrstoffverzeichnis aktualisieren und Bestand aussondern",
    appliesTo: "gebaeude",
    categoryKey: null,
    intervalMonths: 12,
    warnDays: 30,
    source: src("GefStoffV § 6 Abs. 12, RISU-NRW"),
    responsible: "schule",
    note: "Verzeichnis als PDF-Protokoll anhängen; SchulOS führt kein Chemikalienkataster",
  },
  {
    key: "gefaehrdungsbeurteilung-fachraum",
    name: "Gefährdungsbeurteilungen Fachraum überprüfen",
    appliesTo: "raum",
    categoryKey: null,
    intervalMonths: 12,
    warnDays: 30,
    source: src("GefStoffV § 6, ArbSchG § 5, RISU-NRW"),
    responsible: "schule",
    note: "Tätigkeiten und Versuche mit Gefahrstoffen; Betriebsanweisungen auf Stand (Annahme)",
  },
  {
    key: "strahlenschutz-dichtheit",
    name: "Strahlenschutz: Dichtheitsprüfung radioaktiver Präparate",
    appliesTo: "raum",
    categoryKey: null,
    intervalMonths: 12,
    warnDays: 60,
    source: src("StrlSchV, RISU-NRW"),
    responsible: "extern",
    note: "nur wenn die Schule umschlossene radioaktive Stoffe besitzt; Raum der Physiksammlung, Strahlenschutzbeauftragte:r (Annahme)",
  },
];

/** GS-01: Schlüssel der Fachraum-Prüfarten (Chemie/NW, Strahlenschutz Physik) – Gruppierung in der Oberfläche und im Handbuch. */
export const FACHRAUM_TEMPLATE_KEYS: readonly string[] = [
  "laborabzuege",
  "notduschen",
  "sicherheitsschraenke",
  "gasversorgung-not-aus",
  "gefahrstoffverzeichnis",
  "gefaehrdungsbeurteilung-fachraum",
  "strahlenschutz-dichtheit",
];
