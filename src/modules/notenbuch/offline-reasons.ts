// Notenbuch (P5-20): reine Entscheidung „darf dieses Gerät einen Offline-Cache führen?“ und die Texte dazu – ohne DB, damit
// Server (offline.ts) und Browser (offline.tsx) dieselbe Logik und Wortwahl nutzen.
import type { CertCheck } from "@/core/device-certs/policy";
import type { ExternalZone } from "@/core/external-access";
import type { OfflineMode } from "./settings";

export type OfflineReason =
  /** Moduleinstellung aus */
  | "aus"
  /** Gerät mit gültigem Gerätezertifikat */
  | "zertifikat"
  /** im Schulnetz, nach Einstellung „Schulnetz“ (Bestätigung je Gerät nötig) */
  | "schulnetz"
  /** nur mit Gerätezertifikat erlaubt, keins vorgezeigt (im Schulnetz nicht erkennbar) */
  | "kein-zertifikat"
  /** von außen ohne Gerätezertifikat: Privatgerät */
  | "privatgeraet";

export interface OfflineDecision {
  allowed: boolean;
  reason: OfflineReason;
  mode: OfflineMode;
}

const certValid = (c: CertCheck) => c === "gueltig" || c === "gebunden";

/**
 * Rein: nach Einstellung, Zone der Anfrage (Kennzeichen von Caddy) und Zertifikatsprüfung. Ein gültiges, freigegebenes
 * Gerätezertifikat zählt immer (nur von außen sichtbar – im Schulnetz prüft Caddy keine Client-Zertifikate); „Schulnetz“ nur,
 * wenn die Schule es eingestellt hat. Von außen ohne Zertifikat (Privatgerät) nie. Im Zweifel nein.
 */
export function decideOffline(mode: OfflineMode, zone: ExternalZone, cert: CertCheck): OfflineDecision {
  if (mode === "aus") return { allowed: false, reason: "aus", mode };
  if ((zone === "geraet" || zone === "alles") && certValid(cert)) return { allowed: true, reason: "zertifikat", mode };
  if (zone === "intern") return mode === "schulnetz" ? { allowed: true, reason: "schulnetz", mode } : { allowed: false, reason: "kein-zertifikat", mode };
  return { allowed: false, reason: "privatgeraet", mode };
}

/** Text für die Seite – nennt nie Details des Zertifikats. */
export const OFFLINE_REASON_TEXT: Record<OfflineReason, string> = {
  aus: "Die Schule hat die Offline-Eingabe ausgeschaltet.",
  zertifikat: "Dieses Gerät ist mit Gerätezertifikat der Schule angemeldet.",
  schulnetz: "Dieses Gerät ist im Schulnetz.",
  "kein-zertifikat": "Offline-Eingabe gibt es nur auf Geräten mit Gerätezertifikat der Schule (von außerhalb des Schulnetzes angemeldet).",
  privatgeraet: "Von außerhalb des Schulnetzes ohne Gerätezertifikat gibt es keinen Offline-Zwischenspeicher – auf Privatgeräten bleibt nichts im Browser.",
};
