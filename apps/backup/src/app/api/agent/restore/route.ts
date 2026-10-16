import type { RestoreReport } from "@schulos/server/agent-api";
import { authenticateAgent } from "@/agent/service";
import { getDb } from "@/db/client";
import { confirmRestore, recordRestoreReport, rejectRestore, RestoreRejected } from "@/restore/service";

export const dynamic = "force-dynamic";

// Wiederherstellung, Aufrufe des Hauptsystems (Agent-Token):
//   { aktion: "bestaetigen", id, code }  – Bestätigung mit dem Code vom Backupserver (Verwaltung → Backup)
//   { aktion: "ablehnen", id }           – Ablehnung im Hauptsystem
//   { aktion: "melden", bericht }        – Fortschritt/Ergebnis vom Agenten
export async function POST(req: Request) {
  const db = await getDb();
  const inst = await authenticateAgent(db, req.headers.get("authorization"));
  if (!inst) return Response.json({ error: "Nicht gekoppelt." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { aktion?: string; id?: string; code?: string; bericht?: RestoreReport } | null;
  try {
    if (body?.aktion === "bestaetigen" && body.id) return Response.json({ ergebnis: await confirmRestore(db, inst, body.id, String(body.code ?? "")) });
    if (body?.aktion === "ablehnen" && body.id) {
      await rejectRestore(db, inst, body.id, null, "auf dem Hauptsystem abgelehnt");
      return Response.json({ ok: true });
    }
    if (body?.aktion === "melden" && body.bericht) {
      await recordRestoreReport(db, inst, body.bericht);
      return Response.json({ ok: true });
    }
  } catch (err) {
    if (err instanceof RestoreRejected) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
  return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
}
