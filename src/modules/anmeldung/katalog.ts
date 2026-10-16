// Landesabhängige Begriffe der Schulanmeldung (P4-32, docs/PHASE4.md §3.3 „Landesbezug“): NRW als geprüfte Grundlage,
// neutraler Fallback für alle anderen Länder (dort gilt zusätzlich der vorhandene Warnhinweis). Alle Angaben „zu prüfen“.
import type { StateCode } from "@/core/school/catalog";

export interface ChecklistItem {
  key: string;
  label: string;
}

export interface AnmeldungKatalog {
  /** Name des Übergangsnachweises der Grundschule */
  transitionDoc: string;
  /** im Gespräch vorzulegen (Häkchen „vorgelegt“, keine Uploads – Q-37) */
  checklist: ChecklistItem[];
  /** Widerspruchsfrist gegen den Bescheid in Tagen (Löschfrist abgelehnter Anträge muss darüber liegen) */
  objectionDays: number;
  /** Rechtsgrundlage für Datenschutzhinweis/VVT */
  legalBasis: string;
}

const NW: AnmeldungKatalog = {
  transitionDoc: "Anmeldeschein",
  checklist: [
    { key: "anmeldeschein", label: "Anmeldeschein der Grundschule (Original)" },
    { key: "zeugnis", label: "Halbjahreszeugnis Klasse 4 mit begründeter Empfehlung" },
    { key: "geburtsurkunde", label: "Geburtsurkunde bzw. Familienstammbuch" },
    { key: "masern", label: "Nachweis Masernschutz (§ 20 Abs. 9 IfSG)" },
  ],
  objectionDays: 30,
  legalBasis: "Art. 6 Abs. 1 lit. e DSGVO i. V. m. § 120 Abs. 1, 5 SchulG NRW und VO-DV I; Aufnahme nach § 46 SchulG NRW (zu prüfen)",
};

const FALLBACK: AnmeldungKatalog = {
  transitionDoc: "Übergangsnachweis der Grundschule",
  checklist: [
    { key: "anmeldeschein", label: "Übergangsnachweis bzw. Anmeldeformular der Grundschule" },
    { key: "zeugnis", label: "Letztes Zeugnis" },
    { key: "geburtsurkunde", label: "Geburtsurkunde bzw. Familienstammbuch" },
    { key: "masern", label: "Nachweis Masernschutz (§ 20 Abs. 9 IfSG)" },
  ],
  objectionDays: 30,
  legalBasis: "Art. 6 Abs. 1 lit. e DSGVO i. V. m. dem Schulgesetz des Landes (zu prüfen)",
};

export function anmeldungKatalog(state: StateCode): AnmeldungKatalog {
  return state === "NW" ? NW : FALLBACK;
}

export const CHECKLIST_KEYS = NW.checklist.map((c) => c.key);
