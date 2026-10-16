import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { grants, groupMembers, users, type Role } from "@/core/db/schema";
import { cachedSecuritySettings, isDemoDb } from "@/core/settings";
import { toBerlinDate } from "@/core/time";

export { isDemoDb };

/**
 * Rechte heißen „<modul>.<aktion>", z. B. "news.write" oder "aufgaben.create".
 * Ein Grant darf ein Wildcard sein: "news.*" deckt alle News-Rechte ab, "*" alles.
 *
 * Auswertungsreihenfolge:
 *  1. gesperrte Benutzer dürfen nichts – ebenso Konten mit Startpasswort und Pflicht-2FA-Konten ohne zweiten Faktor
 *  2. Rolle "admin" darf alles
 *  3. Grant an die eigene Rolle
 *  4. Grant an eine Gruppe, in der man Mitglied ist
 *  5. "group.*"-Rechte hat die Leitung der im Kontext genannten Gruppe automatisch
 */
export interface PermissionSet {
  userId: string;
  role: Role;
  locked: boolean;
  /** 2FA ist Pflicht (twoFactorDuty bzw. von außen), aber noch nicht eingerichtet/angemeldet – bis dahin keine Rechte */
  twoFactorPending?: boolean;
  /**
   * SEC-01: Warum gesperrt? `aussen-code` = von außen, Konto hat 2FA, Sitzung ohne zweiten Faktor (neu mit Code anmelden bzw.
   * Code von der Liste); `aussen-ohne` = von außen ohne eingerichtete 2FA. Ohne Angabe: Pflicht-2FA nicht eingerichtet.
   */
  twoFactorReason?: "aussen-code" | "aussen-ohne";
  /** SEC-01: 2FA wird an diesem Tag Pflicht (YYYY-MM-DD) – bis dahin Hinweis statt Sperre */
  twoFactorDueOn?: string;
  /** Startpasswort noch nicht geändert (B-11) – bis dahin keine Rechte */
  passwordChangePending?: boolean;
  /** Effektive Grants aus Rolle + Gruppen (inkl. Wildcards) */
  granted: ReadonlySet<string>;
  memberOf: ReadonlySet<string>;
  leaderOf: ReadonlySet<string>;
}

/**
 * Darf dieses Konto überhaupt etwas? Gesperrt, Startpasswort offen oder Pflicht-2FA nicht eingerichtet → nein. Seiten und
 * Server Actions leiten dann um (requireUser); Route Handler unter /api antworten mit 401/403 (apiUser, B-55).
 */
export function accessBlocked(perms: PermissionSet): "gesperrt" | "passwort" | "zwei-faktor" | null {
  if (perms.locked) return "gesperrt";
  if (perms.passwordChangePending) return "passwort";
  if (perms.twoFactorPending) return "zwei-faktor";
  return null;
}

export interface PermissionContext {
  groupId?: string;
}

export class ForbiddenError extends Error {
  constructor(public readonly permission: string) {
    super(`Keine Berechtigung: ${permission}`);
    this.name = "ForbiddenError";
  }
}

