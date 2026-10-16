// Erklärung zur Barrierefreiheit (A11Y-02) – Felder und Textbausteine, rein (Formular, öffentliche Seite, Tests).
// Aufbau nach dem EU-Muster (Durchführungsbeschluss (EU) 2018/1523) bzw. § 7 BITV 2.0 / § 10c BGG NRW + BITV NRW:
// Stand der Vereinbarkeit · nicht barrierefreie Inhalte · Erstellung der Erklärung · Feedback und Kontakt ·
// Durchsetzungs- bzw. Schlichtungsverfahren. Vorlage, keine Rechtsberatung – die Schule prüft und ergänzt.
import type { StateCode } from "./catalog";

export const A11Y_STATUS = ["teilweise", "vollstaendig", "nicht"] as const;
export type A11yStatus = (typeof A11Y_STATUS)[number];

export const A11Y_STATUS_LABEL: Record<A11yStatus, string> = {
  vollstaendig: "vollständig vereinbar",
  teilweise: "teilweise vereinbar",
  nicht: "nicht vereinbar",
};

export interface A11yStatement {
  status: A11yStatus;
  /** Ansprechstelle für Rückmeldungen, z. B. „Sekretariat“ – bewusst keine Person nötig */
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  /** Datum der Selbstbewertung bzw. letzten Überprüfung (YYYY-MM-DD) */
  reviewedOn: string;
  /** weitere nicht barrierefreie Inhalte der Schule (z. B. eingestellte PDF-Dateien), mehrzeilig */
  extraBarriers: string;
  /** eigener Text zum Durchsetzungsverfahren – leer = Vorgabe je Bundesland */
  enforcement: string;
}

export const A11Y_FIELD_MAX = { contactName: 200, contactEmail: 254, contactPhone: 40, extraBarriers: 3000, enforcement: 3000 } as const;

export const EMPTY_A11Y_STATEMENT: A11yStatement = {
  status: "teilweise",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  reviewedOn: "",
  extraBarriers: "",
  enforcement: "",
};

/**
 * Bekannte Einschränkungen von SchulOS selbst (Stand A11Y-01, e2e/a11y.spec.ts). Bei jeder Änderung an der Barrierefreiheit
 * mitpflegen – die Erklärung soll ehrlich sein.
 */
export const KNOWN_BARRIERS: readonly string[] = [
  "Tafeln: Die freie Zeichenfläche ist eine Grafik. Zeichnungen haben keine Textalternative; Text auf der Tafel ist für Screenreader nur eingeschränkt lesbar.",
  "Von Nutzerinnen und Nutzern eingestellte Inhalte (Dateien, Bilder, PDF-Dokumente, Elternbriefe als Anhang) sind nicht in jedem Fall barrierefrei. Verantwortlich ist, wer sie einstellt.",
  "Stunden- und Vertretungspläne sind große Tabellen; auf kleinen Bildschirmen und mit Screenreadern ist die Listenansicht „Heute“ leichter zu bedienen.",
  "Geöffnete Menüs liegen technisch außerhalb der Seitenbereiche (Landmarken); sie sind mit Tastatur und Screenreader bedienbar, werden aber nicht als Teil der Kopfzeile angesagt.",
  "Ein vollständiger Test mit Screenreadern steht noch aus; geprüft sind die Kernseiten automatisiert (WCAG 2.1/2.2 AA) und mit der Tastatur.",
];

/** Rechtsgrundlage für den Einleitungssatz. */
export function legalBasis(state: StateCode): string {
  if (state === "NW")
    return "§ 10c des Behindertengleichstellungsgesetzes Nordrhein-Westfalen (BGG NRW) und der Barrierefreie-Informationstechnik-Verordnung Nordrhein-Westfalen (BITV NRW)";
  return "den landesrechtlichen Vorschriften zur Umsetzung der Richtlinie (EU) 2016/2102 über den barrierefreien Zugang zu den Websites und mobilen Anwendungen öffentlicher Stellen";
}

/**
 * Vorgabe zum Durchsetzungs-/Schlichtungsverfahren. NRW: Ombudsstelle für barrierefreie Informationstechnik bei der bzw. dem
 * Landesbehindertenbeauftragten (§§ 10d, 10e BGG NRW, §§ 9 ff. BITV NRW; Angaben Stand 2026-10, vor Veröffentlichung prüfen).
 * Andere Länder: allgemeiner Hinweis, die Schule trägt die zuständige Stelle selbst ein (Q-4E-23).
 */
export function defaultEnforcement(state: StateCode): string {
  if (state === "NW")
    return [
      "Wenn Sie auf Ihre Mitteilungen oder Anfragen zur Barrierefreiheit keine zufriedenstellende Antwort erhalten haben, können Sie sich an die Ombudsstelle für barrierefreie Informationstechnik des Landes Nordrhein-Westfalen wenden. Sie ist bei der bzw. dem Beauftragten der Landesregierung für Menschen mit Behinderung angesiedelt (§§ 10d und 10e BGG NRW, §§ 9 ff. BITV NRW).",
      "Die Ombudsstelle versucht unter Beteiligung aller, die Gründe für fehlende Barrierefreiheit zu klären, damit die Schule sie beheben kann. Das Verfahren ist kostenlos; ein Rechtsbeistand ist nicht nötig.",
      "Ombudsstelle für barrierefreie Informationstechnik NRW · Telefon 0211 855-3451 · E-Mail ombudsstelle-barrierefreie-it@mags.nrw.de · www.mags.nrw/ombudsstelle-barrierefreie-informationstechnik",
    ].join("\n\n");
  return "Wenn Sie auf Ihre Mitteilungen oder Anfragen zur Barrierefreiheit keine zufriedenstellende Antwort erhalten haben, können Sie sich an die nach dem Landesrecht zuständige Durchsetzungs- bzw. Schlichtungsstelle wenden. Die Schule trägt die Stelle hier ein.";
}

/** Fehlende Angaben, ohne die die Erklärung als Vorlage gekennzeichnet bleibt (leer = vollständig). */
export function missingA11yFields(s: A11yStatement): string[] {
  const out: string[] = [];
  if (!s.contactEmail && !s.contactPhone) out.push("Kontakt (E-Mail oder Telefon)");
  if (!s.reviewedOn) out.push("Datum der Überprüfung");
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: unknown, multiline = false) => (typeof v !== "string" ? "" : multiline ? v.replace(/\r\n/g, "\n").trim() : v.replace(/\s+/g, " ").trim());

/** Gespeicherten bzw. eingegebenen Wert lesen – Unbekanntes fällt auf die Vorgaben zurück, nichts wird ungeprüft übernommen. */
export function parseA11yStatement(value: unknown): A11yStatement {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const status = A11Y_STATUS.includes(o.status as A11yStatus) ? (o.status as A11yStatus) : "teilweise";
  const reviewedOn = clean(o.reviewedOn);
  return {
    status,
    contactName: clean(o.contactName),
    contactEmail: clean(o.contactEmail),
    contactPhone: clean(o.contactPhone),
    reviewedOn: DATE_RE.test(reviewedOn) ? reviewedOn : "",
    extraBarriers: clean(o.extraBarriers, true),
    enforcement: clean(o.enforcement, true),
  };
}
