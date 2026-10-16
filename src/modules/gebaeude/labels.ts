// Gebäude & Technik – Aufzählungen und Beschriftungen. Abhängigkeitsfrei (auch für Client-Komponenten und das Schema).

export const TICKET_CATEGORIES = ["gebaeude", "technik", "it", "reinigung", "sicherheit", "sonstiges"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ["niedrig", "normal", "hoch", "gefahr"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ["neu", "angenommen", "in_arbeit", "wartet_extern", "erledigt", "abgelehnt"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_EVENT_KINDS = ["status", "kommentar", "zuweisung", "raumsperre", "foto"] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  gebaeude: "Gebäude",
  technik: "Haustechnik",
  it: "IT/Medien",
  reinigung: "Reinigung",
  sicherheit: "Sicherheit",
  sonstiges: "Sonstiges",
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  niedrig: "niedrig",
  normal: "normal",
  hoch: "hoch",
  gefahr: "Gefahr",
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  neu: "Neu",
  angenommen: "Angenommen",
  in_arbeit: "In Arbeit",
  wartet_extern: "Wartet auf Firma/Teil",
  erledigt: "Erledigt",
  abgelehnt: "Abgelehnt",
};

/** Offene Status in Board-Reihenfolge. */
export const OPEN_STATUSES = ["neu", "angenommen", "in_arbeit", "wartet_extern"] as const satisfies readonly TicketStatus[];
export const CLOSED_STATUSES = ["erledigt", "abgelehnt"] as const satisfies readonly TicketStatus[];

/** Erlaubte Übergänge der Status-Maschine. „erledigt“/„abgelehnt“ lassen sich wieder öffnen. */
export const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  neu: ["angenommen", "in_arbeit", "erledigt", "abgelehnt"],
  angenommen: ["in_arbeit", "wartet_extern", "erledigt", "abgelehnt"],
  in_arbeit: ["wartet_extern", "erledigt", "angenommen"],
  wartet_extern: ["in_arbeit", "erledigt"],
  erledigt: ["in_arbeit"],
  abgelehnt: ["neu"],
};

/** Beschriftung des Knopfes für einen Übergang. */
export const TRANSITION_LABELS: Record<TicketStatus, string> = {
  neu: "Wieder öffnen",
  angenommen: "Annehmen",
  in_arbeit: "In Arbeit",
  wartet_extern: "Wartet auf Firma/Teil",
  erledigt: "Erledigt",
  abgelehnt: "Ablehnen",
};

export const isClosed = (s: TicketStatus) => (CLOSED_STATUSES as readonly TicketStatus[]).includes(s);

/** „M-2026-0042“ */
export const ticketNumber = (year: number, seq: number) => `M-${year}-${String(seq).padStart(4, "0")}`;

/** Fotos je Meldung (Q-24): höchstens 3 × 5 MB, nur JPEG/PNG/WebP, Metadaten werden entfernt. */
export const MAX_PHOTOS = 3;
export const MAX_PHOTO_MB = 5;

// ---------------------------------------------------------------- Anlagen, Prüfungen, Wartung (P4-15…P4-17)

export const ASSET_KINDS = [
  "elektro_ortsveraenderlich",
  "feuerloescher",
  "spielgeraet",
  "sportgeraet",
  "aufzug",
  "tor_tuer",
  "leiter",
  "erste_hilfe",
  "lueftung",
  "sonstiges",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  elektro_ortsveraenderlich: "Elektrogerät (ortsveränderlich)",
  feuerloescher: "Feuerlöscher",
  spielgeraet: "Spielgerät (außen)",
  sportgeraet: "Sportgerät",
  aufzug: "Aufzug",
  tor_tuer: "Kraftbetätigtes Tor/Tür",
  leiter: "Leiter/Tritt",
  erste_hilfe: "Erste-Hilfe-Material",
  lueftung: "Lüftung",
  sonstiges: "Sonstiges",
};

/** Worauf sich eine Prüfart bezieht: einzelne Anlage/Gerät, Raum oder ganzes Gebäude. */
export const INSPECTION_TARGETS = ["anlage", "raum", "gebaeude"] as const;
export type InspectionTarget = (typeof INSPECTION_TARGETS)[number];
export const INSPECTION_TARGET_LABELS: Record<InspectionTarget, string> = { anlage: "Anlage/Gerät", raum: "Raum", gebaeude: "Gebäude" };

export const INSPECTION_RESPONSIBLES = ["schule", "schultraeger", "extern"] as const;
export type InspectionResponsible = (typeof INSPECTION_RESPONSIBLES)[number];
export const RESPONSIBLE_LABELS: Record<InspectionResponsible, string> = { schule: "Schule", schultraeger: "Schulträger", extern: "externe Firma" };

export const INSPECTION_RESULTS = ["ok", "mangel", "ausser_betrieb"] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];
export const RESULT_LABELS: Record<InspectionResult, string> = { ok: "ohne Mangel", mangel: "Mangel", ausser_betrieb: "außer Betrieb genommen" };

/** Stand einer Prüfung: offen (geplant / fällig in der Vorwarnzeit / überfällig) oder erledigt. */
export const INSPECTION_STATES = ["ueberfaellig", "faellig", "geplant", "erledigt"] as const;
export type InspectionState = (typeof INSPECTION_STATES)[number];
export const INSPECTION_STATE_LABELS: Record<InspectionState, string> = { ueberfaellig: "überfällig", faellig: "bald fällig", geplant: "geplant", erledigt: "erledigt" };

/** Protokoll-PDF einer Prüfung: höchstens 10 MB, nur echte PDFs (Magic Bytes). */
export const MAX_REPORT_MB = 10;

/** Ort einer Meldung als Text: „Raum 112“ bzw. „Pausenhof“ bzw. beides. */
export function placeLabel(t: { roomId: string | null; location: string | null }): string {
  return [t.roomId ? `Raum ${t.roomId}` : null, t.location].filter(Boolean).join(", ") || "ohne Ort";
}
