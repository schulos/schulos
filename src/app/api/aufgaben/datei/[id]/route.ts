import { moduleOffResponse } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { apiUser } from "@/core/auth/session";
import { getStorage } from "@/core/files/storage";
import { getTaskFile } from "@/modules/aufgaben/service";

export const dynamic = "force-dynamic";

/** Download von Aufgaben-Anhängen und Abgabe-Dateien – immer als Anhang (kein Inline-Rendering). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("aufgaben");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const db = await getDb();
  const file = await getTaskFile(db, me.perms, id);
  if (!file) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(file.storageKey);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
