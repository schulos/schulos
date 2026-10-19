import "server-only";
import { eq, inArray } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/core/db/client";
import { parentChild, users, type Role } from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { isDemoDb } from "@/core/permissions";

/** Datenbank ist eine Demo-Instanz → Demo-Band anzeigen (pro Request gecacht). */
export const isDemoInstance = cache(async (): Promise<boolean> => isDemoDb(await getDb()));

export interface DemoAccount {
  username: string;
  name: string;
  label: string;
  role: Role;
}

/**
 * Demo-Schnell-Login ist nur aktiv, wenn BEIDES gilt:
 *  - Entwicklungsmodus ODER Demo-Instanz (SCHULOS_INSTANCE=demo bzw. SCHULOS_DEMO_LOGIN=1)
 *  - die Datenbank ist als Demo markiert (app_settings.demo = true, setzt der Seed)
 * Eine Produktivinstanz (SCHULOS_INSTANCE=production) schließt ihn immer aus.
 */
export async function isDemoLoginEnabled(): Promise<boolean> {
  if (process.env.SCHULOS_INSTANCE?.trim().toLowerCase() === "production") return false;
  const demoInstance = process.env.SCHULOS_DEMO_LOGIN === "1" || process.env.SCHULOS_INSTANCE?.trim().toLowerCase() === "demo";
  if (process.env.NODE_ENV === "production" && !demoInstance) return false;
  return isDemoInstance();
}

const FIXED = [
  { username: "lea.schaefer", label: "Schülerin · 7b" },
  { username: "jana.brandt", label: "Lehrkraft · Klassenleitung 7b" },
  { username: "petra.lindner", label: "Schulleitung" },
  { username: "sabine.kowalski", label: "Sekretariat" },
  { username: "frank.schulte", label: "Lehrkraft · Stundenplanung" },
  { username: "klaus.berger", label: "Hausmeister" },
  { username: "nina.ostermann", label: "Schulsozialarbeit" },
  { username: "admin", label: "Administration" },
];

export async function getDemoAccounts(): Promise<DemoAccount[]> {
  if (!(await isDemoLoginEnabled())) return [];
  const db = await getDb();
  const rows = await db
    .select({ username: users.username, name: users.name, role: users.role })
    .from(users)
    .where(inArray(users.username, FIXED.map((f) => f.username)));
  const accounts: DemoAccount[] = FIXED.flatMap((f) => {
    const u = rows.find((r) => r.username === f.username);
    return u ? [{ username: f.username, name: u.name, label: f.label, role: u.role }] : [];
  });
  // Elternteil von Lea dazu
  const [parent] = await db
    .select({ username: users.username, name: users.name })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.parentId))
    .where(eq(parentChild.childId, "u-lea.schaefer"))
    .limit(1);
  if (parent?.username) {
    accounts.splice(1, 0, { username: parent.username, name: parent.name, label: `${ROLE_LABELS.eltern} von Lea`, role: "eltern" });
  }
  return accounts;
}

/** Vorschau-Instanz (B-35, INSTALLATION.md §5a.3): SCHULOS_PREVIEW=1 → Version für das Band „VORSCHAU“, sonst null. */
export function previewVersion(env: Record<string, string | undefined> = process.env): string | null {
  return env.SCHULOS_PREVIEW === "1" ? (env.SCHULOS_VERSION ?? "dev") : null;
}
