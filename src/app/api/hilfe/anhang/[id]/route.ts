import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { moduleOffResponse } from "@/core/modules/guard";
import { attachmentFile, INLINE_MIMES } from "@/modules/hilfe/attachments";

export const dynamic = "force-dynamic";

/**
 * HB-05: Anhang einer Handbuchseite – nur für die, die die Seite sehen (`attachmentFile`, sonst einheitlich 404). Typ fest aus der DB;
 * PDF und Bilder mit `?inline=1` im Browser, alles andere immer als Download (S8-Header: nosniff, CSP sandbox).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("hilfe");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const file = await attachmentFile(await getDb(), me.perms, id);
  if (!file) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(file.key);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  const inline = new URL(req.url).searchParams.has("inline") && INLINE_MIMES.has(file.mime);
  return new Response(body, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      // sandbox würde Chromes PDF-Viewer blockieren – PDFs führen dort ohnehin kein Seiten-JS aus
      ...(file.mime === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      "Cache-Control": "private, no-store",
    },
  });
}
