// RS-11: Codes für Kurz-URLs auf gedruckten Etiketten (Tür-QR `/r/<code>`, später Inventar) – rein, ohne DB.
// Gemeinsamer Unterbau (docs/RAUMSTECKBRIEF.md „Umgesetzt (RS-10…12)“): Codeerzeugung, Arten mit Kurz-URL, Druckformate.
// Codes sind nicht erratbar (80 Bit Zufall), aber stabil – sie ändern sich nur beim ausdrücklichen Neuerzeugen.

/** Zeichen ohne Verwechslungsgefahr (ohne I, L, O, U) – wie die Bücherei-Ausweise; 32 Zeichen = 5 Bit je Stelle. */
export const LABEL_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 16 Stellen = 80 Bit Zufall. */
export const LABEL_CODE_LENGTH = 16;

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** Rein: neuer Code aus Zufallsbytes (jedes Byte mod 32 – 256 ist ein Vielfaches von 32, also gleichverteilt). */
export function newLabelCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(LABEL_CODE_LENGTH)].map((b) => LABEL_CODE_ALPHABET[b % 32]).join("");
}

/**
 * Rein: Eingabe aus der URL auf die gespeicherte Form bringen (Großbuchstaben, abgetippte Verwechsler O→0, I/L→1) – `null`,
 * wenn sie gar nicht wie ein Code aussieht.
 */
export function normalizeLabelCode(input: string): string | null {
  const c = input.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE_RE.test(c) ? c : null;
}

/** Arten von Etiketten mit Kurz-URL. Neue Art: hier ergänzen, Spalte + Prüfungen in `label_codes` (`schema.ts`), `TARGET` im Service. */
export const LABEL_KINDS = ["raum", "inventar"] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

export const LABEL_KIND_INFO: Record<LabelKind, { label: string; /** Präfix der Kurz-URL */ path: string }> = {
  raum: { label: "Raum", path: "/r/" },
  inventar: { label: "Inventar", path: "/i/" },
};

/** Rein: Pfad der Kurz-URL, z. B. `/r/7K3M9QXZ2HPA4T6W`. */
export function labelPath(kind: LabelKind, code: string): string {
  return `${LABEL_KIND_INFO[kind].path}${code}`;
}

// --------------------------------------------------------------------------- Druck

/** Druckformate für Schilder/Etiketten mit QR (A4-Papier; A5 = zwei Schilder je Blatt zum Schneiden). */
export const SIGN_FORMATS = {
  a5: { label: "A5 quer (zwei je A4-Blatt)", perPage: 2, widthMm: 210, heightMm: 148.5 },
  a4: { label: "A4 hoch (eins je Blatt)", perPage: 1, widthMm: 210, heightMm: 297 },
} as const;
export type SignFormat = keyof typeof SIGN_FORMATS;

export function signFormat(v: string | undefined): SignFormat {
  return v === "a4" ? "a4" : "a5";
}

/**
 * INV-02: Formate für Inventar-Etiketten (inv-7): A4-Etikettenbögen in zwei gängigen Rastern und eine Endlosrolle 62 mm
 * (ein Etikett je „Seite“, der Drucker schneidet). Maße in mm; Bögen anderer Hersteller über die Ränder anpassen.
 */
export const LABEL_FORMATS = {
  "bogen-3x8": { label: "A4-Bogen 3×8 (70 × 36 mm)", kind: "bogen", cols: 3, rows: 8, widthMm: 70, heightMm: 36, topMm: 4.5, leftMm: 0, gapXMm: 0, gapYMm: 0 },
  "bogen-4x13": { label: "A4-Bogen 4×13 (48 × 21 mm)", kind: "bogen", cols: 4, rows: 13, widthMm: 48.5, heightMm: 21.2, topMm: 10.7, leftMm: 8, gapXMm: 0, gapYMm: 0 },
  "rolle-62": { label: "Endlosrolle 62 mm (62 × 29 mm)", kind: "rolle", cols: 1, rows: 1, widthMm: 62, heightMm: 29, topMm: 0, leftMm: 0, gapXMm: 0, gapYMm: 0 },
} as const;
export type LabelFormat = keyof typeof LABEL_FORMATS;
export const DEFAULT_LABEL_FORMAT: LabelFormat = "bogen-3x8";

export function labelFormat(v: string | undefined, fallback: LabelFormat = DEFAULT_LABEL_FORMAT): LabelFormat {
  return v && v in LABEL_FORMATS ? (v as LabelFormat) : fallback;
}

/** Etiketten je Blatt eines Formats (Rolle: eins je Abschnitt). */
export const labelsPerPage = (f: LabelFormat) => LABEL_FORMATS[f].cols * LABEL_FORMATS[f].rows;

/** Rein: Schilder auf Seiten verteilen. */
export function paginate<T>(items: readonly T[], perPage: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));
  return pages;
}
