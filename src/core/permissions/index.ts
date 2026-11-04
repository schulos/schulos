import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
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
  /**
   * GT-15: befristetes Konto einer externen Ganztags-Leitung (`users.expires_on` gesetzt). Ohne Rollen-/Gruppen-Grants und ohne
   * „group.*“-Rechte der Leitung; Module nur aus {@link EXTERNAL_MODULES} (siehe {@link moduleAllowed}).
   */
  external?: boolean;
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
 * SP-02 (Q-SP-5): Planungsrechte zählen für die 2FA-Pflicht wie Verwaltungsrechte – sie zeigen Deputate aller Lehrkräfte und
 * Abwesenheiten mit Grund „krank“. Kein Verwaltungsrecht im Sinne von S28 (keine Außen-Sperre). SP3-03: ebenso `stundenplan.review`
 * (Planentwürfe mit Lehrkräften und Deputaten).
 */
export const PLANNING_PERMISSIONS = ["stundenplan.manage", "stundenplan.substitute", "stundenplan.review"] as const;

/**
 * 2FA-Pflicht **sofort** (DATENSCHUTZ.md §5): Admin, Verwaltung und alle mit Verwaltungsrechten (Schulleitung bekommt
 * „verwaltung.*“ über ihre Gruppe) – an den Rechten festgemacht, nicht an Gruppennamen. Ebenso Planungsrechte
 * (`stundenplan.manage`/`stundenplan.substitute`, auch über `stundenplan.*`; SP-02). Rolle `beratung` (Q5-17) sofort: neue
 * Rolle ohne Bestandskonten, Kontakt zu Schüler:innen und Eltern in heiklen Lagen. Alle übrigen Erwachsenen ab dem Stichtag
 * der Schule (SEC-01, `twoFactorDuty`).
 */
export function requiresTwoFactor(role: Role, granted: Iterable<string>): boolean {
  if (role === "admin" || role === "verwaltung" || role === "beratung") return true;
  for (const g of granted) {
    if (g === "*" || g.startsWith("verwaltung.")) return true;
    if (PLANNING_PERMISSIONS.some((p) => grantCovers(g, p))) return true;
  }
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
export function twoFactorDuty(role: Role, granted: Iterable<string>, from: string | null, today: string, opts: { temporary?: boolean } = {}): TwoFactorDuty {
  // GT-13: befristete Konten (externe Leitungen) brauchen die 2FA sofort, unabhängig vom Stichtag
  if (opts.temporary || requiresTwoFactor(role, granted)) return { required: true, dueOn: null, outsideOnly: false };
  if (TWO_FACTOR_DEADLINE_ROLES.includes(role)) {
    if (from && today >= from) return { required: true, dueOn: null, outsideOnly: false };
    return { required: false, dueOn: from, outsideOnly: false };
  }
  return { required: false, dueOn: null, outsideOnly: role === "schueler" };
}

/**
 * GT-15 (Projektleitung 04.11.2026): Module, die befristete Konten externer Ganztags-Leitungen nutzen dürfen – nur der Ganztag
 * (eigene Angebote, Anwesenheitslisten). Alles andere (Adressbuch, Messenger, News, Dateien, Raumfinder …) ist für sie zu:
 * Seiten (404), Server Actions, API-Routen, Navigation, Startseite, Suche, Gong und Live-Ereignisse. Konto, Passwort, 2FA und
 * Profilbild gehören zum Kern und bleiben offen. Benachrichtigungen kommen außerdem aus `verwaltung` (Kontohinweise, z. B. 2FA).
 */
export const EXTERNAL_MODULES: readonly string[] = ["ganztag"];
/** Absender von Benachrichtigungen, die auch externe Konten bekommen (Kontohinweise kommen von „verwaltung“). */
export const EXTERNAL_NOTIFY_MODULES: readonly string[] = [...EXTERNAL_MODULES, "verwaltung"];
/** API-Routen für externe Konten (alles andere unter /api antwortet 403): Ganztag, Gong-Strom, Profilbilder, eigener Export. */
export const EXTERNAL_API_PREFIXES: readonly string[] = ["/api/ganztag/", "/api/gong/", "/api/profilbild/", "/api/eigenexport"];

/** Darf dieses Konto das Modul nutzen? Für alle außer externen Konten ja (Rechte prüft das Modul selbst). */
export function moduleAllowed(set: Pick<PermissionSet, "external">, moduleId: string): boolean {
  return !set.external || EXTERNAL_MODULES.includes(moduleId);
}

/** GT-15: API-Pfad für externe Konten erlaubt? */
export function externalApiAllowed(pathname: string): boolean {
  return EXTERNAL_API_PREFIXES.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}

/**
 * GT-16 (Projektleitung 04.11.2026): SQL-Bedingung „kein externes Konto“ (`users.expires_on` leer) – die EINE Stelle für
 * Personen- und Empfängerauswahlen außerhalb des Ganztags (Adressbuch, Messenger, Ansprechpersonen, Raumverantwortliche,
 * Umfrage- und News-Zielgruppen). Externe Leitungen können dort nichts lesen; im Ganztag selbst bleiben sie sichtbar.
 * Zählungen und Statistiken des Personals bleiben unverändert.
 */
export function internalAccount(): SQL {
  return isNull(users.expiresOn);
}

/** GT-16: Externe Konten aus einer Liste von Konto-IDs entfernen (Reihenfolge bleibt). */
export async function withoutExternalAccounts(db: Db, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [...userIds];
  const external = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...new Set(userIds)]), isNotNull(users.expiresOn)));
  if (external.length === 0) return [...userIds];
  const skip = new Set(external.map((u) => u.id));
  return userIds.filter((id) => !skip.has(id));
}

