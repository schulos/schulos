import { getDb } from "@/db/client";
import { pairingContext } from "@/pairing/context";
import { pairingHello } from "@/pairing/service";

export const dynamic = "force-dynamic";

// Erster Schritt der Kopplung (TLS beim Aufrufer noch ungeprüft): Antwort ist mit dem Kopplungscode verschlüsselt.
export async function GET(req: Request) {
  const lookup = req.headers.get("x-pairing-lookup") ?? "";
  const sealed = await pairingHello(await getDb(), lookup, pairingContext());
  if (!sealed) return Response.json({ error: "Kopplungscode unbekannt, abgelaufen oder schon verwendet." }, { status: 404 });
  return Response.json({ sealed });
}
