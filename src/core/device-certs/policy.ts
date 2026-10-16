// Wer darf von außen eine Sitzung haben? (P4-40b, SICHERHEIT.md S27/S28) – reine Entscheidung ohne DB, vollständig getestet.
// Eingaben: Zone der Anfrage (Kennzeichen von Caddy, src/core/external-access.ts), Rolle des Kontos, Prüfergebnis des
// Gerätezertifikats und die Schuleinstellungen. Alles, was nicht ausdrücklich erlaubt ist, wird abgelehnt.
import type { ExternalZone } from "@/core/external-access";
import { ROLES } from "@/core/roles";

/** Rollen, die als „Personal“ gelten: von außen nur mit gültigem Gerätezertifikat (wenn die Schule es verlangt) */
export const STAFF_ROLES: readonly string[] = ["lehrkraft", "personal", "beratung", "verwaltung", "admin"];
/** von außen grundsätzlich gesperrt, solange die Schule es nicht ausdrücklich erlaubt */
export const ADMIN_ROLES: readonly string[] = ["verwaltung", "admin"];

/**
 * Prüfergebnis des Gerätezertifikats einer Anfrage: `gebunden` = gültig und an genau dieses Konto gebunden, `gueltig` = gültig,
 * aber an kein Konto gebunden (Gerät der Schule für beliebige Konten)
 */
export type CertCheck = "gebunden" | "gueltig" | "fehlt" | "ungueltig";

const certValid = (c: CertCheck) => c === "gueltig" || c === "gebunden";

export interface ExternalPolicy {
  /** Personal (Lehrkräfte, Personal, Verwaltung, Admin) von außen nur mit gültigem Gerätezertifikat */
  staffCertRequired: boolean;
  /** Verwaltung/Admin dürfen sich von außen überhaupt anmelden (Vorgabe: nein) */
  adminAllowed: boolean;
}

/** gespeicherte Schuleinstellung (app_settings) – `null` = Vorgabe */
export interface ExternalSettings {
  staffCert: "an" | "aus" | null;
  adminAllowed: boolean | null;
}

/**
 * Wirksame Regeln: Zertifikatspflicht für Personal per Vorgabe **an, sobald die Schul-CA eingerichtet ist**
 * (`SCHULOS_DEVICE_CERTS=an`); Verwaltung/Admin per Vorgabe von außen gesperrt.
 */
export function effectivePolicy(settings: ExternalSettings, caConfigured: boolean): ExternalPolicy {
  return {
    staffCertRequired: settings.staffCert === null ? caConfigured : settings.staffCert === "an",
    adminAllowed: settings.adminAllowed === true,
  };
}

export type ExternalDenyReason =
  /** von außen ohne Freigabe (nur öffentliche Seiten) */
  | "kein-zugang"
  /** Gerätezertifikat fehlt, ist gesperrt, abgelaufen, unbekannt oder an ein anderes Konto gebunden */
  | "zertifikat"
  /** Rolle ist von außen gesperrt (Verwaltung/Admin) oder unbekannt */
  | "rolle";

export type ExternalDecision = { allowed: true } | { allowed: false; reason: ExternalDenyReason };

const deny = (reason: ExternalDenyReason): ExternalDecision => ({ allowed: false, reason });

/** Darf dieses Konto in dieser Zone eine Sitzung nutzen bzw. bekommen? */
export function decideExternalAccess(input: { zone: ExternalZone; role: string; cert: CertCheck; policy: ExternalPolicy }): ExternalDecision {
  const { zone, role, cert, policy } = input;
  if (zone === "intern") return { allowed: true };
  // nur Allowlist (P4-40) – Cookies entfernt der Proxy ohnehin; falls doch eine Sitzung ankäme: keine
  if (zone !== "alles" && zone !== "geraet") return deny("kein-zugang");
  if (!(ROLES as readonly string[]).includes(role)) return deny("rolle");
  // durchgelassen nur wegen des Zertifikats → ohne gültiges, freigegebenes Zertifikat für niemanden
  if (zone === "geraet" && !certValid(cert)) return deny("zertifikat");
  if (ADMIN_ROLES.includes(role) && !policy.adminAllowed) return deny("rolle");
  if (STAFF_ROLES.includes(role) && policy.staffCertRequired && !certValid(cert)) return deny("zertifikat");
  // GATE-4c: öffnet das Zertifikat Verwaltung/Admin die Tür, muss es an genau dieses Konto gebunden sein – ein ungebundenes
  // Schulgerät plus irgendein abgegriffenes Verwaltungspasswort reicht sonst
  if (ADMIN_ROLES.includes(role) && (zone === "geraet" || policy.staffCertRequired) && cert !== "gebunden") return deny("zertifikat");
  return { allowed: true };
}

/** Text für Menschen (Anmeldeseite, API-Antwort) – nennt nie, ob das Passwort stimmte */
export const DENY_TEXT: Record<ExternalDenyReason, string> = {
  "kein-zugang": "Von außerhalb des Schulnetzes ist hier keine Anmeldung möglich.",
  zertifikat: "Von außerhalb des Schulnetzes nur auf einem freigegebenen Gerät (Gerätezertifikat der Schule).",
  rolle: "Dieses Konto ist nur im Schulnetz nutzbar.",
};
