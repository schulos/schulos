// CA-03 (ca-2): Root der eigenen CA ohne Anmeldung – ohne Vertrauen gibt es keinen sicheren Login. Nur im Schulnetz: der Pfad steht
// weder in der Außen-Allowlist (src/core/external-access.ts) noch im Caddyfile; von außen (auch im Modus „alles“) antwortet die
// App mit 404. Nur bei eigener CA (TLS-Modus `internal`, schulosctl legt die Datei ab), sonst 404. Vor dem Import den
// Fingerabdruck mit der Konsole des Servers bzw. Verwaltung → System abgleichen.
import { requestNetwork } from "@/core/auth/pflicht";
import { getDb } from "@/core/db/client";
import { rootCaDownload } from "@schulos/server/root-ca";
import { readRootCa } from "@/core/system/root-ca";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  if ((await requestNetwork(await getDb(), req.headers)) !== "schulnetz") return notFound();
  const root = readRootCa();
  return root ? rootCaDownload(root.pem, "crt", { name: "Schul-Zertifikat", filename: "schul-zertifikat" }) : notFound();
}
