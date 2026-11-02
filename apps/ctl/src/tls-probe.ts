// BM-04: Ablauf des Zertifikats, das der Reverse-Proxy ausliefert – schulosctl verbindet sich lokal mit dem HTTPS-Port und liest
// das Ablaufdatum. Schlägt etwas fehl, bleibt der Wert unbekannt (null).
// CA-08: zusätzlich Ausstellungsdatum, Aussteller und ob Kette (öffentliche Wurzeln von Node) und Name der Domain passen – für
// die Warnung „Erneuerung überfällig“ und die Abschlussprüfung der DNS-Prüfung (`schulosctl zertifikat-pruefen`).
import { checkServerIdentity, connect, type PeerCertificate } from "node:tls";
import type { TlsInfo } from "@schulos/server/system";

export interface TlsProbeTarget {
  host: string;
  port: number;
  servername: string;
}

/** Ziel aus der `.env` des Stacks: SCHULOS_DOMAIN (Vorgabe localhost) und SCHULOS_HTTPS_PORT (Vorgabe 443). */
export function tlsTargetFromEnv(env: Record<string, string | undefined>): TlsProbeTarget {
  const port = Number(env.SCHULOS_HTTPS_PORT);
  return { host: "127.0.0.1", port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 443, servername: env.SCHULOS_DOMAIN?.trim() || "localhost" };
}

/** CA-08: öffentliches Zertifikat (ACME: Let's Encrypt per HTTP oder DNS-01)? `SCHULOS_TLS` ist dann eine E-Mail-Adresse. */
export function acmeFromEnv(env: Record<string, string | undefined>): boolean {
  const v = env.SCHULOS_TLS?.trim();
  return !!v && v !== "internal";
}

/** `valid_to` des Zertifikats (z. B. "Jan  1 00:00:00 2027 GMT") als ISO-Zeitpunkt, sonst null. */
export function parseValidTo(validTo: string | undefined): string | null {
  if (!validTo) return null;
  const t = Date.parse(validTo);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface TlsProbeResult {
  expiresAt: string;
  issuedAt: string | null;
  /** Organisation bzw. Name des Ausstellers, z. B. „Let's Encrypt“ – für die Ausgabe */
  issuer: string;
  /** Kette gegen die öffentlichen Wurzeln (Node) gültig und Name passt zur Domain */
  trusted: boolean;
  /** Name passt zur Domain (unabhängig von der Kette – für Testzertifikate der Staging-Umgebung) */
  nameOk: boolean;
  /** Grund, wenn nicht vertrauenswürdig (z. B. SELF_SIGNED_CERT_IN_CHAIN, falscher Name) */
  problem: string | null;
}

/** Ergebnis aus Handshake-Daten – rein, getestet. */
export function evaluatePeer(cert: Pick<PeerCertificate, "valid_to" | "valid_from" | "issuer" | "subject" | "subjectaltname">, authorized: boolean, authError: string | null, servername: string): TlsProbeResult | null {
  const expiresAt = parseValidTo(cert.valid_to);
  if (!expiresAt) return null;
  const issuer = [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(" ") || "unbekannt";
  const nameOk = !checkServerIdentity(servername, cert as PeerCertificate);
  const problem = !nameOk ? `Name passt nicht zu ${servername}` : authorized ? null : authError || "Kette nicht prüfbar";
  return { expiresAt, issuedAt: parseValidTo(cert.valid_from), issuer, trusted: problem === null, nameOk, problem };
}

export function probeTls(target: TlsProbeTarget, timeoutMs = 5000): Promise<TlsProbeResult | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: TlsProbeResult | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    // rejectUnauthorized: false – auch ein Zertifikat der eigenen CA soll gemessen werden; `authorized` sagt, ob es öffentlich gilt
    const socket = connect({ host: target.host, port: target.port, servername: target.servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const err = socket.authorizationError;
      finish(evaluatePeer(socket.getPeerCertificate(), socket.authorized, err ? String(err) : null, target.servername));
    });
    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
  });
}

/** Messwert für `system-status.json` bzw. `schulosctl status` (BM-04, CA-08). */
export async function probeTlsExpiry(target: TlsProbeTarget, acme = false, timeoutMs = 5000): Promise<TlsInfo | null> {
  const r = await probeTls(target, timeoutMs);
  if (!r) return null;
  return { expiresAt: r.expiresAt, ...(r.issuedAt ? { issuedAt: r.issuedAt } : {}), acme, trusted: r.trusted };
}

/** CA-08: Testzertifikat aus der ACME-Staging-Umgebung (Aussteller „(STAGING) …“) */
export function isStagingIssuer(issuer: string): boolean {
  return /\(STAGING\)/i.test(issuer);
}
