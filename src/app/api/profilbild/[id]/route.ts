import { and, eq } from "drizzle-orm";
import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { getStorage } from "@/core/files/storage";
import { photoOf } from "@/core/privacy/profilbild";
import { visiblePeople } from "@/modules/adressbuch/service";

export const dynamic = "force-dynamic";

/** Profilbild – nur mit Einwilligung (sonst gibt es keine Zeile) und nur für Personen, die man sehen darf. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const db = await getDb();
  const viewer = me.perms;
  const [visible] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), await visiblePeople(db, viewer)));
  const photo = visible ? await photoOf(db, id) : null;
  if (!photo) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(photo.storageKey);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": photo.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      // Adresse enthält die Version (?v=…): nach Widerruf/Austausch wird ohnehin eine neue geladen
      "Cache-Control": "private, max-age=3600",
    },
  });
}
