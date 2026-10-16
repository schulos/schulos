import { getDb } from "@/core/db/client";
import { textRequest } from "@/modules/texte/api";
import { exportFilename, exportMarkdown } from "@/modules/texte/service";

export const dynamic = "force-dynamic";

/** Markdown-Download (P3-11) für Mitglieder; der Server erzeugt ihn aus dem Yjs-Stand. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const r = await textRequest(req, id);
  if (r instanceof Response) return r;
  const out = await exportMarkdown(await getDb(), r.perms, id);
  if (!out) return Response.json({ error: "Nicht gefunden" }, { status: 404 });
  return new Response(out.markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(out.title)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
