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

// ---------------------------------------------------------------- Inventar, Prüfungen, Wartung (P4-15…P4-17, INV-01)
// Die Arten der Anlagen sind seit INV-01 Kategorien in der Tabelle `gebaeude_asset_categories` (Vorlage `kategorien.ts`).

/** Zustand eines Inventarguts (INV-01). Freitext dazu steht in der Notiz – ohne Personenbezug. */
export const ASSET_CONDITIONS = ["neu", "gut", "gebraucht", "defekt"] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];
export const CONDITION_LABELS: Record<AssetCondition, string> = { neu: "neu", gut: "gut", gebraucht: "gebraucht", defekt: "defekt" };

/**
 * Rein: Meldungskategorie zu einer Inventar-Kategorie (INV-03 „Mangel melden“ vom Etikett, Mängel aus Prüfungen) – IT/AV → IT/Medien,
 * Haustechnik-Anlagen → Haustechnik, Sicherheitsausstattung → Sicherheit, sonst Gebäude.
 */
export function ticketCategoryForAsset(categoryKey: string | null): TicketCategory {
  switch (categoryKey) {
    case "it":
    case "praesentation":
      return "it";
    case "elektro_ortsveraenderlich":
    case "aufzug":
    case "lueftung":
    case "tor_tuer":
      return "technik";
    case "feuerloescher":
    case "erste_hilfe":
    case "sicherheit":
      return "sicherheit";
    default:
      return "gebaeude";
  }
}

/** Fotos je Inventargut (INV-03, wie Raumfotos): höchstens 6, je 20 MB vor dem Verkleinern auf 1600 px. */
export const ASSET_PHOTOS_MAX = 6;
export const ASSET_PHOTO_MAX_MB = 20;

/** Inventarnummern: Präfix der Kategorie + laufende Nummer (Moduleinstellung `gebaeude.inventory_no_format`). */
export const INVENTORY_NO_FORMATS = ["prefix-4", "prefix-year-4", "prefix-6"] as const;
export type InventoryNoFormat = (typeof INVENTORY_NO_FORMATS)[number];
export const INVENTORY_NO_FORMAT_LABELS: Record<InventoryNoFormat, string> = {
  "prefix-4": "Präfix-0001 (vierstellig, fortlaufend)",
  "prefix-year-4": "Präfix-2026-0001 (mit Jahr, je Jahr neu)",
  "prefix-6": "Präfix-000001 (sechsstellig, fortlaufend)",
};

/** Rein: Inventarnummer aus Präfix, Zähler und Format, z. B. „IT-0042“. */
export function formatInventoryNo(format: InventoryNoFormat, prefix: string, n: number, year: number): string {
  if (format === "prefix-year-4") return `${prefix}-${year}-${String(n).padStart(4, "0")}`;
  if (format === "prefix-6") return `${prefix}-${String(n).padStart(6, "0")}`;
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/** Rein: Zählerschlüssel je Präfix (mit Jahr, wenn das Format es führt) – so läuft die Nummer je Jahr neu. */
export function inventoryCounterKey(format: InventoryNoFormat, prefix: string, year: number): string {
  return format === "prefix-year-4" ? `${prefix}:${year}` : prefix;
}

/** Rein: Preis „1.234,56“ / „1234.5“ / „12 €“ → Cent; `null` bei leer, `NaN` bei unlesbar. */
export function parsePriceCents(raw: string | null | undefined): number | null {
  const v = (raw ?? "").replace(/[€\s]/g, "").trim();
  if (!v) return null;
  const norm = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(v) ? v.replace(/\./g, "").replace(",", ".") : v.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return Number.NaN;
  return Math.round(Number(norm) * 100);
}

const euroFmt = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
/** „1.234,56 €“ bzw. „–“ */
export const formatPrice = (cents: number | null) => (cents === null ? "–" : euroFmt.format(cents / 100));

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

// ---------------------------------------------------------------- Inventur (INV-04)

/**
 * Stand eines Postens in einer Inventur: offen (noch nicht gesehen), gefunden, fehlt (beim Abschluss nicht gefunden bzw. von Hand),
 * falscher Raum (gefunden, gehört laut Inventar woanders hin), umgezogen (falscher Raum, per Knopf in den Inventurraum übernommen),
 * verliehen (INV-05: beim Start bzw. Abschluss an eine Person ausgeliehen – nicht „fehlt“).
 */
export const INVENTORY_ITEM_STATES = ["offen", "gefunden", "fehlt", "falscher_raum", "umgezogen", "verliehen"] as const;
export type InventoryItemState = (typeof INVENTORY_ITEM_STATES)[number];
export const INVENTORY_ITEM_STATE_LABELS: Record<InventoryItemState, string> = {
  offen: "offen",
  gefunden: "gefunden",
  fehlt: "fehlt",
  falscher_raum: "falscher Raum",
  umgezogen: "umgezogen",
  verliehen: "verliehen",
};

/** Wie ein Posten erfasst wurde: Etikett mit der Kamera-App (`/i/<code>`), Scan in der App bzw. Eingabe, Knopf in der Liste. */
export const INVENTORY_METHODS = ["etikett", "scan", "liste"] as const;
export type InventoryMethod = (typeof INVENTORY_METHODS)[number];
export const INVENTORY_METHOD_LABELS: Record<InventoryMethod, string> = { etikett: "Etikett", scan: "Scan/Eingabe", liste: "Liste" };

/**
 * Rein: Eingabe eines Scans (In-App-Scan, Handscanner, abgetippt) zerlegen – volle Kurz-URL bzw. Pfad `/i/<code>` → Code, sonst der
 * Text selbst (Code oder Inventarnummer). Fremde Etiketten (`/r/<code>`) erkennt der Aufrufer am `kind`.
 */
export function parseScanInput(raw: string): { kind: "inventar" | "raum" | "text"; value: string } {
  const v = raw.trim().slice(0, 300);
  const m = /(?:^|\/)([ir])\/([0-9A-Za-z]{16})\/?(?:[?#].*)?$/.exec(v);
  if (m) return { kind: m[1] === "i" ? "inventar" : "raum", value: m[2]! };
  return { kind: "text", value: v };
}

// ---------------------------------------------------------------- Ausleihe (INV-05)

/** Höchstens so viele Erinnerungen nach Fristende (1. am ersten Schultag danach, dann im Abstand `LOAN_OVERDUE_INTERVAL_DAYS`). */
export const LOAN_MAX_OVERDUE_LEVEL = 3;
/** Abstand der Erinnerungen bei überfälligen Leihgeräten (Tage, nur an Schultagen). */
export const LOAN_OVERDUE_INTERVAL_DAYS = 7;
/** Ab dieser Erinnerung erfahren es die Eltern Minderjähriger (wie Bücherei-Mahnstufe 2). */
export const LOAN_PARENT_LEVEL = 2;
/** Längste Leihfrist ab heute (Tage) – auch Schuljahresleihen passen hinein. */
export const LOAN_MAX_DAYS = 730;
export const LOAN_TEXT_MAX = 300;

/** Stand einer Ausleihe für Anzeige und Sortierung. */
export type LoanState = "offen" | "ueberfaellig" | "zurueck";
export const LOAN_STATE_LABELS: Record<LoanState, string> = { offen: "verliehen", ueberfaellig: "überfällig", zurueck: "zurückgegeben" };

/** Rein: Stand einer Ausleihe am Tag `today` (YYYY-MM-DD). */
export function loanState(l: { dueOn: string; returnedAt: Date | null }, today: string): LoanState {
  if (l.returnedAt) return "zurueck";
  return l.dueOn < today ? "ueberfaellig" : "offen";
}
