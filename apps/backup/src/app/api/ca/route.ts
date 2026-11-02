// CA-05 (docs/ZERTIFIKATE.md): Root der eigenen CA des Backupservers herunterladen – Caddy kopiert sie nach /ca/root.crt
// (SCHULOS_TLS_CA_FILE, compose.backup.yaml). Nur angemeldet; nur das Zertifikat, nie der Schlüssel; ohne eigene CA 404.
import { isRootCaFormat, rootCaDownload } from "@schulos/server/root-ca";
import { getCurrentUser } from "@/auth/session";
import { serverName, tlsRootCa } from "@/settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await getCurrentUser())) return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
  const format = new URL(req.url).searchParams.get("format") ?? "crt";
  if (!isRootCaFormat(format)) return new Response("Format: crt, cer oder mobileconfig", { status: 400 });
  const root = tlsRootCa();
  if (!root) return new Response("Keine eigene CA", { status: 404, headers: { "Cache-Control": "no-store" } });
  return rootCaDownload(root.pem, format, { name: `Zertifikat ${serverName()}`, filename: "backupserver-zertifikat", identifier: "schulos.backup.root-ca" });
}
