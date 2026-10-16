import { moduleOffResponse } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { apiUser } from "@/core/auth/session";
import { getStorage } from "@/core/files/storage";
import { materialFor } from "@/modules/stundenplan/selbstmeldung";

export const dynamic = "force-dynamic";

/** Q5-12: Datei zum Vertretungsmaterial – nur wer das Material sehen darf, immer als Download. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("stundenplan");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const m = await materialFor(await getDb(), me.perms, (await params).id);
  if (!m?.fileKey) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(m.fileKey);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": m.fileMime ?? "application/octet-stream",
      "Content-Length": String(m.fileSize ?? 0),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(m.fileName ?? "Datei")}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