/** GT-16: Ist das Konto extern (befristet)? Für Prüfungen beim Anlegen von Chats und Zuordnungen. */
export async function isExternalAccount(db: Db, userId: string): Promise<boolean> {
  const [u] = await db.select({ expiresOn: users.expiresOn }).from(users).where(eq(users.id, userId));
  return !!u && u.expiresOn !== null;
}

/** Reine Auswertung – ohne DB, damit sie vollständig unit-testbar ist. */
export function hasPermission(set: PermissionSet, permission: string, ctx: PermissionContext = {}): boolean {
  if (set.locked || set.twoFactorPending || set.passwordChangePending) return false;
  if (set.role === "admin") return true;
  for (const g of set.granted) if (grantCovers(g, permission)) return true;
  // GT-15: externe Leitungen bekommen keine „group.*“-Rechte (Mitglieder, Bereiche) – der Ganztag prüft die Leitung selbst
  if (permission.startsWith("group.") && ctx.groupId && !set.external && set.leaderOf.has(ctx.groupId)) return true;
  return false;
}

/** Lädt alles, was für Rechteprüfungen eines Benutzers nötig ist (2 Queries). */
export async function loadPermissions(db: Db, userId: string, now = new Date()): Promise<PermissionSet> {
  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      twoFactorEnabled: users.twoFactorEnabled,
      mustChangePassword: users.mustChangePassword,
      expiresOn: users.expiresOn,
    })
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

  // GT-15: befristete Konten (nur externe Ganztags-Leitungen) bekommen keine Grants – weder die der Rolle `personal` noch über
  // Gruppen; der Ganztag prüft die Leitung des eigenen Angebots über `leaderOf`
  const external = user.expiresOn !== null;
  const granted = external ? new Set<string>() : new Set(rows.map((r) => r.permission));
  // Demo-Instanzen (öffentliche Demo-Passwörter) erzwingen 2FA nicht; einrichten lässt sie sich trotzdem
  const demo = await isDemoDb(db);
  const today = toBerlinDate(now);
  const duty = twoFactorDuty(user.role, granted, (await cachedSecuritySettings(db)).twoFactorFrom, today, { temporary: external });
  const twoFactorPending = !user.twoFactorEnabled && duty.required && !demo;

  return {
    userId: user.id,
    role: user.role,
    // GT-13: befristetes Konto nach dem Ablauftag sofort ohne Rechte (der Tageslauf sperrt es danach auch formal)
    locked: user.status === "locked" || (user.expiresOn !== null && user.expiresOn < today),
    twoFactorPending,
    ...(!user.twoFactorEnabled && !demo && duty.dueOn ? { twoFactorDueOn: duty.dueOn } : {}),
    passwordChangePending: user.mustChangePassword,
    ...(external ? { external: true } : {}),
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
  // GT-15: externe Konten (befristet) haben keine Grants – auch nicht über einen Grant an `personal` oder eine Gruppe
  const active = and(eq(users.status, "active"), isNull(users.expiresOn));
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
