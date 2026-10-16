// Schutz vor Rechteausweitung in der Verwaltung (SEC-04).
//
// Grundsatz: Niemand vergibt mehr Rechte, als er selbst hat, und niemand erweitert die eigenen Rechte – das machen andere
// bzw. ein Admin. Konkret:
//  - Rolle „Admin“ vergeben/entziehen und Admin-Konten verwalten (bearbeiten, sperren, Abgang, Passwort/2FA zurücksetzen,
//    löschen) darf nur ein Admin.
//  - Eine Rolle vergeben bzw. ein Konto verwalten darf nur, wer alle VERWALTUNGSRECHTE (`verwaltung.*`, `*`) der Rolle bzw.
//    des Kontos selbst hat – sonst könnte das Sekretariat z. B. das Konto der Schulleitung (Gruppe mit `verwaltung.*`)
//    per Passwort-Reset übernehmen. Alltagsrechte einer Rolle (z. B. `aufgaben.create` der Lehrkräfte) zählen hier bewusst
//    nicht: die vergibt die Rechteverwaltung als Grundausstattung, und das Sekretariat muss Lehrkräfte anlegen können.
//  - Gruppen mit eigenen Rechten: Mitglieder aufnehmen nur, wer ALLE Rechte der Gruppe selbst hat; sich selbst aufnehmen nie.
//  - Rechteverwaltung: nur Rechte vergeben, die man selbst hat; nicht an die eigene Rolle oder eigene Gruppen.
// Die eigene Rolle ändert niemand selbst (users.ts). Prüfung im Service – die Oberfläche blendet nur aus.
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { grants, users, type Role } from "@/core/db/schema";
import { grantCovers, loadPermissions, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "./users";

/** Handelnde Person; `null` = System (Kommandozeile, Schuljahreswechsel-Automatik) darf alles. */
export interface Actor {
  id: string | null;
  role: Role | null;
  isAdmin: boolean;
  granted: ReadonlySet<string>;
  memberOf: ReadonlySet<string>;
}

const SYSTEM: Actor = { id: null, role: null, isAdmin: true, granted: new Set(["*"]), memberOf: new Set() };
const NOBODY = (id: string): Actor => ({ id, role: null, isAdmin: false, granted: new Set(), memberOf: new Set() });

/** Rechte, mit denen man Konten, Rechte, System oder Datenschutz verwaltet. */
export const isAdminRight = (permission: string) => permission === "*" || permission.startsWith("verwaltung.");

export function actorFromPerms(p: PermissionSet): Actor {
  return { id: p.userId, role: p.role, isAdmin: p.role === "admin", granted: p.granted, memberOf: p.memberOf };
}

/** Lädt die Rechte der handelnden Person; unbekannte IDs dürfen nichts (fail closed). */
export async function loadActor(db: Db, actorId: string | null): Promise<Actor> {
  if (actorId === null) return SYSTEM;
  try {
    return actorFromPerms(await loadPermissions(db, actorId));
  } catch {
    return NOBODY(actorId);
  }
}

/** Hat die handelnde Person dieses Recht (bzw. dieses Muster, z. B. „news.*“) selbst? */
export function actorHas(a: Actor, permission: string): boolean {
  if (a.isAdmin) return true;
  for (const g of a.granted) if (grantCovers(g, permission)) return true;
  return false;
}

async function roleGrants(db: Db, role: Role): Promise<string[]> {
  return (await db.select({ p: grants.permission }).from(grants).where(eq(grants.role, role))).map((r) => r.p);
}

export async function groupGrants(db: Db, groupId: string): Promise<string[]> {
  return (await db.select({ p: grants.permission }).from(grants).where(eq(grants.groupId, groupId))).map((r) => r.p);
}

/** Welche Rollen darf diese Person vergeben? (für das Auswahlfeld) */
export async function assignableRoles(db: Db, a: Actor, roles: readonly Role[]): Promise<Role[]> {
  const out: Role[] = [];
  for (const r of roles) if ((await roleProblem(db, a, r)) === null) out.push(r);
  return out;
}

async function roleProblem(db: Db, a: Actor, role: Role): Promise<string | null> {
  if (a.isAdmin) return null;
  if (role === "admin") return "Die Rolle Admin kann nur ein Admin vergeben.";
  const lacking = (await roleGrants(db, role)).filter(isAdminRight).filter((p) => !actorHas(a, p));
  return lacking.length ? "Diese Rolle hat Verwaltungsrechte, die du selbst nicht hast. Das kann nur ein Admin." : null;
}

/** Darf `a` einem Konto diese Rolle geben? */
export async function assertMayAssignRole(db: Db, a: Actor, role: Role): Promise<void> {
  const problem = await roleProblem(db, a, role);
  if (problem) throw new ValidationError({ role: problem });
}

/** Grund, warum `a` dieses Konto nicht verwalten darf – oder null. */
export async function manageProblem(db: Db, a: Actor, targetId: string): Promise<string | null> {
  if (a.isAdmin) return null;
  const [t] = await db.select({ role: users.role }).from(users).where(eq(users.id, targetId));
  if (!t) return null; // „gibt es nicht“ melden die Aufrufer selbst
  if (t.role === "admin") return "Admin-Konten kann nur ein Admin verwalten.";
  const theirs = await loadPermissions(db, targetId);
  const lacking = [...theirs.granted].filter(isAdminRight).filter((p) => !actorHas(a, p));
  return lacking.length ? "Dieses Konto hat Verwaltungsrechte, die du selbst nicht hast. Das kann nur ein Admin." : null;
}

/** Darf `a` dieses Konto verwalten (bearbeiten, sperren, Abgang, Passwort/2FA zurücksetzen, löschen)? */
export async function assertMayManage(db: Db, a: Actor, targetId: string, field = "account"): Promise<void> {
  const problem = await manageProblem(db, a, targetId);
  if (problem) throw new ValidationError({ [field]: problem });
}

/** Darf `a` diese Personen in die Gruppe aufnehmen? Nur relevant für Gruppen mit eigenen Rechten. */
export async function assertMayAddToGroup(db: Db, a: Actor, groupId: string, userIds: readonly string[]): Promise<void> {
  if (a.isAdmin) return;
  const gg = await groupGrants(db, groupId);
  if (gg.length === 0) return;
  if (a.id && userIds.includes(a.id)) {
    throw new ValidationError({ member: "Diese Gruppe hat eigene Rechte. Dich selbst kann hier nur jemand anderes aufnehmen." });
  }
  if (gg.some((p) => !actorHas(a, p))) {
    throw new ValidationError({ member: "Diese Gruppe hat Rechte, die du selbst nicht hast. Mitglieder kann hier nur ein Admin aufnehmen." });
  }
}

/** Darf `a` dieses Recht an eine Rolle bzw. Gruppe vergeben? */
export function assertMayGrant(a: Actor, permission: string, to: { role: Role } | { groupId: string }): void {
  if (a.isAdmin) return;
  if (!actorHas(a, permission)) throw new ValidationError({ permission: "Dieses Recht hast du selbst nicht – vergeben kann es nur ein Admin." });
  if ("role" in to && to.role === a.role) throw new ValidationError({ permission: "Die Rechte deiner eigenen Rolle kann nur ein Admin erweitern." });
  if ("groupId" in to && a.memberOf.has(to.groupId)) {
    throw new ValidationError({ permission: "Die Rechte einer Gruppe, in der du selbst bist, kann nur ein Admin erweitern." });
  }
}
