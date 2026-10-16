// Rechte- und Modulverwaltung – Service-Funktionen.
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { audit } from "@/core/audit";
import { mailAvailable } from "@/core/mail";
import type { Db } from "@/core/db/client";
import { grants, groupMembers, groups, ROLES, users, type Role } from "@/core/db/schema";
import { allPermissions, setModuleEnabled } from "@/core/modules/registry";
import { readModuleSetting, writeModuleSetting } from "@/core/modules/settings";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import type { ModuleManifest } from "@/core/modules/types";
import { coversNotenbuchRight, FAMILY_ROLES, isFamilyRole } from "@/modules/notenbuch/rollen";
import { assertMayGrant, loadActor } from "./escalation";
import { ValidationError } from "./users";
import { de } from "@/core/db/sort";

/** Rollen, deren Rechte man vergeben kann – Admin darf ohnehin alles. */
export const GRANTABLE_ROLES = ROLES.filter((r) => r !== "admin");

/** Alle vergebbaren Rechte inkl. Modul-Wildcards ("news.*"). */
export function grantablePermissions(manifests: readonly ModuleManifest[]) {
  const perms = allPermissions(manifests);
  const wildcards = manifests
    .filter((m) => Object.keys(m.permissions ?? {}).length > 1)
    .map((m) => ({ id: `${m.id}.*`, label: `Alle Rechte in ${m.name}`, moduleId: m.id, moduleName: m.name }));
  return [...perms, ...wildcards];
}

const NOTENBUCH_FAMILY_MESSAGE = "Notenbuch-Rechte gibt es nie für Schüler:innen und Eltern.";

/**
 * GATE-5a (Schülerzugriff): Notenbuch-Rechte (auch `notenbuch.*` und `*`) gehen nie an Schüler:innen und Eltern – weder an ihre
 * Rolle noch an eine Gruppe mit solchen Mitgliedern. Wirksam ist ohnehin die Sperre in `hasNotenbuchRight`; hier wird die
 * Vergabe schon abgelehnt, damit die Rechteverwaltung nichts anzeigt, was nicht gilt. Liefert den Grund oder null.
 */
export function roleGrantBlocked(role: Role, permission: string): string | null {
  return isFamilyRole(role) && coversNotenbuchRight(permission) ? NOTENBUCH_FAMILY_MESSAGE : null;
}

export async function getRoleGrantMatrix(db: Db): Promise<Set<string>> {
  const rows = await db.select({ permission: grants.permission, role: grants.role }).from(grants).where(isNotNull(grants.role));
  return new Set(rows.map((r) => `${r.role}:${r.permission}`));
}

export async function listGroupGrants(db: Db) {
  return db
    .select({ id: grants.id, permission: grants.permission, groupId: groups.id, groupName: groups.name })
    .from(grants)
    .innerJoin(groups, eq(groups.id, grants.groupId))
    .where(isNull(grants.role))
    .orderBy(de(groups.name), asc(grants.permission));
}

function assertKnown(manifests: readonly ModuleManifest[], permission: string) {
  if (!grantablePermissions(manifests).some((p) => p.id === permission)) {
    throw new ValidationError({ permission: `Unbekanntes Recht: ${permission}` });
  }
}

export async function setRoleGrant(
  db: Db,
  manifests: readonly ModuleManifest[],
  actorId: string,
  role: Role,
  permission: string,
  granted: boolean,
): Promise<void> {
  if (role === "admin") throw new ValidationError({ role: "Admins haben immer alle Rechte" });
  assertKnown(manifests, permission);
  const blocked = granted ? roleGrantBlocked(role, permission) : null;
  if (blocked) throw new ValidationError({ permission: blocked });
  // SEC-04: nur Rechte vergeben, die man selbst hat – und nicht an die eigene Rolle
  if (granted) assertMayGrant(await loadActor(db, actorId), permission, { role });
  if (granted) await db.insert(grants).values({ permission, role }).onConflictDoNothing();
  else await db.delete(grants).where(and(eq(grants.role, role), eq(grants.permission, permission)));
  await audit(db, actorId, granted ? "verwaltung.rights.grant" : "verwaltung.rights.revoke", `role:${role}`, { permission });
}

export async function addGroupGrant(db: Db, manifests: readonly ModuleManifest[], actorId: string, groupId: string, permission: string) {
  assertKnown(manifests, permission);
  const [g] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId));
  if (!g) throw new ValidationError({ groupId: "Gruppe nicht gefunden" });
  if (coversNotenbuchRight(permission)) {
    const [family] = await db
      .select({ id: users.id })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, groupId), inArray(users.role, [...FAMILY_ROLES])))
      .limit(1);
    if (family) throw new ValidationError({ permission: `${NOTENBUCH_FAMILY_MESSAGE} Diese Gruppe hat solche Mitglieder.` });
  }
  assertMayGrant(await loadActor(db, actorId), permission, { groupId }); // SEC-04
  await db.insert(grants).values({ permission, groupId }).onConflictDoNothing();
  await audit(db, actorId, "verwaltung.rights.grant", `group:${groupId}`, { permission });
}

export async function removeGrant(db: Db, actorId: string, grantId: string) {
  const [g] = await db.delete(grants).where(eq(grants.id, grantId)).returning();
  if (g) await audit(db, actorId, "verwaltung.rights.revoke", g.groupId ? `group:${g.groupId}` : `role:${g.role}`, { permission: g.permission });
}

export async function toggleModule(db: Db, actorId: string, m: ModuleManifest, enabled: boolean, opts: { mail?: boolean } = {}) {
  // P4-33: Module mit Mailversand (Schulanmeldung) nur mit SMTP bzw. in Entwicklung/E2E einschalten
  if (enabled && m.needsMail && !(opts.mail ?? mailAvailable())) throw new ValidationError({ module: m.needsMail });
  await setModuleEnabled(db, m, enabled);
  await audit(db, actorId, enabled ? "verwaltung.module.enable" : "verwaltung.module.disable", m.id);
}


/** Moduleinstellung ändern (Q5-14): nur deklarierte Schlüssel und Werte, protokolliert mit altem und neuem Wert. */
export async function setModuleSetting(db: Db, actorId: string, m: ModuleManifest, key: string, value: string, perms?: PermissionSet) {
  const decl = m.settings?.find((s) => s.key === key);
  if (!decl) throw new ValidationError({ setting: "Unbekannte Einstellung" });
  // DS-15: Löschfristen u. Ä. brauchen zusätzlich ihr eigenes Recht (z. B. verwaltung.privacy)
  if (decl.permission && (!perms || !hasPermission(perms, decl.permission))) throw new ValidationError({ setting: "Dafür fehlt das Recht „Datenschutz“" });
  if (!decl.options.some((o) => o.value === value)) throw new ValidationError({ setting: "Ungültiger Wert" });
  const before = await readModuleSetting(db, decl);
  if (before === value) return;
  await writeModuleSetting(db, decl, value);
  await audit(db, actorId, "verwaltung.module.setting", m.id, { key, from: before, to: value });
  await decl.onChange?.(db);
}
