import type { Db } from "@/core/db/client";
import { defineSetting, gradeOptions, type ModuleSettingOption } from "@/core/modules/settings";

/** Eltern über Vertretungen/Entfall informieren bis Jahrgang (Q5-14, F-02): Vorgabe ganze Sek I, Oberstufe nie. */
export const PARENTS_SUBSTITUTION = defineSetting({
  key: "stundenplan.parents_substitution",
  label: "Eltern über Vertretungen und Entfall informieren",
  help: "Eltern minderjähriger Schüler:innen bekommen eine gebündelte Nachricht je Tag; die Oberstufe ist nie dabei.",
  options: gradeOptions(5, 10),
  default: "10",
});

/**
 * Vertretungsplan veröffentlichen (Q5-11, F-06): „sofort“ (Vorgabe, wie bisher) oder „erst nach Freigabe“ – dann ist ein
 * neuer Tag ein Entwurf, bis die Planung ihn veröffentlicht. Die Demo-Schule steht auf „Freigabe“.
 */
export const SUBSTITUTION_RELEASE = defineSetting({
  key: "stundenplan.substitution_release",
  label: "Vertretungsplan veröffentlichen",
  help: "„Erst nach Freigabe“: Änderungen eines neuen Tages sind ein Entwurf, bis die Planung den Tag veröffentlicht – dann geht je Person eine Nachricht raus. Spätere Änderungen an einem veröffentlichten Tag gelten sofort.",
  options: [
    { value: "sofort", label: "sofort" },
    { value: "freigabe", label: "erst nach Freigabe" },
  ],
  default: "sofort",
});

/**
 * VT-01 (F-10-10, Projektleitung 2026-10-26): Kenntnisnahme durch die Vertretungslehrkraft – optional, Vorgabe an, ohne Eskalation.
 * „aus“: Lehrkräfte bekommen keinen Knopf „Gesehen“, die Planung keine Liste Unbestätigter.
 */
export const SUBSTITUTION_ACK = defineSetting({
  key: "stundenplan.substitution_ack",
  label: "Kenntnisnahme von Vertretungen",
  help: "Vertretungslehrkräfte bestätigen eine Vertretung mit einem Klick („Gesehen“); die Planung sieht, wer noch nicht bestätigt hat. Keine Pflicht, keine Eskalation.",
  options: [
    { value: "an", label: "an" },
    { value: "aus", label: "aus" },
  ],
  default: "an",
});

/** VT-04: Uhrzeiten in halben Stunden von `from` bis `to` („HH:MM“) als Optionen. */
function timeOptions(from: number, to: number): ModuleSettingOption[] {
  const out: ModuleSettingOption[] = [];
  for (let m = from * 60; m <= to * 60; m += 30) {
    const hm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    // Wert ohne Doppelpunkt (Schulprofil-Export erlaubt in Optionswerten nur Buchstaben, Ziffern, _ und -): „1800“ = 18:00
    out.push({ value: hm.replace(":", ""), label: `${hm} Uhr` });
  }
  return out;
}

/** VT-04: Lernende/Eltern „wie bei Lehrkräften“ (Vorgabe, F-10-11) oder eigener Wert. */
export const SAME_AS_TEACHERS = "wie_lehrkraefte";
const same: ModuleSettingOption = { value: SAME_AS_TEACHERS, label: "wie bei Lehrkräften" };
const noQuiet: ModuleSettingOption = { value: "aus", label: "keine Ruhezeit" };
// geänderte Uhrzeiten gelten auch für schon eingereihte Nachrichten (dynamischer Import: benachrichtigung.ts liest diese Datei)
const onChange = async (db: Db) => {
  const { reschedulePending } = await import("./benachrichtigung");
  await reschedulePending(db);
};

/** VT-04 (F-10-11): Uhrzeit der Vortags-Nachricht an Lehrkräfte (Vorgabe 18:00). */
export const NOTIFY_EVE_TIME = defineSetting({
  key: "stundenplan.notify_eve_time",
  label: "Vertretungsnachricht am Vortag – Lehrkräfte",
  help: "Änderungen für morgen und später gehen gebündelt am Vortag zu dieser Uhrzeit raus (nur der Endstand); spätere Änderungen sofort, Änderungen für heute sofort. Der Vertretungsplan selbst ist immer gleich sichtbar.",
  options: timeOptions(14, 21),
  default: "1800",
  onChange,
});
export const QUIET_FROM = defineSetting({
  key: "stundenplan.quiet_from",
  label: "Ruhezeit ab – Lehrkräfte",
  help: "In der Ruhezeit gehen keine Vertretungsnachrichten raus; sie warten bis zum Ende der Ruhezeit.",
  options: [noQuiet, ...timeOptions(18, 23)],
  default: "2000",
  onChange,
});
export const QUIET_UNTIL = defineSetting({
  key: "stundenplan.quiet_until",
  label: "Ruhezeit bis – Lehrkräfte",
  options: timeOptions(5, 8),
  default: "0630",
  onChange,
});
export const NOTIFY_EVE_TIME_STUDENTS = defineSetting({
  key: "stundenplan.notify_eve_time_students",
  label: "Vertretungsnachricht am Vortag – Schüler:innen und Eltern",
  options: [same, ...timeOptions(14, 21)],
  default: SAME_AS_TEACHERS,
  onChange,
});
export const QUIET_FROM_STUDENTS = defineSetting({
  key: "stundenplan.quiet_from_students",
  label: "Ruhezeit ab – Schüler:innen und Eltern",
  options: [same, noQuiet, ...timeOptions(18, 23)],
  default: SAME_AS_TEACHERS,
  onChange,
});
export const QUIET_UNTIL_STUDENTS = defineSetting({
  key: "stundenplan.quiet_until_students",
  label: "Ruhezeit bis – Schüler:innen und Eltern",
  options: [same, ...timeOptions(5, 8)],
  default: SAME_AS_TEACHERS,
  onChange,
});

export const SEND_TIME_SETTINGS = [NOTIFY_EVE_TIME, QUIET_FROM, QUIET_UNTIL, NOTIFY_EVE_TIME_STUDENTS, QUIET_FROM_STUDENTS, QUIET_UNTIL_STUDENTS];

export const STUNDENPLAN_SETTINGS = [PARENTS_SUBSTITUTION, SUBSTITUTION_RELEASE, SUBSTITUTION_ACK, ...SEND_TIME_SETTINGS];
