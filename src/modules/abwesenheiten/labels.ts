// Anzeigetexte der Abwesenheiten – rein, ohne DB.
import { TZ, fromBerlinLocal } from "@/core/time";

const shortDate = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", timeZone: TZ });
export const REASON_LABEL = { krank: "krank", sonstiges: "sonstiger Grund" } as const;
export const STATUS_LABEL = { gemeldet: "gemeldet", entschuldigt: "entschuldigt", nicht_entschuldigt: "nicht entschuldigt" } as const;

export function rangeLabel(from: string, to: string): string {
  const f = shortDate.format(fromBerlinLocal(from));
  return from === to ? f : `${f}–${shortDate.format(fromBerlinLocal(to))}`;
}
