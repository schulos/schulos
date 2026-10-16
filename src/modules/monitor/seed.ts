// Demo-Monitore mit festen Adressen, damit man den Kiosk ohne Einrichtung ansehen kann.
import type { Db } from "@/core/db/client";
import { monitorScreens } from "@/core/db/schema";
import { hashToken } from "./service";

/** Nur Demo! Eine echte Schule erzeugt die Adressen in der Verwaltung (zufällig, nur einmal sichtbar). */
export const DEMO_MONITOR_TOKENS = { foyer: "demo-foyer-lindenhof-2026", lehrerzimmer: "demo-lehrerzimmer-lindenhof-2026" } as const;

export async function seedMonitor(db: Db) {
  await db.insert(monitorScreens).values([
    { name: "Foyer Hauptgebäude", location: "Eingangshalle", profile: "foyer", tokenHash: hashToken(DEMO_MONITOR_TOKENS.foyer) },
    { name: "Lehrerzimmer", location: "Hauptgebäude, 1. OG", profile: "lehrerzimmer", tokenHash: hashToken(DEMO_MONITOR_TOKENS.lehrerzimmer) },
  ]);
}
