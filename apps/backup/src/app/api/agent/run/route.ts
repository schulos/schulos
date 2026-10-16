import { authenticateAgent, requestRun } from "@/agent/service";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

// „Jetzt sichern“ aus dem Hauptsystem (Verwaltung → Backup): der Agent holt die Anforderung mit dem nächsten Plan ab (≤ 1 min).
export async function POST(req: Request) {
  const db = await getDb();
  const inst = await authenticateAgent(db, req.headers.get("authorization"));
  if (!inst) return Response.json({ error: "Nicht gekoppelt." }, { status: 401 });
  await requestRun(db, inst.id, null);
  return Response.json({ ok: true });
}
