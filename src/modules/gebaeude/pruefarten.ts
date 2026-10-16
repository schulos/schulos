// Vorlage der Prüfarten (P4-15, Q-23): zwölf typische wiederkehrende Prüfungen an Schulen – als Daten, nicht als Code.
// Intervalle sind Annahmen, Quellen Hinweise. Alles ist „zu prüfen“: SchulOS behauptet keine Rechtsverbindlichkeit,
// die Schule bzw. der Schulträger legt die Fristen fest (Fachkraft für Arbeitssicherheit, Gefährdungsbeurteilung).
import type { AssetKind, InspectionResponsible, InspectionTarget } from "./labels";

export interface InspectionTemplate {
  key: string;
  name: string;
  appliesTo: InspectionTarget;
  /** Prüfungen für alle Anlagen dieser Art automatisch planen */
  assetKind: AssetKind | null;
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
    assetKind: "elektro_ortsveraenderlich",
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
    assetKind: null,
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
    assetKind: "feuerloescher",
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
    assetKind: null,
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
    assetKind: "spielgeraet",
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
    assetKind: "sportgeraet",
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
    assetKind: "tor_tuer",
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
    assetKind: "leiter",
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
    assetKind: "erste_hilfe",
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
    assetKind: null,
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
    assetKind: "aufzug",
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
    assetKind: null,
    intervalMonths: 12,
    warnDays: 30,
    source: src("ArbSchG § 5, DGUV Vorschrift 1"),
    responsible: "schule",
    note: "Schulleitung",
  },
];
