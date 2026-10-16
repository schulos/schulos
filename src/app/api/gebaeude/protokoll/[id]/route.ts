import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { moduleOffResponse } from "@/core/modules/guard";
import { reportFor } from "@/modules/gebaeude/pruefungen";

export const dynamic = "force-dynamic";

/**
 * Prüfprotokoll (PDF) – nur für Bearbeitung und Leitung. Beim Hochladen per Magic Bytes geprüft; ausgeliefert immer als
 * Download (`attachment`), Typ fest, nie ausführbar (S8-Header: nosniff, CSP sandbox).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("gebaeude");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const report = await reportFor(await getDb(), me.perms, id);
  if (!report) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(report.key);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": "application/pdf",
      ...(report.size ? { "Content-Length": String(report.size) } : {}),
      "Content-Disposition": `attachment; filename="pruefprotokoll-${report.doneOn ?? "ohne-datum"}.pdf"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
    },
  });
}
