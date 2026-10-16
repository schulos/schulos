import { getDb } from "@/core/db/client";
import { apiUser } from "@/core/auth/session";
import { getStorage } from "@/core/files/storage";
import { moduleOn } from "@/core/modules/guard";
import { getDownload } from "@/modules/dateien/service";
import { isBoardFile } from "@/modules/pinnwaende/service";

export const dynamic = "force-dynamic";

/** Nur diese Typen dürfen im Browser angezeigt werden – alles andere wird heruntergeladen (XSS-Schutz). */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const db = await getDb();
  // Modulsperre (SEC-05): bei ausgeschalteter Dateiablage nur noch Dateien, die auf einer Pinnwand-Karte hängen – sonst
  // gingen Dateikarten kaputt. Aufgaben, Elternbriefe und Profilbilder haben eigene Routen und sind nicht betroffen.
  if (!(await moduleOn("dateien")) && !((await moduleOn("pinnwaende")) && (await isBoardFile(db, id))))
    return Response.json({ error: "Modul ausgeschaltet" }, { status: 404 });
  const node = await getDownload(db, me.perms, id);
  if (!node?.storageKey) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(node.storageKey);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });

  const inline = new URL(req.url).searchParams.has("inline") && INLINE_SAFE.test(node.mime ?? "");
  const type = inline ? node.mime! : (node.mime ?? "application/octet-stream");
  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(node.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(node.name)}`,
      "X-Content-Type-Options": "nosniff",
      // sandbox würde Chromes PDF-Viewer blockieren – PDFs führen dort ohnehin kein Seiten-JS aus
      ...(node.mime === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      "Cache-Control": "private, no-store",
    },
  });
}
