// CA-02 (docs/ZERTIFIKATE.md): Wurzelzertifikat der eigenen CA von Caddy (TLS-Modus `internal`). Die App sieht `caddy_data` nicht
// (dort liegt auch der Schlüssel) – schulosctl liest nur `root.crt` aus dem Caddy-Container, legt es als `root-ca.crt` in den
// Konfigurationsordner der App und meldet den SHA-256-Fingerabdruck. Nie den Schlüssel, nie etwas anderes aus `pki/`.
import { parseRootCa } from "@schulos/server/root-ca";
import type { RootCaInfo } from "@schulos/server/system";

export { firstCertificatePem, rootCaInfo } from "@schulos/server/root-ca";

/** Pfad im Caddy-Container (Volume `caddy_data`) */
export const CADDY_ROOT_CRT = "/data/caddy/pki/authorities/local/root.crt";

/** Eigene CA nur bei `SCHULOS_TLS=internal` (Vorgabe); bei Let's Encrypt (E-Mail-Adresse) gibt es keine Schul-Root. */
export function tlsIsInternal(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v === "" || v === "internal";
}

/**
 * Root aus dem Caddy-Container lesen (`exec` = `docker compose exec -T caddy cat …`). null = keine eigene CA (TLS-Modus nicht
 * `internal`), Caddy läuft nicht oder die Datei ist (noch) kein CA-Zertifikat.
 */
export async function readCaddyRoot(
  tls: string | undefined,
  exec: (args: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<{ pem: string; info: RootCaInfo } | null> {
  if (!tlsIsInternal(tls)) return null;
  const r = await exec(["exec", "-T", "caddy", "cat", CADDY_ROOT_CRT]).catch(() => ({ code: 1, stdout: "" }));
  return r.code === 0 ? parseRootCa(r.stdout) : null;
}
