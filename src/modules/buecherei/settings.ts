import { defineSetting, type ModuleSettingDecl } from "@/core/modules/settings";
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

export const BUECHEREI_SETTINGS: readonly ModuleSettingDecl[] = [...MEDIA_TYPES.map((m) => LOAN_DAYS[m]), MAX_RENEWALS];
