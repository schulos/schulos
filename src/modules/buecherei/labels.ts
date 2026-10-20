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

/** Präfix der Exemplarnummern der Bücherei (Stufe 2, Lernmittel, hat ein eigenes: `MATERIAL_PREFIX`). */
export const COPY_PREFIX = "B";

/** BU-10: Präfix der Inventarnummern der Lernmittel (Schulbücher) – eigener Nummernkreis, `L-000001-x`. */
export const MATERIAL_PREFIX = "L";

/** BU-10: Wie ein Lernmittel zu den Familien kommt – von der Schule ausgeliehen oder selbst gekauft (Eigenanteil, Arbeitshefte). */
export const MATERIAL_PROVISIONS = ["leihe", "kauf"] as const;
export type MaterialProvision = (typeof MATERIAL_PROVISIONS)[number];

export const PROVISION_LABELS: Record<MaterialProvision, string> = {
  leihe: "leiht die Schule aus",
  kauf: "selbst kaufen",
};

/** Rein: Jahrgänge kompakt – {5,6,7} → „5–7“, {5,7} → „5, 7“. */
export function gradeRange(grades: readonly number[]): string {
  const g = [...grades].sort((a, b) => a - b);
  const contiguous = g.length > 2 && g.every((x, i) => i === 0 || x === g[i - 1]! + 1);
  return contiguous ? `${g[0]}–${g.at(-1)}` : g.join(", ");
}

/** Rein: Betrag in Cent als „12,95 €“. */
export function formatEuro(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

/** Rein: „12,95“, „12.95“, „12“ oder „12,95 €“ → Cent; leer → null; ungültig → "bad". Höchstens 999,99 €. */
export function parseEuro(raw: string | null | undefined): number | null | "bad" {
  const v = (raw ?? "").replace(/€/g, "").trim();
  if (!v) return null;
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(v);
  if (!m) return "bad";
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

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

/** Rein: Inventarnummer eines Lernmittels, z. B. `L-000042-7` (BU-10, eigener Nummernkreis). */
export const materialNumber = (seq: number) => copyNumber(seq, MATERIAL_PREFIX);

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
