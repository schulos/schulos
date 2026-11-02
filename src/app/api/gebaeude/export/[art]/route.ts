import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { assetListCsv } from "@/modules/gebaeude/inventar-csv";
import { ASSET_CONDITIONS } from "@/modules/gebaeude/labels";
import { DEADLINE_KINDS, deadlineWindow } from "@/modules/gebaeude/open";
import { inspectionsCsv, ticketsCsv, type AssetFilter } from "@/modules/gebaeude/pruefungen";

export const dynamic = "force-dynamic";

/** INV-06: Filter der Inventarliste aus der Adresse (gleiche Namen wie auf `/gebaeude/inventar`). */
async function assetFilter(url: URL, today: string): Promise<AssetFilter> {
  const q = (k: string) => url.searchParams.get(k)?.trim() || undefined;
  const frist = DEADLINE_KINDS.find((k) => k === q("frist"));
  const window = frist ? await deadlineWindow(await getDb(), today) : null;
  return {
    categoryId: q("kategorie"),
    buildingId: q("gebaeude"),
    roomId: q("raum"),
    condition: ASSET_CONDITIONS.find((c) => c === q("zustand")),
    inactive: q("alle") === "1",
    withoutLabel: q("ohne") === "1",
    q: q("q")?.slice(0, 100),
    deadline: frist ? { kind: frist, from: today, until: window?.until ?? addDays(today, 90) } : undefined,
  };
}

/**
 * P4-18: CSV der Meldungen bzw. Prüfungen – ohne Personennamen und Freitext, Zellen gegen Formeln entschärft. INV-06: Inventar
 * im Schulträgerformat (`?kodierung=cp1252` für ältere Tabellenprogramme), Filter wie die Liste; ohne Leserecht 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ art: string }> }) {
  const off = await moduleOffResponse("gebaeude");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { art } = await params;
  if (art !== "meldungen" && art !== "pruefungen" && art !== "inventar") return new Response("Nicht gefunden", { status: 404 });
  const db = await getDb();
  const today = toBerlinDate(new Date());
  try {
    let body: string | Uint8Array<ArrayBuffer>;
    let charset = "utf-8";
    if (art === "inventar") {
      const url = new URL(req.url);
      const cp1252 = url.searchParams.get("kodierung") === "cp1252";
      body = (await assetListCsv(db, me.perms, await assetFilter(url, today), cp1252 ? "cp1252" : "utf8")) as Uint8Array<ArrayBuffer>;
      if (cp1252) charset = "windows-1252";
    } else body = art === "meldungen" ? await ticketsCsv(db, me.perms) : await inspectionsCsv(db, me.perms, today);
    return new Response(body, {
      headers: {
        "Content-Type": `text/csv; charset=${charset}`,
        "Content-Disposition": `attachment; filename="gebaeude-${art}-${today}.csv"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Nicht gefunden", { status: 404 });
    throw err;
  }
}
