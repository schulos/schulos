import { getDb } from "@/db/client";
import { pairingContext } from "@/pairing/context";
import { pairingClaim, PairingRejected } from "@/pairing/service";

export const dynamic = "force-dynamic";

// Zweiter Schritt der Kopplung – der Aufrufer prüft TLS jetzt gegen die CA aus „hello“.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { lookup?: unknown; request?: unknown } | null;
  if (typeof body?.lookup !== "string" || typeof body.request !== "string") return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  try {
    const sealed = await pairingClaim(await getDb(), body.lookup, body.request, pairingContext());
    if (!sealed) return Response.json({ error: "Kopplungscode unbekannt, abgelaufen oder schon verwendet." }, { status: 404 });
    return Response.json({ sealed });
  } catch (err) {
    if (err instanceof PairingRejected) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
