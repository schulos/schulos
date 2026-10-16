// SEC-01: 2FA-Pflicht, die vom Ort der Anfrage abhängt – Schüler:innen nur von außerhalb des Schulnetzes (Q-70), und die
// Ersteinrichtung der 2FA nur im Schulnetz oder mit Freigabe der Verwaltung (Q-5A-30). Die ortsunabhängige Pflicht (Rolle,
// Rechte, Stichtag) steht in `twoFactorDuty` (src/core/permissions) und wirkt schon in `loadPermissions`.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { sessions, users, type Role } from "@/core/db/schema";
import { accessBlocked, isDemoDb, type PermissionSet } from "@/core/permissions";
import { cachedSecuritySettings, type SecuritySettings } from "@/core/settings";
import { hasCodeList } from "./codeliste";
import { defaultSchoolNets, networkZone, parseNetList, trustedProxies, type NetworkZone } from "./schulnetz";

/** Schulnetz-Bereiche der Schule (Einstellung, sonst SCHULOS_INTERNAL_NETS bzw. alle privaten Bereiche) */
export function schoolNetsOf(settings: Pick<SecuritySettings, "schoolNets">, env: Record<string, string | undefined> = process.env) {
  return parseNetList(settings.schoolNets ?? defaultSchoolNets(env)).nets;
}

/** Schulnetz oder außen – für diese Anfrage nach den Einstellungen der Schule. */
export async function requestNetwork(db: Db, headers: Headers): Promise<NetworkZone> {
  return networkZone(headers, schoolNetsOf(await cachedSecuritySettings(db)), trustedProxies());
}

/**
 * Rein: Sperre für eine Anmeldung von außen, bei der 2FA nur dort Pflicht ist (Schüler:innen). Mit eingerichteter 2FA muss
 * die Sitzung mit zweitem Faktor entstanden sein (auch in Demo-Instanzen – wie beim Notenbuch); ohne 2FA kommt man von außen
 * nur in Demo-Instanzen herein.
 */
export function outsideBlock(input: {
  outside: boolean;
  has2FA: boolean;
  sessionMarked: boolean;
  demo: boolean;
}): "aussen-code" | "aussen-ohne" | null {
  if (!input.outside) return null;
  if (input.has2FA) return input.sessionMarked ? null : "aussen-code";
  return input.demo ? null : "aussen-ohne";
}

/** Rollen, deren 2FA-Pflicht vom Ort abhängt */
export function outsideOnlyRole(role: Role): boolean {
  return role === "schueler";
}

/**
 * Rechte einer Anfrage um die Ortsregel ergänzen: Schüler:in von außen ohne zweiten Faktor → gesperrt wie Pflicht-2FA
 * (`twoFactorPending`, Grund in `twoFactorReason`). Andere Rollen und schon gesperrte Konten bleiben unverändert.
 */
export async function withNetworkRules(db: Db, headers: Headers, sessionId: string, perms: PermissionSet): Promise<PermissionSet> {
  if (!outsideOnlyRole(perms.role) || accessBlocked(perms)) return perms;
  if ((await requestNetwork(db, headers)) !== "aussen") return perms;
  const [row] = await db
    .select({
      enabled: users.twoFactorEnabled,
      marked: sessions.secondFactorAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, perms.userId)));
  // SEC-02: eine Code-Liste mit unbenutzten Codes zählt wie eingerichtete 2FA
  const has2FA = Boolean(row?.enabled) || (await hasCodeList(db, perms.userId));
  const block = outsideBlock({
    outside: true,
    has2FA,
    sessionMarked: Boolean(row?.marked),
    demo: await isDemoDb(db),
  });
  return block ? { ...perms, twoFactorPending: true, twoFactorReason: block } : perms;
}

/** Freigabe der Verwaltung für die Ersteinrichtung von außen – so lange gültig */
export const SETUP_RELEASE_HOURS = 48;

/**
 * Q-5A-30: Darf diese Person die 2FA jetzt (erstmals) einrichten? Im Schulnetz immer; von außen nur mit Freigabe der
 * Verwaltung (`two_factor_setup_until`) – Ausnahme Eltern (kommen selten in die Schule; Hinweis-Mail statt Freigabe) und
 * Demo-Instanzen. Sonst könnte, wer nur ein Passwort erbeutet hat, die 2FA für sich einrichten (Trust on first use).
 */
export function setupAllowed(input: { network: NetworkZone; role: Role; demo: boolean; releasedUntil: Date | null; now: Date }): boolean {
  if (input.demo || input.network === "schulnetz" || input.role === "eltern") return true;
  return Boolean(input.releasedUntil && input.releasedUntil.getTime() > input.now.getTime());
}

export const SETUP_BLOCKED_TEXT =
  "Die Zwei-Faktor-Anmeldung lässt sich zum ersten Mal nur im Schulnetz einrichten – oder das Sekretariat gibt die Einrichtung von außen für 48 Stunden frei.";

/** Einrichten für diese Anfrage erlaubt? (frisch aus der DB) */
export async function setupAllowedFor(db: Db, headers: Headers, userId: string, now = new Date()): Promise<boolean> {
  const [u] = await db.select({ role: users.role, until: users.twoFactorSetupUntil }).from(users).where(eq(users.id, userId));
  if (!u) return false;
  return setupAllowed({
    network: await requestNetwork(db, headers),
    role: u.role,
    demo: await isDemoDb(db),
    releasedUntil: u.until,
    now,
  });
}

/**
 * Zweiten Faktor (Code-App oder Schlüssel) hinzufügen erlaubt? Wer schon einen hat, hat sich damit angemeldet und ergänzt ohne
 * Schulnetz-Regel (Q-4E-11, G4E-C10 – gilt für Code-App und Schlüssel gleich); sonst die Regel der Ersteinrichtung.
 */
export async function factorAddAllowedFor(db: Db, headers: Headers, userId: string, now = new Date()): Promise<boolean> {
  const [u] = await db.select({ enabled: users.twoFactorEnabled }).from(users).where(eq(users.id, userId));
  if (u?.enabled) return true;
  return setupAllowedFor(db, headers, userId, now);
}
