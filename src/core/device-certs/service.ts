// Gerätezertifikate (P4-40b): Freigabeliste/Sperrliste in der DB, Schuleinstellungen und die Prüfung je Anfrage.
// Die Schul-CA (step-ca) stellt aus (step-ca.ts, issue.ts); ob ein vorgezeigtes Zertifikat gilt, entscheidet **diese** Liste:
// nur ein Zertifikat mit Zeile, ohne Sperre und innerhalb der Laufzeit gilt – Caddy prüft vorher Kette und Laufzeit.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings, deviceCerts, users } from "@/core/db/schema";
import { externalZone, deviceFingerprint, type ExternalZone } from "@/core/external-access";
import { decideExternalAccess, effectivePolicy, STAFF_ROLES, type CertCheck, type ExternalDecision, type ExternalPolicy, type ExternalSettings } from "./policy";

export class DeviceCertError extends Error {}

type Env = Record<string, string | undefined>;

/** Schul-CA eingerichtet? Derselbe Schalter wie für Caddy (`client_auth`): `SCHULOS_DEVICE_CERTS=an` in der `.env` */
export function caConfigured(env: Env = process.env): boolean {
  return env.SCHULOS_DEVICE_CERTS === "an";
}

const KEY_STAFF = "extern.staff_cert";
const KEY_ADMIN = "extern.admin_allowed";

export async function readExternalSettings(db: Db): Promise<ExternalSettings> {
  const rows = await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(inArray(appSettings.key, [KEY_STAFF, KEY_ADMIN]));
  const staff = rows.find((r) => r.key === KEY_STAFF)?.value;
  const admin = rows.find((r) => r.key === KEY_ADMIN)?.value;
  return { staffCert: staff === "an" || staff === "aus" ? staff : null, adminAllowed: typeof admin === "boolean" ? admin : null };
}

export async function readExternalPolicy(db: Db, env: Env = process.env): Promise<ExternalPolicy> {
  return effectivePolicy(await readExternalSettings(db), caConfigured(env));
}

/** Einstellungen ändern – nur im Schulnetz (wer von außen Admin-Rechte hätte, soll sich die Tür nicht selbst öffnen) */
export async function saveExternalSettings(db: Db, actorId: string, zone: ExternalZone, input: ExternalSettings): Promise<void> {
  if (zone !== "intern") throw new DeviceCertError("Diese Einstellung lässt sich nur im Schulnetz ändern.");
  const put = async (key: string, value: unknown) => {
    if (value === null) await db.delete(appSettings).where(eq(appSettings.key, key));
    else await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  };
  await put(KEY_STAFF, input.staffCert);
  await put(KEY_ADMIN, input.adminAllowed);
  await audit(db, actorId, "verwaltung.extern.einstellungen", null, { personalZertifikat: input.staffCert ?? "vorgabe", verwaltungVonAussen: input.adminAllowed ?? "vorgabe" });
}

/**
 * Gilt das vorgezeigte Zertifikat für dieses Konto? `fehlt` ohne Fingerabdruck; `ungueltig`, wenn es nicht in der Liste
 * steht, gesperrt, (noch) nicht gültig oder an ein anderes Konto gebunden ist.
 */
export async function certCheck(db: Db, fingerprint: string | null, userId: string, now = new Date()): Promise<CertCheck> {
  if (!fingerprint) return "fehlt";
  const [row] = await db
    .select({ userId: deviceCerts.userId, notBefore: deviceCerts.notBefore, notAfter: deviceCerts.notAfter, revokedAt: deviceCerts.revokedAt })
    .from(deviceCerts)
    .where(eq(deviceCerts.fingerprint, fingerprint));
  if (!row || row.revokedAt) return "ungueltig";
  if (row.notBefore.getTime() > now.getTime() || row.notAfter.getTime() <= now.getTime()) return "ungueltig";
  if (row.userId !== null && row.userId !== userId) return "ungueltig";
  return row.userId === userId ? "gebunden" : "gueltig";
}

/**
 * Prüfung je Anfrage bzw. beim Anmelden (src/core/auth/session.ts, auth.ts): im Schulnetz ohne DB-Zugriff erlaubt, von
 * außen nach Zone, Rolle, Zertifikat und Schuleinstellungen.
 */
export async function externalAccessFor(db: Db, headers: Headers, user: { id: string; role: string }, now = new Date()): Promise<ExternalDecision> {
  const zone = externalZone(headers);
  if (zone === "intern") return { allowed: true };
  const [policy, cert] = await Promise.all([readExternalPolicy(db), certCheck(db, deviceFingerprint(headers), user.id, now)]);
  return decideExternalAccess({ zone, role: user.role, cert, policy });
}

