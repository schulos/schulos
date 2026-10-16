import type { AgentReport } from "@schulos/server/agent-api";
import { authenticateAgent, recordReport, ReportRejected } from "@/agent/service";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

// Ergebnis eines Sicherungslaufs vom Backup-Agenten.
export async function POST(req: Request) {
  const db = await getDb();
  const inst = await authenticateAgent(db, req.headers.get("authorization"));
  if (!inst) return Response.json({ error: "Nicht gekoppelt." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as AgentReport | null;
  if (!body) return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  try {
    await recordReport(db, inst, body);
  } catch (err) {
    if (err instanceof ReportRejected) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
  return Response.json({ ok: true });
}
