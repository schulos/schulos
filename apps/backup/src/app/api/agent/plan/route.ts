import { agentPlan, authenticateAgent } from "@/agent/service";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

// Plan für den Backup-Agenten (Zeitplan, angeforderte Sicherung). Zugang: Agent-Token aus der Kopplung.
export async function GET(req: Request) {
  const db = await getDb();
  const inst = await authenticateAgent(db, req.headers.get("authorization"));
  if (!inst) return Response.json({ error: "Nicht gekoppelt." }, { status: 401 });
  return Response.json(await agentPlan(db, inst));
}
