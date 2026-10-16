import { dayOptions, defineSetting } from "@/core/modules/settings";

/** Direktchats unter Schüler:innen (Q5-14, I-60) – Vorgabe: nur innerhalb der eigenen Klasse. */
export const STUDENT_DIRECT = defineSetting({
  key: "messenger.student_direct",
  label: "Direktchats unter Schüler:innen",
  help: "Gilt für neue und bestehende Direktchats zwischen zwei Schüler:innen; Chats mit Lehrkräften und Gruppenchats bleiben unberührt.",
  options: [
    { value: "aus", label: "aus" },
    { value: "klasse", label: "nur innerhalb der eigenen Klasse" },
    { value: "gruppen", label: "mit allen aus gemeinsamen Gruppen (Klasse, Kurse, AGs)" },
  ],
  default: "klasse",
});

/**
 * Chats von Schüler:innen und Eltern mit der Schulsozialarbeit (Rolle `beratung`, Q5-17): erst nach Votum der/des
 * Datenschutzbeauftragten (DSB-FRAGEN §8) – Vorgabe aus. Auch eingeschaltet beginnen nur Schüler:innen/Eltern den Chat.
 */
export const COUNSELING_CHAT = defineSetting({
  key: "messenger.counseling_chat",
  label: "Chats mit der Schulsozialarbeit (Rolle Beratung)",
  help: "Erst nach Rücksprache mit der/dem Datenschutzbeauftragten einschalten. Nur zur Terminabsprache; den Chat beginnen Schüler:innen bzw. Eltern.",
  options: [
    { value: "aus", label: "aus – nur Kontaktangaben im Adressbuch" },
    { value: "an", label: "an – Schüler:innen und Eltern können schreiben" },
  ],
  default: "aus",
});

/**
 * DS-15: Chatnachrichten und Direktchats aufbewahren (LK-1J). Kommunikation ist keine Akte – länger als ein Jahr lässt
 * SchulOS nicht zu (strenger als die Grenze der Löschklasse), kürzer nach Entscheidung der Schule.
 */
export const MESSAGE_KEEP = defineSetting({
  key: "messenger.keep_days",
  label: "Chatnachrichten aufbewahren",
  help: "Nachrichten ab dem Senden, Direktchats ab der letzten Nachricht; Gruppenchats gehen zusätzlich mit der Gruppe.",
  options: dayOptions([90, 180, 365], 365),
  default: "365",
  permission: "verwaltung.privacy",
});

/** DS-15: Chats mit der Schulsozialarbeit (LK-90, DSB-FRAGEN §8b) – Vorgabe 90 Tage nach der letzten Nachricht. */
export const COUNSELING_KEEP = defineSetting({
  key: "messenger.counseling_keep_days",
  label: "Chats mit der Schulsozialarbeit aufbewahren",
  help: "Gerechnet ab der letzten Nachricht; die Nachrichten gehen mit dem Chat.",
  options: dayOptions([30, 60, 90], 90),
  default: "90",
  permission: "verwaltung.privacy",
});

export const MESSENGER_SETTINGS = [STUDENT_DIRECT, COUNSELING_CHAT, MESSAGE_KEEP, COUNSELING_KEEP];
