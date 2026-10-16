// Gemeinsames für die Route-Handler unter /api/tafeln (P3-12): Modulsperre, Sitzung, Zugriff, Body (body.ts).
import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import type { PermissionSet } from "@/core/permissions";
import { json } from "./body";
import { boardAccess, type BoardAccess } from "./service";

export { APPLY_ERRORS, json, MAX_BODY_BYTES, readBody } from "./body";

/** Modul an, angemeldet, Mitglied mit Gruppenordner – sonst die fertige Antwort (404 verrät nicht, ob es die Tafel gibt). */
export async function boardRequest(req: Request, id: string): Promise<{ perms: PermissionSet; userId: string; access: BoardAccess } | Response> {
  const off = await moduleOffResponse("tafeln");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const access = await boardAccess(await getDb(), me.perms, id);
  if (!access) return json({ error: "Nicht gefunden" }, 404);
  return { perms: me.perms, userId: me.userId, access };
}
