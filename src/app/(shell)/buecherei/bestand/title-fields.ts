import { MEDIA_TYPE_LABELS, MEDIA_TYPES } from "@/modules/buecherei/labels";
import type { FieldSpec } from "@/ui/spec-form";

const MEDIA_OPTIONS = MEDIA_TYPES.map((k) => ({ value: k, label: MEDIA_TYPE_LABELS[k] }));

/** Höchstzahl Exemplare je Anlage (wie `MAX_COPIES_AT_ONCE` im Service – hier ohne Server-Import, auch für Client-Formulare). */
const MAX_COPIES = 200;

/** Felder „Titel anlegen“ – auch für den Vorschlag aus der ISBN-Abfrage (BU-06) mit vorbelegten Werten. */
export function newTitleFields(d: Partial<Record<"title" | "author" | "isbn" | "publisher" | "year", string>> = {}): FieldSpec[] {
  return [
    { name: "title", label: "Titel", type: "text", required: true, maxLength: 200, wide: true, defaultValue: d.title },
    { name: "author", label: "Autor:in", type: "text", maxLength: 120, defaultValue: d.author },
    { name: "isbn", label: "ISBN", type: "text", maxLength: 20, hint: "ISBN-10 oder -13, Prüfziffer wird geprüft", defaultValue: d.isbn },
    { name: "mediaType", label: "Medienart", type: "select", options: MEDIA_OPTIONS, defaultValue: "buch" },
    { name: "publisher", label: "Verlag", type: "text", maxLength: 120, defaultValue: d.publisher },
    { name: "year", label: "Jahr", type: "number", min: 1450, max: 2100, defaultValue: d.year },
    { name: "ageFrom", label: "Altersempfehlung ab", type: "number", min: 0, max: 21, hint: "Jahre" },
    { name: "keywords", label: "Schlagwörter", type: "text", maxLength: 300, wide: true, hint: "durch Komma getrennt" },
    { name: "count", label: "Exemplare", type: "number", min: 0, max: MAX_COPIES, defaultValue: "1", hint: "Exemplarnummern vergibt SchulOS" },
    { name: "signature", label: "Signatur", type: "text", maxLength: 40 },
    { name: "location", label: "Standort", type: "text", maxLength: 80, wide: true, placeholder: "z. B. Regal 3, Jugendbuch" },
  ];
}
