// SEC-01/P4-71: Anmelde-Einstellungen der Schule (Verwaltung → System → Anmeldung): Schulnetz, Stichtag der 2FA-Pflicht, Inaktivität.
// Ändern nur mit `verwaltung.system` und nur aus dem Schulnetz – wer von außen Admin-Rechte hätte, soll sich die Tür nicht selbst
// öffnen (wie die Regeln für Gerätezertifikate, P4-40b).
import { eq } from "drizzle-orm";
import { checkNet } from "@schulos/server/ssh-netz";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { readSecuritySettings, SECURITY_KEYS } from "@/core/settings";
import { isCalendarDate } from "@/core/time";
import { defaultSchoolNets, ipInNets, parseNetList, type NetworkZone } from "./schulnetz";
import { IDLE_OPTIONS } from "./sitzungen";

export class SecuritySettingsError extends Error {
  /** G4E-C02: die eigene Adresse läge außerhalb der neuen Bereiche – Speichern nur mit ausdrücklicher Bestätigung */
  constructor(
    message: string,
    readonly ownAddressOutside: string | null = null,
  ) {
    super(message);
  }
}

export interface SecuritySettingsRequest {
  /** Client-Adresse dieser Anfrage (`forwardedClientIp`), null ohne Proxy-Angabe */
  clientIp?: string | null;
  /** „Trotzdem speichern“: die eigene Adresse liegt danach außerhalb des Schulnetzes */
  confirmOwnAddressOutside?: boolean;
}

export interface SecuritySettingsInput {
  /** Schulnetz-Bereiche als Text; leer = Vorgabe (SCHULOS_INTERNAL_NETS bzw. alle privaten Bereiche) */
  schoolNets: string;
  /** Stichtag der 2FA-Pflicht für Lehrkräfte, Personal und Eltern (YYYY-MM-DD) */
  twoFactorFrom: string;
  /** P4-71: Inaktivitätsablauf in Minuten (0 = aus), nur Stufen aus IDLE_OPTIONS */
  idleMinutes: number;
}

async function put(db: Db, key: string, value: unknown): Promise<void> {
  if (value === null) await db.delete(appSettings).where(eq(appSettings.key, key));
  else
    await db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: new Date() },
      });
}

/** G4E-O06: Bereiche normiert (Netzadresse statt gesetzter Host-Bits, einheitliche Schreibweise); `private_ranges` bleibt */
export function normalizeNetText(text: string): string {
  return text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((e) => {
      if (e === "private_ranges") return e;
      const c = checkNet(e);
      return c.ok ? c.net : (c.suggestion ?? e);
    })
    .join(" ");
}

/** Höchstens so viele Bereiche (Schutz vor Unsinn; Schulen haben eine Handvoll) */
export const MAX_NETS = 50;

/**
 * G4E-C02: Ändern nur im Schulnetz – und die eigene Adresse muss in den **neuen** Bereichen liegen (sonst sperrt man sich selbst aus:
 * danach gälte man als „außen“ und könnte nichts mehr zurückdrehen), außer mit ausdrücklicher Bestätigung. Rettungsweg:
 * `node cli.mjs schulnetz-zuruecksetzen` bzw. `reset-admin` (setzt die Bereiche auf die Vorgabe).
 */
export async function saveSecuritySettings(
  db: Db,
  actorId: string,
  network: NetworkZone,
  input: SecuritySettingsInput,
  req: SecuritySettingsRequest = {},
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (network !== "schulnetz") throw new SecuritySettingsError("Diese Einstellungen lassen sich nur im Schulnetz ändern.");
  const text = input.schoolNets.trim();
  const { nets, errors } = parseNetList(text);
  if (errors.length)
    throw new SecuritySettingsError(
      `Kein gültiger Bereich: ${errors.slice(0, 3).join(", ")} – bitte z. B. 10.0.0.0/8 oder 192.168.10.0/24 eintragen.`,
    );
  if (nets.length > MAX_NETS) throw new SecuritySettingsError(`Höchstens ${MAX_NETS} Bereiche.`);
  const effective = text ? nets : parseNetList(defaultSchoolNets(env)).nets;
  if (req.clientIp && !ipInNets(req.clientIp, effective) && !req.confirmOwnAddressOutside)
    throw new SecuritySettingsError(
      `Deine Adresse ${req.clientIp} liegt nicht in den neuen Bereichen – danach könntest du diese Einstellungen nicht mehr ändern. Bereiche prüfen oder ausdrücklich bestätigen.`,
      req.clientIp,
    );
  if (!isCalendarDate(input.twoFactorFrom)) throw new SecuritySettingsError("Bitte einen Stichtag für die Zwei-Faktor-Pflicht wählen.");
  if (!(IDLE_OPTIONS as readonly number[]).includes(input.idleMinutes)) throw new SecuritySettingsError("Bitte eine Stufe für die Abmeldung nach Inaktivität wählen.");
  const before = await readSecuritySettings(db);
  // G4E-O06: Bereiche normiert speichern (10.10.0.5/24 → 10.10.0.0/24) – gemeint ist das Netz; so zeigt die Seite, was gilt
  await put(db, SECURITY_KEYS.schoolNets, text ? normalizeNetText(text) : null);
  await put(db, SECURITY_KEYS.twoFactorFrom, input.twoFactorFrom);
  await put(db, SECURITY_KEYS.idleMinutes, input.idleMinutes || null);
  await audit(db, actorId, "verwaltung.anmeldung.einstellungen", null, {
    schulnetz: text ? "eigene Bereiche" : "Vorgabe",
    ...(req.clientIp && !ipInNets(req.clientIp, effective) ? { eigeneAdresseAussen: true } : {}),
    ...(before.twoFactorFrom !== input.twoFactorFrom ? { zweiFaktorAb: input.twoFactorFrom } : {}),
    ...(before.idleMinutes !== input.idleMinutes ? { inaktivMinuten: input.idleMinutes } : {}),
  });
}

/**
 * G4E-C02: Rettungsweg, falls die Bereiche die Verwaltung ausgesperrt haben – Schulnetz-Bereiche zurück auf die Vorgabe
 * (`SCHULOS_INTERNAL_NETS` bzw. alle privaten Bereiche). Für die Kommandozeile (`node cli.mjs schulnetz-zuruecksetzen`,
 * `reset-admin`). Liefert, ob eigene Bereiche eingetragen waren.
 */
export async function resetSchoolNets(db: Db, actorId: string | null = null): Promise<boolean> {
  const removed = await db.delete(appSettings).where(eq(appSettings.key, SECURITY_KEYS.schoolNets)).returning({ key: appSettings.key });
  if (removed.length) await audit(db, actorId, "verwaltung.anmeldung.schulnetz_zurueckgesetzt", null, { via: "kommandozeile" });
  return removed.length > 0;
}
