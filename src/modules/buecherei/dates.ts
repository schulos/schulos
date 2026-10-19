// Schulbücherei – Fristen (BU-02/BU-03): Fälligkeit und Abholfrist fallen nie auf ein Wochenende oder in eine Schließzeit.
import { and, gte, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { schoolClosures } from "@/core/db/schema";
import { addDays, weekdayMon0 } from "@/core/time";

/** Rein: erster Tag ab `ymd`, der kein Wochenende ist und in keiner Schließzeit (Ferien, Feiertag …) liegt. */
export function nextOpenDay(ymd: string, closures: readonly { startsOn: string; endsOn: string }[]): string {
  let d = ymd;
  for (let i = 0; i < 400; i++) {
    const closed = weekdayMon0(d) >= 5 || closures.some((c) => c.startsOn <= d && d <= c.endsOn);
    if (!closed) return d;
    d = addDays(d, 1);
  }
  return ymd;
}

/** Fälligkeit bzw. Abholfrist: heute + Tage, verschoben auf den nächsten Schultag (nie am Wochenende oder in den Ferien). */
export async function dueDate(db: Db, today: string, days: number): Promise<string> {
  const target = addDays(today, days);
  const closures = await db
    .select({ startsOn: schoolClosures.startsOn, endsOn: schoolClosures.endsOn })
    .from(schoolClosures)
    .where(and(lte(schoolClosures.startsOn, addDays(target, 400)), gte(schoolClosures.endsOn, target)));
  return nextOpenDay(target, closures);
}
