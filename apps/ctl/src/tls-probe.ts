// BM-04: Ablauf des Zertifikats, das der Reverse-Proxy ausliefert – schulosctl verbindet sich lokal mit dem HTTPS-Port und liest
// nur das Ablaufdatum (keine Prüfung der Kette; das erledigen die Browser). Schlägt etwas fehl, bleibt der Wert unbekannt (null).
import { connect } from "node:tls";

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

/** `valid_to` des Zertifikats (z. B. "Jan  1 00:00:00 2027 GMT") als ISO-Zeitpunkt, sonst null. */
export function parseValidTo(validTo: string | undefined): string | null {
  if (!validTo) return null;
  const t = Date.parse(validTo);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function probeTlsExpiry(target: TlsProbeTarget, timeoutMs = 5000): Promise<{ expiresAt: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { expiresAt: string } | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    const socket = connect({ host: target.host, port: target.port, servername: target.servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const expiresAt = parseValidTo(socket.getPeerCertificate().valid_to);
      finish(expiresAt ? { expiresAt } : null);
    });
    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
  });
}
