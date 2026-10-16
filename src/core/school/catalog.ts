// Katalog der Bundesländer und weiterführenden Schulformen – reine Daten + Ableitungen, ohne DB.
// Alles hier ist Vorbelegung: Jahrgänge, Niveaus und Begriffe bleiben in der Verwaltung änderbar.

export const STATES = [
  { code: "BW", name: "Baden-Württemberg" },
  { code: "BY", name: "Bayern" },
  { code: "BE", name: "Berlin" },
  { code: "BB", name: "Brandenburg" },
  { code: "HB", name: "Bremen" },
  { code: "HH", name: "Hamburg" },
  { code: "HE", name: "Hessen" },
  { code: "MV", name: "Mecklenburg-Vorpommern" },
  { code: "NI", name: "Niedersachsen" },
  { code: "NW", name: "Nordrhein-Westfalen" },
  { code: "RP", name: "Rheinland-Pfalz" },
  { code: "SL", name: "Saarland" },
  { code: "SN", name: "Sachsen" },
  { code: "ST", name: "Sachsen-Anhalt" },
  { code: "SH", name: "Schleswig-Holstein" },
  { code: "TH", name: "Thüringen" },
] as const;
export type StateCode = (typeof STATES)[number]["code"];

/** Schulform-Typen. „sekundar“ fasst die integrierten Schulformen der Länder zusammen (Name je Land). */
export const SCHOOL_FORMS = ["gymnasium", "gesamtschule", "sekundar", "realschule", "hauptschule", "foerderschule"] as const;
export type SchoolForm = (typeof SCHOOL_FORMS)[number];

interface FormInfo {
  name: string;
  /** Kann eine gymnasiale Oberstufe haben */
  oberstufe: "immer" | "optional" | "nie";
  /** Kursniveaus in der Sek I (Fachleistungsdifferenzierung) */
  sek1Levels: string[];
  /** Pflichtstunden einer Vollzeitlehrkraft (vereinfacht nach NRW) */
  obligation: number;
}

const FORMS: Record<SchoolForm, FormInfo> = {
  gymnasium: { name: "Gymnasium", oberstufe: "immer", sek1Levels: [], obligation: 25.5 },
  gesamtschule: { name: "Gesamtschule", oberstufe: "optional", sek1Levels: ["E", "G"], obligation: 25.5 },
  sekundar: { name: "Sekundarschule", oberstufe: "optional", sek1Levels: ["E", "G"], obligation: 25.5 },
  realschule: { name: "Realschule", oberstufe: "nie", sek1Levels: [], obligation: 28 },
  hauptschule: { name: "Hauptschule", oberstufe: "nie", sek1Levels: [], obligation: 28 },
  foerderschule: { name: "Förderschule", oberstufe: "nie", sek1Levels: [], obligation: 27.5 },
};

/** Landesnamen, wo sie vom Typnamen abweichen */
const LOCAL_NAMES: Partial<Record<SchoolForm, Partial<Record<StateCode, string>>>> = {
  sekundar: {
    BW: "Gemeinschaftsschule",
    BE: "Integrierte Sekundarschule",
    BB: "Oberschule",
    HB: "Oberschule",
    HH: "Stadtteilschule",
    MV: "Regionale Schule",
    NI: "Oberschule",
    RP: "Realschule plus",
    SL: "Gemeinschaftsschule",
    SN: "Oberschule",
    ST: "Sekundarschule",
    SH: "Gemeinschaftsschule",
    TH: "Regelschule",
  },
  hauptschule: { BY: "Mittelschule", BW: "Werkrealschule" },
  gesamtschule: { HE: "Integrierte Gesamtschule", NI: "Integrierte Gesamtschule", RP: "Integrierte Gesamtschule" },
  foerderschule: { BW: "Sonderpädagogisches Bildungs- und Beratungszentrum", BY: "Förderzentrum" },
};

export function formName(form: SchoolForm, state: StateCode): string {
  return LOCAL_NAMES[form]?.[state] ?? FORMS[form].name;
}

export function formInfo(form: SchoolForm): FormInfo {
  return FORMS[form];
}

/** Erste Klasse der weiterführenden Schule: in Berlin und Brandenburg nach sechs Grundschuljahren die 7. */
export function firstGrade(state: StateCode): number {
  return state === "BE" || state === "BB" ? 7 : 5;
}

export interface SchoolProfile {
  state: StateCode;
  form: SchoolForm;
  /** Gymnasiale Oberstufe vorhanden (bei „immer“ zwingend) */
  oberstufe: boolean;
  /** Abitur nach 12 (G8) oder 13 (G9) Schuljahren */
  abitur: "g8" | "g9";
}

export interface GradeTemplate {
  /** Jahrgangsnummer (für Sortierung und Regeln) */
  level: number;
  code: string;
  name: string;
  stage: "sek1" | "oberstufe";
}

/** Jahrgänge aus dem Profil: Sek I bis Klasse 10 bzw. bis vor der Oberstufe, Oberstufe 3 Jahre. NRW benennt EF/Q1/Q2. */
export function gradeTemplate(p: SchoolProfile): GradeTemplate[] {
  const first = firstGrade(p.state);
  const hasOberstufe = FORMS[p.form].oberstufe === "immer" || (FORMS[p.form].oberstufe === "optional" && p.oberstufe);
  const abiturYear = p.abitur === "g8" ? 12 : 13;
  const lastSek1 = hasOberstufe ? abiturYear - 3 : 10;
  const out: GradeTemplate[] = [];
  for (let g = first; g <= lastSek1; g++) out.push({ level: g, code: String(g), name: `Jahrgang ${g}`, stage: "sek1" });
  if (hasOberstufe) {
    const nrw = p.state === "NW";
    const names = ["Einführungsphase", "Qualifikationsphase 1", "Qualifikationsphase 2"];
    ["EF", "Q1", "Q2"].forEach((code, i) => {
      const level = abiturYear - 2 + i;
      out.push({ level, code: nrw ? code : String(level), name: nrw ? names[i]! : `Jahrgang ${level} (${names[i]})`, stage: "oberstufe" });
    });
  }
  return out;
}

/** Kursniveaus: Sek I je nach Schulform, Oberstufe GK/LK */
export function levelTemplate(p: SchoolProfile): { sek1: string[]; oberstufe: string[] } {
  const hasOberstufe = gradeTemplate(p).some((g) => g.stage === "oberstufe");
  return { sek1: FORMS[p.form].sek1Levels, oberstufe: hasOberstufe ? ["GK", "LK"] : [] };
}

export const LEVEL_LABELS: Record<string, string> = { E: "Erweiterungskurs", G: "Grundkurs (Sek I)", A: "A-Kurs", B: "B-Kurs", C: "C-Kurs", GK: "Grundkurs", LK: "Leistungskurs" };

/** Begriffe, die von der Stufe abhängen */
export function terms(stage: "sek1" | "oberstufe") {
  return stage === "oberstufe" ? { leader: "Stufenleitung", exam: "Klausur" } : { leader: "Klassenleitung", exam: "Klassenarbeit" };
}

export function isStateCode(x: unknown): x is StateCode {
  return STATES.some((s) => s.code === x);
}
export function isSchoolForm(x: unknown): x is SchoolForm {
  return (SCHOOL_FORMS as readonly unknown[]).includes(x);
}

/** Schulformen mit Landesnamen für die Auswahl. Nicht jede Form gibt es in jedem Land – die Auswahl bleibt bewusst offen. */
export function formsForState(state: StateCode): { form: SchoolForm; name: string }[] {
  return SCHOOL_FORMS.map((form) => ({ form, name: formName(form, state) }));
}
