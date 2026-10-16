// Gemeinsames für die Route-Handler unter /api/texte (P3-11): Modulsperre, Sitzung, Zugriff; Body-Prüfung in body.ts.
import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import type { PermissionSet } from "@/core/permissions";
import { json } from "./body";
import { docAccess, type DocAccess } from "./service";

export { APPLY_ERRORS, json, MAX_BODY_BYTES, readBody } from "./body";

/** Modul an, angemeldet, Mitglied mit Merkmal – sonst die fertige Antwort (404 verrät nicht, ob es den Text gibt). */
export async function textRequest(req: Request, id: string): Promise<{ perms: PermissionSet; userId: string; access: DocAccess } | Response> {
  const off = await moduleOffResponse("texte");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const access = await docAccess(await getDb(), me.perms, id);
  if (!access) return json({ error: "Nicht gefunden" }, 404);
  return { perms: me.perms, userId: me.userId, access };
}