/** Prüft, ob ein Grant-Muster ein konkretes Recht abdeckt. */
export function grantCovers(pattern: string, permission: string): boolean {
  if (pattern === "*" || pattern === permission) return true;
  if (pattern.endsWith(".*")) return permission.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Recht **ausdrücklich** vergeben (Rollen- oder Gruppen-Grant, auch `<modul>.*`)? Anders als `hasPermission` zählen die Rolle
 * `admin` und der Grant `*` nicht – für Module ohne Admin-Override wie das Notenbuch (F5-05).
 */
export function hasExplicitGrant(perms: PermissionSet, permission: string): boolean {
  if (accessBlocked(perms)) return false;
  for (const g of perms.granted) if (g !== "*" && grantCovers(g, permission)) return true;
  return false;
}

/**
 * 2FA-Pflicht **sofort** (DATENSCHUTZ.md §5): Admin, Verwaltung und alle mit Verwaltungsrechten (Schulleitung bekommt
 * „verwaltung.*“ über ihre Gruppe) – an den Rechten festgemacht, nicht an Gruppennamen. Rolle `beratung` (Q5-17) sofort: neue
 * Rolle ohne Bestandskonten, Kontakt zu Schüler:innen und Eltern in heiklen Lagen. Alle übrigen Erwachsenen ab dem Stichtag
 * der Schule (SEC-01, `twoFactorDuty`).
 */
export function requiresTwoFactor(role: Role, granted: Iterable<string>): boolean {
  if (role === "admin" || role === "verwaltung" || role === "beratung") return true;
  for (const g of granted) if (g === "*" || g.startsWith("verwaltung.")) return true;
  return false;
}

/** SEC-01 (Q-70): Rollen, für die 2FA ab dem Stichtag der Schule Pflicht ist (Übergangsfrist mit Hinweis). */
export const TWO_FACTOR_DEADLINE_ROLES: readonly Role[] = ["lehrkraft", "personal", "eltern"];

export interface TwoFactorDuty {
  /** jetzt Pflicht (unabhängig vom Ort der Anmeldung) */
  required: boolean;
  /** Pflicht ab diesem Tag (YYYY-MM-DD), bis dahin nur Hinweis – nur vor dem Stichtag gesetzt */
  dueOn: string | null;
  /** Schüler:innen: Pflicht nur bei Anmeldung von außerhalb des Schulnetzes */
  outsideOnly: boolean;
}

/**
 * SEC-01: 2FA-Pflicht eines Kontos (ohne Demo – das prüft der Aufrufer). Verwaltungsrechte/Admin/Beratung sofort; Lehrkräfte,
 * Personal und Eltern ab dem Stichtag (`from`, YYYY-MM-DD; ohne Stichtag keine Pflicht); Schüler:innen nur von außen.
 */
export function twoFactorDuty(role: Role, granted: Iterable<string>, from: string | null, today: string): TwoFactorDuty {
  if (requiresTwoFactor(role, granted)) return { required: true, dueOn: null, outsideOnly: false };
  if (TWO_FACTOR_DEADLINE_ROLES.includes(role)) {
    if (from && today >= from) return { required: true, dueOn: null, outsideOnly: false };
    return { required: false, dueOn: from, outsideOnly: false };
  }
  return { required: false, dueOn: null, outsideOnly: role === "schueler" };
}

/** Reine Auswertung – ohne DB, damit sie vollständig unit-testbar ist. */
export function hasPermission(set: PermissionSet, permission: string, ctx: PermissionContext = {}): boolean {
  if (set.locked || set.twoFactorPending || set.passwordChangePending) return false;
  if (set.role === "admin") return true;
  for (const g of set.granted) if (grantCovers(g, permission)) return true;
  if (permission.startsWith("group.") && ctx.groupId && set.leaderOf.has(ctx.groupId)) return true;
  return false;
}

/** Lädt alles, was für Rechteprüfungen eines Benutzers nötig ist (2 Queries). */
export async function loadPermissions(db: Db, userId: string, now = new Date()): Promise<PermissionSet> {
  const [user] = await db
    .select({ id: users.id, role: users.role, status: users.status, twoFactorEnabled: users.twoFactorEnabled, mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new Error(`Benutzer ${userId} nicht gefunden`);

  const memberships = await db
    .select({ groupId: groupMembers.groupId, role: groupMembers.role })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  const memberOf = new Set(memberships.map((m) => m.groupId));
  const leaderOf = new Set(memberships.filter((m) => m.role === "leader").map((m) => m.groupId));

  const targets = [eq(grants.role, user.role)];
  if (memberOf.size > 0) targets.push(inArray(grants.groupId, [...memberOf]));
  const rows = await db
    .select({ permission: grants.permission })
    .from(grants)
    .where(or(...targets));

  const granted = new Set(rows.map((r) => r.permission));
  // Demo-Instanzen (öffentliche Demo-Passwörter) erzwingen 2FA nicht; einrichten lässt sie sich trotzdem
  const demo = await isDemoDb(db);
  const duty = twoFactorDuty(user.role, granted, (await cachedSecuritySettings(db)).twoFactorFrom, toBerlinDate(now));
  const twoFactorPending = !user.twoFactorEnabled && duty.required && !demo;

  return {
    userId: user.id,
    role: user.role,
    locked: user.status === "locked",
    twoFactorPending,
    ...(!user.twoFactorEnabled && !demo && duty.dueOn ? { twoFactorDueOn: duty.dueOn } : {}),
    passwordChangePending: user.mustChangePassword,
    granted,
    memberOf,
    leaderOf,
  };
}

export async function can(db: Db, userId: string, permission: string, ctx?: PermissionContext) {
  return hasPermission(await loadPermissions(db, userId), permission, ctx);
}

/** Wirft ForbiddenError, wenn das Recht fehlt. Für Server Actions. */
export function assertPermission(set: PermissionSet, permission: string, ctx?: PermissionContext): void {
  if (!hasPermission(set, permission, ctx)) throw new ForbiddenError(permission);
}

/**
 * Aktive Konten, die ein Recht haben: Admins, Rollen- und Gruppen-Grants (inkl. Wildcards). Für Benachrichtigungen an
 * Zuständige (z. B. Moderation) – die automatischen „group.*“-Rechte der Gruppenleitung sind hier nicht enthalten.
 */
export async function usersWithPermission(db: Db, permission: string): Promise<string[]> {
  const rows = (await db.select({ permission: grants.permission, role: grants.role, groupId: grants.groupId }).from(grants)).filter((g) => grantCovers(g.permission, permission));
  const roles = [...new Set(rows.flatMap((r) => (r.role ? [r.role] : [])))] as Role[];
  const groupIds = [...new Set(rows.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
  const ids = new Set<string>();
  const active = eq(users.status, "active");
  (await db.select({ id: users.id }).from(users).where(and(inArray(users.role, ["admin", ...roles]), active))).forEach((u) => ids.add(u.id));
  if (groupIds.length) {
    const members = await db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(inArray(groupMembers.groupId, groupIds), active));
    members.forEach((m) => ids.add(m.id));
  }
  return [...ids];
}
