import type { Role } from "@/core/db/schema";
import type { RetentionDecl } from "@/core/retention";
import type { ModuleSettingDecl } from "./settings";

export const NAV_SECTIONS = ["start", "kommunikation", "unterricht", "organisation", "verwaltung"] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  start: "",
  kommunikation: "Kommunikation",
  unterricht: "Unterricht",
  organisation: "Organisation",
  verwaltung: "Verwaltung",
};

export interface ModuleNavItem {
  href: string;
  label: string;
  /** Nur zeigen, wenn der Benutzer dieses Recht hat (Liste: eines davon) */
  requires?: string | string[];
  /** Nur zeigen, wenn zusätzlich dieses (andere) Modul eingeschaltet ist */
  requiresModule?: string;
  /** Nur für diese Rollen zeigen */
  roles?: Role[];
  /**
   * Nur für eigenständige (volljährige) Schüler:innen (Rolle `schueler` mit Kennzeichen „eigenständig“, Q5-05/DS-19) –
   * sie bekommen, was sonst an die Eltern geht (G4D-C09)
   */
  selfResponsible?: boolean;
  /** eigenes Icon (sonst das des Moduls) */
  icon?: string;
  /**
   * `requires` zählt nur ausdrücklich vergebene Rechte (Rollen-/Gruppen-Grant ohne `*`, ohne Admin-Sonderrecht) – für Module
   * ohne Admin-Override wie das Notenbuch (P5-16)
   */
  explicit?: boolean;
  /** Nur zeigen, wenn keine dieser Moduleinstellungen (voller Schlüssel) auf `off` steht (P5-14) */
  settings?: { key: string; off: string }[];
}

/** Verarbeitungstätigkeit (Art. 30 DSGVO) – Grundlage für Datenschutzhinweise und VVT. */
export interface ProcessingDecl {
  /** Bezeichnung der Verarbeitungstätigkeit */
  title: string;
  /** Zweck in einem Satz */
  purpose: string;
  /** Rechtsgrundlage; ohne Angabe die des Schulverhältnisses */
  legalBasis?: string;
  /** Betroffene Personengruppen */
  subjects: string[];
  /** Wer die Daten zu sehen bekommt (innerhalb der Schule; Dritte ausdrücklich nennen) */
  recipients: string[];
  /** Ergänzung, z. B. besondere Kategorien oder Sichtbarkeitsregeln */
  note?: string;
}

export interface ModuleManifest {
  /** Kurz, kleingeschrieben, URL-tauglich – zugleich Präfix aller Rechte und Tabellen */
  id: string;
  name: string;
  description: string;
  /** Name eines lucide-Icons, z. B. "ClipboardCheck" */
  icon: string;
  section: NavSection;
  /** Reihenfolge innerhalb der Sektion */
  order?: number;
  /** Platz in der mobilen Bottom-Bar (kleiner = weiter vorn); ohne Angabe nur unter „Mehr“ */
  mobile?: number;
  /** Kernmodule lassen sich nicht abschalten */
  core?: boolean;
  /** Standardzustand, solange in module_states nichts gespeichert ist */
  defaultEnabled?: boolean;
  /**
   * Modul braucht den E-Mail-Versand (P4-33): Einschalten nur mit SMTP (bzw. in Entwicklung/E2E) – der Text erklärt in
   * Verwaltung → Rechte & Module, was fehlt.
   */
  needsMail?: string;
  /** Rechte dieses Moduls: "<id>.<aktion>" → Beschreibung */
  permissions?: Record<string, string>;
  /** Grants, die beim ersten Start des Moduls angelegt werden */
  defaultGrants?: Partial<Record<Role, string[]>>;
  /** Gruppenmerkmale: "<id>.<merkmal>" → Beschreibung */
  groupFeatures?: Record<string, string>;
  nav?: ModuleNavItem[];
  /** Moduleinstellungen (Q5-14): Schalter unter Verwaltung → Rechte & Module, Schlüssel "<id>.<name>" */
  settings?: readonly ModuleSettingDecl[];
  /** Löschkonzept: jede Tabelle des Moduls mit Personenbezug (docs/DATENSCHUTZ.md §3.7) */
  retention?: RetentionDecl[];
  /** Verarbeitungstätigkeit; Pflicht, sobald das Modul Personendaten speichert oder anzeigt */
  processing?: ProcessingDecl;
}

export function defineModule<T extends ModuleManifest>(manifest: T): T {
  return manifest;
}
