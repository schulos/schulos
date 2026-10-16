import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/core/db/client";
import type { User } from "@/core/db/schema";
import { accessBlocked, assertPermission, loadPermissions, type PermissionContext, type PermissionSet } from "@/core/permissions";
import { externalAccessFor } from "@/core/device-certs/service";
import { DENY_TEXT } from "@/core/device-certs/policy";
import { getAuth } from "./auth";
import { withNetworkRules } from "./pflicht";
import { requestActivity, sessionActivity } from "./sitzungen";
import { cachedSecuritySettings } from "@/core/settings";

export interface CurrentUser {
  user: Pick<User, "id" | "name" | "firstName" | "lastName" | "shortCode" | "role" | "username">;
  perms: PermissionSet;
}

/** Aktueller Benutzer oder null. Pro Request gecacht. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const auth = await getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) return null;
  const db = await getDb();
  const u = session.user as unknown as CurrentUser["user"];
  // P4-40b: von außen nur nach Rolle/Gerätezertifikat (S27/S28) – sonst gilt die Sitzung hier als nicht vorhanden
  if (!(await externalAccessFor(db, h, { id: u.id, role: u.role })).allowed) return null;
  // P4-71: Inaktivitätsablauf je Schule – abgelaufen = Sitzung beendet, wie abgemeldet; automatisches Neuladen zählt nicht (G4E-C01)
  if ((await requestActivity(db, session.session.id, (await cachedSecuritySettings(db)).idleMinutes, h)) === "abgelaufen")
    return null;
  // SEC-01: Schüler:innen von außen nur mit zweitem Faktor (sonst gesperrt wie Pflicht-2FA → /zwei-faktor)
  const perms = await withNetworkRules(db, h, session.session.id, await loadPermissions(db, session.user.id));
  if (perms.locked) return null;
  return {
    user: {
      id: u.id,
      name: u.name,
      firstName: u.firstName,
      lastName: u.lastName,
      shortCode: u.shortCode ?? null,
      role: u.role,
      username: u.username ?? null,
    },
    perms,
  };
});

/**
 * Für Seiten im geschützten Bereich: leitet ohne Login auf /login um, mit Startpasswort auf /passwort,
 * Pflicht-2FA ohne Einrichtung auf /zwei-faktor.
 */
export async function requireUser(): Promise<CurrentUser> {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (current.perms.passwordChangePending) redirect("/passwort");
  if (current.perms.twoFactorPending) redirect("/zwei-faktor");
  return current;
}

/**
 * Für Route Handler (/api): angemeldet und uneingeschränkt nutzbar – sonst eine fertige Antwort (401 bzw. 403). Wie
 * requireUser, nur ohne Umleitung: gesperrte Konten, offenes Startpasswort und fehlende Pflicht-2FA kommen nicht an
 * Dateien oder Exporte (B-55 – vorher reichte den API-Routen eine Sitzung).
 */
export async function apiUser(req: Request): Promise<{ userId: string; perms: PermissionSet } | Response> {
  const session = await (await getAuth()).api.getSession({ headers: req.headers });
  if (!session) return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
  const db = await getDb();
  const external = await externalAccessFor(db, req.headers, { id: session.user.id, role: (session.user as { role?: string }).role ?? "" });
  if (!external.allowed) return Response.json({ error: DENY_TEXT[external.reason] }, { status: 403 });
  if ((await requestActivity(db, session.session.id, (await cachedSecuritySettings(db)).idleMinutes, req.headers)) === "abgelaufen")
    return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
  const perms = await withNetworkRules(db, req.headers, session.session.id, await loadPermissions(db, session.user.id));
  const blocked = accessBlocked(perms);
  if (blocked === "gesperrt") return Response.json({ error: "Konto gesperrt" }, { status: 401 });
  if (blocked) return Response.json({ error: blocked === "passwort" ? "Erst das Passwort ändern" : "Erst die Zwei-Faktor-Anmeldung einrichten" }, { status: 403 });
  return { userId: session.user.id, perms };
}

/**
 * Für lange offene Verbindungen (SSE): gilt die Sitzung dieser Anfrage noch für genau diesen Benutzer, und ist das Konto
 * uneingeschränkt nutzbar? Ohne Verlängerung der Sitzung (keine Cookies mitten im Strom) – SEC-04.
 */
export async function sessionStillValid(req: Request, userId: string): Promise<boolean> {
  const session = await (await getAuth()).api.getSession({ headers: req.headers, query: { disableRefresh: true, disableCookieCache: true } });
  if (session?.user.id !== userId) return false;
  const db = await getDb();
  if (!(await externalAccessFor(db, req.headers, { id: userId, role: (session.user as { role?: string }).role ?? "" })).allowed) return false;
  // Live-Strom zählt nicht als Aktivität (sonst liefe der Inaktivitätsablauf bei offenem Tab nie ab)
  if ((await sessionActivity(db, session.session.id, (await cachedSecuritySettings(db)).idleMinutes, new Date(), false)) === "abgelaufen") return false;
  return accessBlocked(await withNetworkRules(db, req.headers, session.session.id, await loadPermissions(db, userId))) === null;
}

/** Für Server Actions: Benutzer muss angemeldet sein UND das Recht haben. */
export async function requirePermission(permission: string, ctx?: PermissionContext): Promise<CurrentUser> {
  const current = await requireUser();
  assertPermission(current.perms, permission, ctx);
  return current;
}
