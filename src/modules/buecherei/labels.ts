// Schulbücherei – Aufzählungen, Beschriftungen und reine Prüfungen (ISBN, Exemplarnummer). Abhängigkeitsfrei (auch für
// Client-Komponenten und das Schema; nur relative Typ-Imports).

import type { Role } from "../../core/roles";

/** Wer ausleihen kann (BU-02): alle Konten der Schule außer Eltern und technischen Admin-Konten. */
export const BORROWER_ROLES: readonly Role[] = ["schueler", "lehrkraft", "personal", "beratung", "verwaltung"];

export const MEDIA_TYPES = ["buch", "film", "spiel", "geraet", "sonstiges"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  buch: "Buch",
  film: "Film",
  spiel: "Spiel",
  geraet: "Gerät",
  sonstiges: "Sonstiges",
};

export const COPY_CONDITIONS = ["neu", "gut", "gebraucht", "schlecht"] as const;
export type CopyCondition = (typeof COPY_CONDITIONS)[number];

export const CONDITION_LABELS: Record<CopyCondition, string> = {
  neu: "neu",
  gut: "gut",
  gebraucht: "gebraucht",
  schlecht: "schlecht",
};

/** Präfix der Exemplarnummern der Bücherei (Stufe 2, Lernmittel, bekommt ein eigenes). */
export const COPY_PREFIX = "B";

/** Rein: Prüfziffer (Luhn, Ziffern 0–9) über die laufende Nummer. */
export function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Rein: Exemplarnummer aus Präfix und laufender Nummer, z. B. `B-004711-3` (sechsstellig, Prüfziffer). */
export function copyNumber(seq: number, prefix = COPY_PREFIX): string {
  const digits = String(seq).padStart(6, "0");
  return `${prefix}-${digits}-${luhnDigit(digits)}`;
}

/** Rein: Exemplarnummer gültig (Form und Prüfziffer)? Tippfehler beim Abtippen fallen so auf. */
export function isValidCopyNumber(raw: string): boolean {
  const m = /^([A-Z]{1,3})-(\d{6,})-(\d)$/.exec(raw.trim().toUpperCase());
  return !!m && luhnDigit(m[2]!) === Number(m[3]);
}

/**
 * Rein: ISBN normalisieren – Bindestriche/Leerzeichen weg, Prüfziffer prüfen, ISBN-10 → ISBN-13. Liefert die ISBN-13 oder
 * null, wenn die Angabe keine gültige ISBN ist.
 */
export function normalizeIsbn(raw: string): string | null {
  const v = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(v)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (v[i] === "X" ? 10 : Number(v[i])) * (10 - i);
    if (sum % 11 !== 0) return null;
    const core = `978${v.slice(0, 9)}`;
    return core + isbn13Digit(core);
  }
  if (/^97[89]\d{10}$/.test(v)) return isbn13Digit(v.slice(0, 12)) === Number(v[12]) ? v : null;
  return null;
}

function isbn13Digit(twelve: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** Rein: ISBN-13 lesbar mit Bindestrichen nach dem Präfix (ohne Gruppen-/Verlagsaufteilung): `978-3-…` wäre länderabhängig. */
export function formatIsbn(isbn: string): string {
  return isbn.length === 13 ? `${isbn.slice(0, 3)}-${isbn.slice(3, 12)}-${isbn.slice(12)}` : isbn;
}
