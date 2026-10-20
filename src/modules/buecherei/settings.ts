import { defineSetting, type ModuleSettingDecl } from "@/core/modules/settings";
import { ISBN_SETTINGS } from "./isbn";
import { MEDIA_TYPE_LABELS, MEDIA_TYPES, type MediaType } from "./labels";

// Schulbücherei – Moduleinstellungen (BU-02): Leihfrist je Medienart und wie oft verlängert werden darf. Keine Löschfristen –
// die Ausleihe verliert den Personenbezug bei der Rückgabe (docs/BUECHEREI.md, DATENSCHUTZ §3.4).

const LOAN_DAY_CHOICES = [7, 14, 21, 28, 42, 56] as const;

/** Vorgabe-Leihfrist in Tagen je Medienart. */
export const DEFAULT_LOAN_DAYS: Record<MediaType, number> = { buch: 28, film: 14, spiel: 14, geraet: 7, sonstiges: 14 };

const dayLabel = (d: number) => (d % 7 === 0 ? (d === 7 ? "1 Woche" : `${d / 7} Wochen`) : `${d} Tage`);

/** Leihfrist je Medienart (`buecherei.loan_days_<art>`). */
function loanDaysSetting(m: MediaType): ModuleSettingDecl {
  return defineSetting({
    key: `buecherei.loan_days_${m}`,
    label: `Leihfrist ${MEDIA_TYPE_LABELS[m]}`,
    help: "Fällig ist der letzte Tag der Frist; fällt er auf ein Wochenende oder in die Ferien, gilt der nächste Schultag.",
    options: LOAN_DAY_CHOICES.map((d) => ({ value: String(d), label: dayLabel(d) })),
    default: String(DEFAULT_LOAN_DAYS[m]),
  });
}

export const LOAN_DAYS: Record<MediaType, ModuleSettingDecl> = {
  buch: loanDaysSetting("buch"),
  film: loanDaysSetting("film"),
  spiel: loanDaysSetting("spiel"),
  geraet: loanDaysSetting("geraet"),
  sonstiges: loanDaysSetting("sonstiges"),
};

/** Wie oft eine Ausleihe höchstens verlängert werden darf (`buecherei.max_renewals`). */
export const MAX_RENEWALS = defineSetting({
  key: "buecherei.max_renewals",
  label: "Verlängerungen je Ausleihe",
  help: "Jede Verlängerung beginnt die Leihfrist ab dem Tag der Verlängerung neu; vorgemerkte Titel lassen sich nicht verlängern.",
  options: [
    { value: "0", label: "keine" },
    { value: "1", label: "1-mal" },
    { value: "2", label: "2-mal" },
    { value: "3", label: "3-mal" },
    { value: "5", label: "5-mal" },
  ],
  default: "2",
});

/** BU-03: Wie lange ein zurückgekommenes Exemplar für die vormerkende Person bereitliegt (`buecherei.hold_days`). */
export const HOLD_DAYS = defineSetting({
  key: "buecherei.hold_days",
  label: "Abholfrist bei Vormerkungen",
  help: "So lange liegt ein zurückgegebenes Exemplar für die Person bereit, die es vorgemerkt hat (letzter Tag auf den nächsten Schultag verschoben). Danach rückt die nächste Vormerkung nach.",
  options: [3, 5, 7, 10, 14].map((d) => ({ value: String(d), label: dayLabel(d) })),
  default: "7",
});

/** BU-03: Wie viele Titel eine Person gleichzeitig vormerken kann (`buecherei.max_reservations`). */
export const MAX_RESERVATIONS = defineSetting({
  key: "buecherei.max_reservations",
  label: "Vormerkungen je Person",
  help: "Höchstzahl gleichzeitiger Vormerkungen; „keine“ schaltet das Vormerken aus.",
  options: [
    { value: "0", label: "keine" },
    { value: "3", label: "3" },
    { value: "5", label: "5" },
    { value: "10", label: "10" },
  ],
  default: "5",
});

/** BU-04: Erinnerung vor Fristende – so viele Tage vor der Fälligkeit (`buecherei.remind_days`, „0“ = aus). */
export const REMIND_DAYS = defineSetting({
  key: "buecherei.remind_days",
  label: "Erinnerung vor Fristende",
  help: "Benachrichtigung an die ausleihende Person, so viele Tage vor der Fälligkeit (ohne Titel – welche Medien, steht unter „Meine Ausleihen“).",
  options: [
    { value: "0", label: "aus" },
    { value: "1", label: "1 Tag vorher" },
    { value: "2", label: "2 Tage vorher" },
    { value: "3", label: "3 Tage vorher" },
    { value: "5", label: "5 Tage vorher" },
  ],
  default: "2",
});

/** BU-04: Abstand der Mahnstufen in Tagen (`buecherei.dunning_days`). */
export const DUNNING_DAYS = defineSetting({
  key: "buecherei.dunning_days",
  label: "Abstand der Mahnungen",
  help: "Die 1. Mahnung geht am ersten Schultag nach der Fälligkeit raus, die 2. und 3. jeweils frühestens so viele Tage nach der vorigen – nur an Schultagen. Ab der 2. Mahnung werden bei Minderjährigen auch die Eltern benachrichtigt.",
  options: [3, 7, 10, 14].map((d) => ({ value: String(d), label: dayLabel(d) })),
  default: "7",
});

/** BU-04: Mahnungen zusätzlich per Mail (`buecherei.dunning_mail`, Vorgabe aus) – nur an bestätigte Adressen. */
export const DUNNING_MAIL = defineSetting({
  key: "buecherei.dunning_mail",
  label: "Mahnungen auch per Mail",
  help: "Zusätzlich zur Benachrichtigung eine Mail an bestätigte Adressen (ausleihende Person, ab der 2. Mahnung die Eltern Minderjähriger) – ohne Titel, nur mit Link zur Anmeldung. Braucht eingerichteten Mailversand.",
  options: [
    { value: "0", label: "aus" },
    { value: "1", label: "an" },
  ],
  default: "0",
});

/**
 * BU-10: Stufe 2 – Schulbuchausleihe (Lernmittel) zuschalten (`buecherei.lernmittel`, Vorgabe aus; Entscheidung 1 in
 * docs/BUECHEREI.md). Aus: keine Lernmittel-Seiten, keine Bücherliste; vorhandene Lernmittel bleiben gespeichert.
 */
export const LERNMITTEL = defineSetting({
  key: "buecherei.lernmittel",
  label: "Schulbuchausleihe (Lernmittel)",
  help: "Lernmittel je Jahrgang und Fach mit Inventarnummern pflegen und Bücherlisten für Eltern veröffentlichen. Für Schulen, die Schulbücher über die Bücherei ausleihen.",
  options: [
    { value: "0", label: "aus" },
    { value: "1", label: "an" },
  ],
  default: "0",
});

export const BUECHEREI_SETTINGS: readonly ModuleSettingDecl[] = [
  ...MEDIA_TYPES.map((m) => LOAN_DAYS[m]),
  MAX_RENEWALS,
  HOLD_DAYS,
  MAX_RESERVATIONS,
  REMIND_DAYS,
  DUNNING_DAYS,
  DUNNING_MAIL,
  ...ISBN_SETTINGS,
  LERNMITTEL,
];
