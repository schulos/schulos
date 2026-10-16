// Felder des Impressums (Q5-22) – rein, ohne DB (auch im Browser nutzbar: Formular, öffentliche Seite).

export const IMPRESSUM_FIELD_KEYS = [
  "name",
  "legalForm",
  "street",
  "postalCode",
  "city",
  "representedBy",
  "email",
  "phone",
  "schoolAuthority",
  "supervisoryAuthority",
  "register",
  "vatId",
  "additional",
] as const;
export type ImpressumFieldKey = (typeof IMPRESSUM_FIELD_KEYS)[number];
export type ImpressumFields = Record<ImpressumFieldKey, string>;

export interface ImpressumFieldDef {
  key: ImpressumFieldKey;
  label: string;
  required: boolean;
  max: number;
  hint?: string;
  multiline?: boolean;
}

export const IMPRESSUM_FIELD_DEFS: readonly ImpressumFieldDef[] = [
  { key: "name", label: "Name der Schule", required: true, max: 200 },
  { key: "legalForm", label: "Rechtsform", required: true, max: 200, hint: "z. B. „öffentliche Schule in Trägerschaft der Stadt Musterstadt“" },
  { key: "street", label: "Straße und Hausnummer", required: true, max: 200 },
  { key: "postalCode", label: "Postleitzahl", required: true, max: 5 },
  { key: "city", label: "Ort", required: true, max: 120 },
  { key: "representedBy", label: "Vertreten durch", required: true, max: 300, hint: "vertretungsberechtigte Person, z. B. die Schulleiterin / der Schulleiter mit Namen" },
  { key: "email", label: "E-Mail-Adresse", required: true, max: 254 },
  { key: "phone", label: "Telefon", required: true, max: 40 },
  { key: "schoolAuthority", label: "Schulträger", required: false, max: 300, hint: "optional, Name und Anschrift" },
  { key: "supervisoryAuthority", label: "Zuständige Aufsichtsbehörde", required: false, max: 300, hint: "optional, z. B. die Bezirksregierung" },
  { key: "register", label: "Registereintrag", required: false, max: 200, hint: "nur falls vorhanden (z. B. Schulen in freier Trägerschaft: Vereinsregister)" },
  { key: "vatId", label: "Umsatzsteuer-Identifikationsnummer", required: false, max: 20, hint: "nur falls vorhanden" },
  { key: "additional", label: "Weitere Angaben", required: false, max: 2000, multiline: true, hint: "optional, z. B. inhaltlich Verantwortliche, Hinweise" },
];

export const EMPTY_IMPRESSUM: ImpressumFields = Object.fromEntries(IMPRESSUM_FIELD_KEYS.map((k) => [k, ""])) as ImpressumFields;

/** Beschriftungen der leeren Pflichtfelder (leer = vollständig). */
export function missingImpressumFields(f: ImpressumFields): string[] {
  return IMPRESSUM_FIELD_DEFS.filter((d) => d.required && !f[d.key]).map((d) => d.label);
}
