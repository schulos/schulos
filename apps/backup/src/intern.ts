// Interne Schnittstelle für die Kommandozeile im Container (`node cli.mjs …`, B-45): Kopplungs- und Ersatz-Kopplungscodes ohne
// Anmeldung in der Web-UI – z. B. per SSH auf dem Backupserver oder in den QEMU-Tests. Zugang nur mit einem Token aus dem
// App-Geheimnis (secret.env, nur im Container lesbar) und nur über 127.0.0.1 (über Caddy kommt ein anderer Host-Header an).
// Die Datenbank (PGlite) gehört dem App-Prozess – deshalb kein eigener DB-Zugriff aus der Kommandozeile.
import { createHash, timingSafeEqual } from "node:crypto";

export const INTERN_HEADER = "x-schulos-intern";

export function internToken(appSecret: string): string {
  return createHash("sha256").update(`schulos-backup-intern:${appSecret}`).digest("hex");
}

export function internAllowed(headers: Headers, appSecret: string): boolean {
  const host = (headers.get("host") ?? "").replace(/:\d+$/, "");
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  const got = Buffer.from(headers.get(INTERN_HEADER) ?? "");
  const want = Buffer.from(internToken(appSecret));
  return got.length === want.length && timingSafeEqual(got, want);
}
