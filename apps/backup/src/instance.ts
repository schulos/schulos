// Erststart des Backupservers (INSTALLATION.md §3.3): leere Datenbank → Admin-Konto aus SCHULOS_ADMIN_* (backup.env).
// Ohne Konfiguration startet der Server nur in der Entwicklung (Dev-Admin), im Betrieb bricht der Start ab.
import { count } from "drizzle-orm";
import { parseAdminConfig, type AdminConfig, type Env } from "@schulos/server/admin";
import { audit } from "@/audit";
import { createUserWithPassword } from "@/auth/auth";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";

export class StartupError extends Error {}

/** Dev-Konto für `npm run dev -w @schulos/backup` ohne Konfiguration – nie im Betrieb. */
export const DEV_ADMIN: AdminConfig = { username: "admin", firstName: "Backup", lastName: "Admin", password: { plain: "schulos-backup" } };

export type InitResult =
  | { action: "checked"; users: number }
  | { action: "created-admin"; admin: string; usedPlainPassword: boolean; dev: boolean };

export async function initializeBackup(db: Db, env: Env, production = env.NODE_ENV === "production"): Promise<InitResult> {
  const [row] = await db.select({ n: count() }).from(users);
  const existing = row?.n ?? 0;
  if (existing > 0) return { action: "checked", users: existing };

  const parsed = parseAdminConfig(env);
  const configured = Object.keys(env).some((k) => k.startsWith("SCHULOS_ADMIN_"));
  let admin: AdminConfig;
  if (parsed.ok) admin = parsed.admin;
  else if (!configured && !production) admin = DEV_ADMIN;
  else throw new StartupError(`Erststart nicht möglich:\n  - ${parsed.errors.join("\n  - ")}`);

  const id = crypto.randomUUID();
  await createUserWithPassword(db, { id, username: admin.username, firstName: admin.firstName, lastName: admin.lastName }, admin.password);
  await audit(db, null, "system.erststart", id, { benutzername: admin.username });
  return { action: "created-admin", admin: admin.username, usedPlainPassword: "plain" in admin.password, dev: admin === DEV_ADMIN };
}