export type DeviceCertStatus = "gueltig" | "gesperrt" | "abgelaufen" | "noch-nicht-gueltig";

export interface DeviceCertRow {
  id: string;
  label: string;
  commonName: string;
  fingerprint: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  user: { id: string; name: string; username: string | null } | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  status: DeviceCertStatus;
}

export function certStatus(row: { notBefore: Date; notAfter: Date; revokedAt: Date | null }, now = new Date()): DeviceCertStatus {
  if (row.revokedAt) return "gesperrt";
  if (row.notAfter.getTime() <= now.getTime()) return "abgelaufen";
  if (row.notBefore.getTime() > now.getTime()) return "noch-nicht-gueltig";
  return "gueltig";
}

/** Übersicht für Verwaltung → System → Gerätezertifikate (gültige zuerst, dann neueste) */
export async function listDeviceCerts(db: Db, now = new Date()): Promise<DeviceCertRow[]> {
  const rows = await db
    .select({ cert: deviceCerts, userName: users.name, username: users.username })
    .from(deviceCerts)
    .leftJoin(users, eq(users.id, deviceCerts.userId))
    .orderBy(desc(deviceCerts.createdAt));
  const order: Record<DeviceCertStatus, number> = { gueltig: 0, "noch-nicht-gueltig": 1, abgelaufen: 2, gesperrt: 3 };
  return rows
    .map(({ cert: c, userName, username }) => ({
      id: c.id,
      label: c.label,
      commonName: c.commonName,
      fingerprint: c.fingerprint,
      serial: c.serial,
      notBefore: c.notBefore,
      notAfter: c.notAfter,
      user: c.userId ? { id: c.userId, name: userName ?? "", username } : null,
      createdAt: c.createdAt,
      revokedAt: c.revokedAt,
      revokeReason: c.revokeReason,
      status: certStatus(c, now),
    }))
    .sort((a, b) => order[a.status] - order[b.status]);
}

export const REVOKE_REASONS = { verloren: "verloren/gestohlen", ausgemustert: "Gerät ausgemustert", kompromittiert: "Schlüssel kompromittiert", sonstiges: "sonstiges" } as const;
export type RevokeReason = keyof typeof REVOKE_REASONS;

/** Konto für die optionale Bindung: nur Personal-Rollen (Eltern/Schüler:innen brauchen kein Gerätezertifikat) */
export async function staffUserByUsername(db: Db, username: string): Promise<{ id: string; role: string }> {
  const [u] = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.username, username.trim().toLowerCase()));
  if (!u || u.status !== "active") throw new DeviceCertError("Kein aktives Konto mit diesem Benutzernamen.");
  if (!STAFF_ROLES.includes(u.role)) throw new DeviceCertError("Gerätezertifikate lassen sich nur an Konten von Lehrkräften, Personal oder Verwaltung binden.");
  return u;
}

/** Ausgestelltes Zertifikat eintragen (issue.ts) – ab jetzt gilt es */
export async function registerDeviceCert(
  db: Db,
  actorId: string,
  input: { label: string; commonName: string; fingerprint: string; serial: string; notBefore: Date; notAfter: Date; userId: string | null },
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(input.fingerprint)) throw new DeviceCertError("Fingerabdruck ungültig.");
  const [row] = await db
    .insert(deviceCerts)
    .values({ ...input, createdBy: actorId })
    .returning({ id: deviceCerts.id });
  await audit(db, actorId, "verwaltung.geraet.ausgestellt", row!.id, { cn: input.commonName, bis: input.notAfter.toISOString(), gebunden: input.userId !== null });
  return row!.id;
}

/** Sperren – wirkt sofort (jede Anfrage prüft die Liste); nur im Schulnetz */
export async function revokeDeviceCert(db: Db, actorId: string, zone: ExternalZone, id: string, reason: RevokeReason, now = new Date()): Promise<void> {
  if (zone !== "intern") throw new DeviceCertError("Gerätezertifikate lassen sich nur im Schulnetz verwalten.");
  if (!(reason in REVOKE_REASONS)) throw new DeviceCertError("Bitte einen Grund wählen.");
  const done = await db
    .update(deviceCerts)
    .set({ revokedAt: now, revokedBy: actorId, revokeReason: reason })
    .where(and(eq(deviceCerts.id, id), isNull(deviceCerts.revokedAt)))
    .returning({ id: deviceCerts.id });
  if (!done.length) {
    const [exists] = await db.select({ id: deviceCerts.id }).from(deviceCerts).where(eq(deviceCerts.id, id));
    throw new DeviceCertError(exists ? "Dieses Zertifikat ist bereits gesperrt." : "Zertifikat nicht gefunden.");
  }
  await audit(db, actorId, "verwaltung.geraet.gesperrt", id, { grund: reason });
}
