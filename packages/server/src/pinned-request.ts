// HTTP(S)-Aufrufe zwischen Hauptsystem, Backup-Agent und Backupserver mit festgelegtem Vertrauen (INSTALLATION.md §4.3):
// - "ca":       nur Zertifikate dieser CA (Pinning der Caddy-CA des Backupservers)
// - "system":   öffentliche CAs (Let's Encrypt) über den System-Truststore
// - "insecure": ungeprüft – nur für das erste „hello“ der Kopplung, dessen Antwort mit dem Kopplungscode geschützt ist
import http from "node:http";
import https from "node:https";

export type TlsTrust = { mode: "ca"; caPem: string } | { mode: "system" } | { mode: "insecure" };

export interface JsonResponse<T> {
  status: number;
  body: T | null;
}

export class RequestError extends Error {
  constructor(
    message: string,
    /**
     * "tls" = Zertifikat passt nicht zur gepinnten CA bzw. ist ungültig, "network" = nicht erreichbar, "timeout",
     * "too_large" = Antwort größer als `maxBytes` (kein JSON dieses Protokolls – falsche Adresse oder jemand dazwischen)
     */
    public readonly kind: "tls" | "network" | "timeout" | "too_large",
  ) {
    super(message);
    this.name = "RequestError";
  }
}

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME|UNABLE_TO_GET_ISSUER/;

/** Obergrenze für eine Antwort: die JSON-Antworten zwischen den Systemen sind wenige KB groß (auch beim ungeprüften „hello“). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export function requestJson<T>(
  url: string,
  opts: { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; trust: TlsTrust; timeoutMs?: number; maxBytes?: number },
): Promise<JsonResponse<T>> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  if (!isHttps && u.protocol !== "http:") return Promise.reject(new RequestError(`Nicht unterstütztes Protokoll: ${u.protocol}`, "network"));
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const tls = isHttps
    ? opts.trust.mode === "ca"
      ? { ca: opts.trust.caPem, rejectUnauthorized: true }
      : { rejectUnauthorized: opts.trust.mode !== "insecure" }
    : {};

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      u,
      {
        method: opts.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
        // eigener Agent: keine wiederverwendeten Verbindungen mit anderem Vertrauen
        agent: false,
        ...tls,
      },
      (res) => {
        // abbrechen statt weiterlesen; das Promise ist damit erledigt, spätere Fehler der zerstörten Verbindung zählen nicht
        const tooLarge = () => {
          res.destroy();
          req.destroy();
          reject(new RequestError(`Antwort zu groß (über ${Math.round(maxBytes / 1024)} KB)`, "too_large"));
        };
        res.on("error", () => {});
        if (Number(res.headers["content-length"] ?? 0) > maxBytes) return tooLarge();
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) return tooLarge();
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: T | null = null;
          try {
            body = text ? (JSON.parse(text) as T) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.setTimeout(opts.timeoutMs ?? 15_000, () => req.destroy(new RequestError("Zeitüberschreitung", "timeout")));
    req.on("error", (err: Error & { code?: string }) => {
      if (err instanceof RequestError) return reject(err);
      const tlsError = TLS_CODES.test(err.code ?? "") || TLS_CODES.test(err.message);
      reject(new RequestError(tlsError ? `Zertifikat nicht vertrauenswürdig (${err.code ?? err.message})` : `Nicht erreichbar (${err.code ?? err.message})`, tlsError ? "tls" : "network"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}
