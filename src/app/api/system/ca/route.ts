// CA-03/CA-04: Root der eigenen CA herunterladen (Verwaltung → System) – angemeldet mit `verwaltung.system`, Formate `crt` (PEM),
// `cer` (DER) und `mobileconfig` (Apple). Nur das Zertifikat, nie ein Schlüssel; ohne eigene CA (TLS-Modus nicht `internal`) 404.
import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { readSchoolSettings } from "@/core/settings";
import { isRootCaFormat, rootCaDownload } from "@schulos/server/root-ca";
import { readRootCa } from "@/core/system/root-ca";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  if (!hasPermission(me.perms, "verwaltung.system")) return new Response("Kein Zugriff", { status: 403 });
  const format = new URL(req.url).searchParams.get("format") ?? "crt";
  if (!isRootCaFormat(format)) return new Response("Format: crt, cer oder mobileconfig", { status: 400 });
  const root = readRootCa();
  if (!root) return new Response("Keine eigene CA", { status: 404, headers: { "Cache-Control": "no-store" } });
  const school = (await readSchoolSettings(await getDb())).name;
  return rootCaDownload(root.pem, format, { name: `Schul-Zertifikat ${school}`.trim(), filename: "schul-zertifikat" });
}
