// VT-04 (F-10-11): Wann geht die Vertretungsnachricht raus? Reine Zeitlogik in Berliner Ortszeit (Europe/Berlin), unabhängig von der
// Zeitzone des Servers; Sommerzeit-Umstellung über `fromBerlinLocal`. Regeln (Projektleitung 2026-10-26, Vorgaben VT-04):
// - vergangener Tag (rückwirkende Korrektur) → sofort, auch in der Ruhezeit (niemand muss mehr handeln, die Nachricht dokumentiert nur);
// - heute → sofort, in der Ruhezeit zum Ende der Ruhezeit;
// - später → am Vortag zur Vortags-Uhrzeit; ist die schon vorbei → sofort; fällt der Zeitpunkt in die Ruhezeit → Ende der Ruhezeit.
import { addDays, fromBerlinLocal, toBerlinDate, toBerlinLocal } from "@/core/time";

export interface SendWindow {
  /** Vortags-Uhrzeit „HH:MM“ */
  eve: string;
  /** Ruhezeit von/bis „HH:MM“ (über Mitternacht erlaubt); gleich = keine Ruhezeit */
  quietFrom: string;
  quietUntil: string;
}

export const DEFAULT_WINDOW: SendWindow = { eve: "18:00", quietFrom: "20:00", quietUntil: "06:30" };

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHm = (v: string) => HM.test(v);

/** Liegt die Uhrzeit „HH:MM“ in der Ruhezeit [von, bis)? Über Mitternacht (20:00–06:30) wie am Tag (12:00–14:00). */
export function inQuietTime(hm: string, w: Pick<SendWindow, "quietFrom" | "quietUntil">): boolean {
  const { quietFrom: from, quietUntil: until } = w;
  if (from === until) return false;
  return from < until ? hm >= from && hm < until : hm >= from || hm < until;
}

/** Nächstes Ende der Ruhezeit nach `t` (echter Zeitpunkt, Sommerzeit-fest). */
export function quietEndAfter(t: Date, w: Pick<SendWindow, "quietUntil">): Date {
  const day = toBerlinDate(t);
  const same = fromBerlinLocal(`${day}T${w.quietUntil}`);
  return same.getTime() > t.getTime() ? same : fromBerlinLocal(`${addDays(day, 1)}T${w.quietUntil}`);
}

/** Zeitpunkt in die Ruhezeit? → auf ihr Ende schieben. */
export function outsideQuiet(t: Date, w: SendWindow): Date {
  return inQuietTime(toBerlinLocal(t).slice(11), w) ? quietEndAfter(t, w) : t;
}

/** Vortags-Termin eines Vertretungstags („2026-10-28“ → 27.10., 18:00 Berliner Zeit). */
export function eveOf(dateYmd: string, w: Pick<SendWindow, "eve">): Date {
  return fromBerlinLocal(`${addDays(dateYmd, -1)}T${w.eve}`);
}

/**
 * Sendezeitpunkt für eine Änderung am Vertretungstag `dateYmd`, eingereiht um `queuedAt`. Monoton: späteres Einreihen ergibt nie einen
 * früheren Zeitpunkt – darum bleibt beim erneuten Einreihen der erste offene Eintrag maßgeblich.
 */
export function plannedSendAt(dateYmd: string, queuedAt: Date, w: SendWindow): Date {
  const today = toBerlinDate(queuedAt);
  if (dateYmd < today) return queuedAt;
  if (dateYmd === today) return outsideQuiet(queuedAt, w);
  const eve = eveOf(dateYmd, w);
  return outsideQuiet(eve.getTime() > queuedAt.getTime() ? eve : queuedAt, w);
}

/**
 * VT-02/VT-04: Stichzeitpunkt der Marker „neu/geändert“ – der letzte Vortags-Termin (Uhrzeit `eve`) vor `now`, als Berliner Ortszeit
 * „YYYY-MM-DDTHH:MM“. Bis kurz vor der Uhrzeit gilt der Termin von gestern.
 */
export function lastEveLocal(nowLocal: string, eve: string): string {
  const day = nowLocal.slice(0, 10);
  return nowLocal.slice(11, 16) >= eve ? `${day}T${eve}` : `${addDays(day, -1)}T${eve}`;
}
