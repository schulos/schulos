// Modulsperre (Review 2026-10-10): Ein ausgeschaltetes Modul ist nicht nur aus der Navigation verschwunden, sondern auch
// serverseitig zu – Server Actions, Seiten (Layout je Modulordner) und modul-eigene API-Routen prüfen den Schalter.
// Wichtig seit B-34: neue Module kommen per Update ausgeschaltet an.
import "server-only";
import { notFound } from "next/navigation";
import { requirePermission as requirePermissionCore, requireUser as requireUserCore, type CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ForbiddenError, type PermissionContext } from "@/core/permissions";
import { MODULES } from "@/modules";
import { isEnabled, loadModuleStates } from "./registry";

/** Ist das Modul eingeschaltet? Kernmodule immer; unbekannte IDs gelten als Programmfehler. */
export async function moduleOn(id: string): Promise<boolean> {
  const m = MODULES.find((x) => x.id === id);
  if (!m) throw new Error(`Unbekanntes Modul "${id}"`);
  return isEnabled(m, await loadModuleStates(await getDb()));
}

/** Für Seiten: ausgeschaltetes Modul → 404. */
export async function requireModulePage(id: string): Promise<void> {
  if (!(await moduleOn(id))) notFound();
}

/** Für Route Handler: ausgeschaltetes Modul → fertige 404-Antwort, sonst null. */
export async function moduleOffResponse(id: string): Promise<Response | null> {
  return (await moduleOn(id)) ? null : Response.json({ error: "Modul ausgeschaltet" }, { status: 404 });
}

/**
 * Für Server Actions eines Moduls: `requireUser`/`requirePermission` wie aus der Sitzung, zusätzlich mit Modulsperre.
 * Nutzung am Anfang von `actions.ts`: `const { requireUser } = moduleActions("news");`
 */
export function moduleActions(id: string) {
  const assertOn = async () => {
    if (!(await moduleOn(id))) throw new ForbiddenError(`${id} (Modul ausgeschaltet)`);
  };
  return {
    async requireUser(): Promise<CurrentUser> {
      const current = await requireUserCore();
      await assertOn();
      return current;
    },
    async requirePermission(permission: string, ctx?: PermissionContext): Promise<CurrentUser> {
      const current = await requirePermissionCore(permission, ctx);
      await assertOn();
      return current;
    },
  };
}
