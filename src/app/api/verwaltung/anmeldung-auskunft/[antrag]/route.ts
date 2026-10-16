import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { exportRequestError } from "@/core/export-limit";
import { ForbiddenError } from "@/core/permissions";
import { readSchoolSettings } from "@/core/settings";
import { antragAuskunft } from "@/modules/anmeldung/auskunft";

export const dynamic = "force-dynamic";

/**
 * P4-42: Auskunft (Art. 15) zu einem Antrag der Schulanmeldung als JSON – für Anträge ohne Konto, die die allgemeine
 * Auskunft je Konto nicht findet. Nur per POST aus dem Formular (SEC-05), Rechte im Service (Sekretariat bzw.
 * `verwaltung.privacy`), jede Auskunft im Audit-Log. Bewusst ohne Modulsperre: Daten bleiben auch nach dem Ausschalten bis
 * zum Löschlauf, die Auskunftspflicht auch. Nicht unter `/api/anmeldung*` – von außen gesperrt (P4-40).
 */
export async function POST(req: Request, { params }: { params: Promise<{ antrag: string }> }) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { antrag } = await params;
  const db = await getDb();
  try {
    const school = await readSchoolSettings(db);
    // GATE-031 (S-02, R-05): Treffer über die (unbestätigte) Adresse von Elternteil 2 → eingeschränkte Auskunft. Der Umfang
    // folgt serverseitig aus dem Suchbegriff `q` (resolveAuskunftUmfang); `umfang` zählt nur bei Vorgangsnummer/Antragsansicht
    const form = await req.formData().catch(() => null);
    const field = (name: string) => {
      const x = form?.get(name);
      return typeof x === "string" ? x : undefined;
    };
    const wanted = field("umfang");
    const umfang = wanted === "elternteil2" || wanted === "voll" ? wanted : undefined;
    const r = await antragAuskunft(db, me.perms, decodeURIComponent(antrag), { state: school.profile.state, school: school.name, umfang, query: field("q") });
    if (!r) return new Response("Nicht gefunden", { status: 404 });
    return new Response(JSON.stringify(r.data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${r.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Nicht gefunden", { status: 404 });
    throw err;
  }
}

export function GET(req: Request) {
  return exportRequestError(req)!;
}
