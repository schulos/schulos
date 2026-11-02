// BM-02: Betriebsstatus für Überwachung (docs/BETRIEBSMONITORING.md). /api/health bleibt die schlanke Liveness-Antwort.
// Zugang nach Einstellung (Verwaltung → System → Betrieb): aus (404) · nur Schulnetz (Vorgabe) · nur mit Token. Von außen
// ist der Pfad gesperrt: er steht weder in der Außen-Allowlist (src/core/external-access.ts) noch im Caddyfile. Jede
// Verweigerung antwortet gleich mit 404 – der Endpunkt verrät weder seine Existenz noch den Grund.
import { backupStatus } from "@/core/backup/status";
import { requestNetwork } from "@/core/auth/pflicht";
import { getDb } from "@/core/db/client";
import { collectHealth } from "@/core/system/health";
import { healthAccess, readHealthSettings, readHealthToken } from "@/core/system/health-settings";
import { readSystemStatus } from "@/core/system/status";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store" };
const notFound = () => new Response("Not Found", { status: 404, headers: HEADERS });

export async function GET(req: Request) {
  try {
    const db = await getDb();
    const settings = await readHealthSettings(db);
    const allowed = healthAccess({
      mode: settings.mode,
      zone: settings.mode === "schulnetz" ? await requestNetwork(db, req.headers) : "aussen",
      authorization: req.headers.get("authorization"),
      token: settings.mode === "token" ? readHealthToken() : null,
    });
    if (!allowed) return notFound();
    const report = await collectHealth(db, { system: readSystemStatus(), backup: backupStatus(), settings });
    return Response.json(report, { status: report.level === "error" ? 503 : 200, headers: HEADERS });
  } catch (err) {
    console.error("[health/details]", err);
    return Response.json({ version: 1, level: "error", problems: [{ level: "error", key: "datenbank", text: "Datenbank antwortet nicht" }] }, { status: 503, headers: HEADERS });
  }
}
