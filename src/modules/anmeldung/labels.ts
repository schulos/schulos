// Schulanmeldung (P4-32): Arten, Status und Beschriftungen – rein, ohne DB (Schema und UI nutzen dieselben Listen).
// Neue Werte nur hinten anfügen: Postgres sortiert Enums nach Deklaration.

export const VERFAHREN_KINDS = ["klasse5", "oberstufe_ef", "seiteneinstieg"] as const;
export type VerfahrenKind = (typeof VERFAHREN_KINDS)[number];

export const VERFAHREN_KIND_LABELS: Record<VerfahrenKind, string> = {
  klasse5: "Übergang in die weiterführende Schule",
  oberstufe_ef: "Aufnahme in die Oberstufe (extern)",
  seiteneinstieg: "Seiteneinstieg (unterjährig)",
};

export const VERFAHREN_STATUSES = ["entwurf", "offen", "geschlossen", "abgeschlossen"] as const;
export type VerfahrenStatus = (typeof VERFAHREN_STATUSES)[number];

export const VERFAHREN_STATUS_LABELS: Record<VerfahrenStatus, string> = {
  entwurf: "Entwurf",
  offen: "Veröffentlicht",
  geschlossen: "Geschlossen",
  abgeschlossen: "Abgeschlossen",
};

export const ANTRAG_STATUSES = [
  "unbestaetigt",
  "eingegangen",
  "termin",
  "vollstaendig",
  "aufgenommen",
  "warteliste",
  "abgelehnt",
  "zurueckgezogen",
  "uebernommen",
] as const;
export type AntragStatus = (typeof ANTRAG_STATUSES)[number];

export const ANTRAG_STATUS_LABELS: Record<AntragStatus, string> = {
  unbestaetigt: "E-Mail nicht bestätigt",
  eingegangen: "Eingegangen",
  termin: "Termin vereinbart",
  vollstaendig: "Unterlagen vollständig",
  aufgenommen: "Aufgenommen",
  warteliste: "Warteliste",
  abgelehnt: "Abgelehnt",
  zurueckgezogen: "Zurückgezogen",
  uebernommen: "Übernommen",
};

export const EREIGNIS_KINDS = ["eingegangen", "bestaetigt", "termin", "status", "notiz", "mail"] as const;
export type EreignisKind = (typeof EREIGNIS_KINDS)[number];

/** Optionale Formularfelder je Verfahren (an/aus). Grundschulempfehlung bewusst nicht (Q-31: nein in V1, DS-11). */
export const OPTIONAL_FIELDS = ["geschwister", "zweitwunsch", "elternteil2", "hinweise"] as const;
export type OptionalField = (typeof OPTIONAL_FIELDS)[number];

export const OPTIONAL_FIELD_LABELS: Record<OptionalField, string> = {
  geschwister: "Geschwisterkind an der Schule",
  zweitwunsch: "Zweitwunsch (andere Schule)",
  elternteil2: "Zweiter Elternteil",
  hinweise: "Hinweise für das Gespräch (höchstens 300 Zeichen, keine Gesundheitsdaten)",
};

export type VerfahrenFields = Record<OptionalField, boolean>;

/** Vorgabe je Art: Klasse 5 mit Geschwistern und Zweitwunsch; EF/Seiteneinstieg ohne Grundschul-Bezug (Q-30). */
export function defaultFields(kind: VerfahrenKind): VerfahrenFields {
  return { geschwister: true, zweitwunsch: kind === "klasse5", elternteil2: true, hinweise: true };
}

export function parseFields(raw: unknown, kind: VerfahrenKind): VerfahrenFields {
  const base = defaultFields(kind);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  return Object.fromEntries(OPTIONAL_FIELDS.map((f) => [f, typeof r[f] === "boolean" ? r[f] : base[f]])) as VerfahrenFields;
}
