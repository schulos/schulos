// Betriebsbefehle für schulosctl (B-31, INSTALLATION.md §5): laufen im App-Container über `node cli.mjs <befehl>`
// (src/cli.ts) – mit derselben Konfiguration und Datenbank wie die App, ohne Web-Oberfläche.
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { authThrottle, passkeys, twoFactors, users } from "@/core/db/schema";
import { audit } from "@/core/audit";
import { createUserWithPassword } from "@/core/auth/auth";
import type { FileStorage } from "@/core/files/storage";
import { initializeInstance, instanceTypeInDb, type Env } from "@/core/instance";
import { resetPassword } from "@/modules/verwaltung/users";
import { dropTrustedDevices } from "@/core/auth/geraete-vertrauen";
import { resetSchoolNets } from "@/core/auth/anmelde-einstellungen";

export class OpsError extends Error {}

/**
 * Admin-Zugang wiederherstellen (Passwort vergessen, zweiter Faktor verloren, Konto gesperrt): neues Zufallspasswort
 * (beim nächsten Anmelden zu ändern), zweiter Faktor aus, Konto aktiv, Anmeldesperre aufgehoben, alle Sitzungen beendet.
 * Ohne Benutzernamen nur, wenn es genau ein Admin-Konto gibt. Gibt das Passwort EINMAL zurück.
 */
export async function resetAdmin(db: Db, username?: string): Promise<{ username: string; password: string; schoolNetsReset: boolean }> {
  const admins = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(username ? and(eq(users.role, "admin"), eq(users.username, username.trim().toLowerCase())) : eq(users.role, "admin"));
  if (username && admins.length === 0) throw new OpsError(`Kein Admin-Konto „${username}“`);
  if (admins.length === 0) throw new OpsError("Es gibt kein Admin-Konto");
  if (admins.length > 1)
    throw new OpsError(`Mehrere Admin-Konten (${admins.map((a) => a.username).join(", ")}) – Benutzernamen angeben: schulosctl reset-admin <name>`);
  const admin = admins[0]!;
  const name = admin.username ?? admin.id;

  const password = await resetPassword(db, null, admin.id);
  await db.delete(twoFactors).where(eq(twoFactors.userId, admin.id));
  // SEC-03: Sicherheitsschlüssel ebenso – sonst bliebe 2FA nach dem Zurücksetzen an
  await db.delete(passkeys).where(eq(passkeys.userId, admin.id));
  await db.update(users).set({ twoFactorEnabled: false, status: "active" }).where(eq(users.id, admin.id));
  await db.delete(authThrottle).where(eq(authThrottle.key, `u:${name}`));
  // G4E-S02: auch kein „Gerät vertrauen“ des Kontos
  await dropTrustedDevices(db, admin.id);
  // G4E-C02: wer sich mit falschen Schulnetz-Bereichen ausgesperrt hat, kommt sonst auch als Admin nicht an die Einstellung
  const schoolNetsReset = await resetSchoolNets(db);
  await audit(db, null, "system.admin_zurueckgesetzt", admin.id, { via: "schulosctl" });
  return { username: name, password, schoolNetsReset };
}

export interface ProbeSmoke {
  ok: boolean;
  error?: string;
  details: { tabellen: number; migrationen: number; konten: number; seiten: Record<string, number> };
}

/** Seiten, die der Rauchtest mit dem technischen Konto abruft (Startseite, Stundenplan). */
export const PROBE_PAGES = ["/", "/stundenplan"];

/**
 * Rauchtest im Probelauf (B-32, INSTALLATION.md §5a.3) – läuft im Probelauf-Container gegen dessen eigene App:
 * Health, technisches Konto (Lehrkraft, Zufallspasswort) anlegen, über die Auth-API anmelden, Seiten abrufen,
 * Tabellen/Migrationen/Konten zählen. Das technische Konto wird in jedem Fall wieder gelöscht.
 */
export async function probeSmoke(db: Db, base: string, fetchImpl: typeof fetch = fetch): Promise<ProbeSmoke> {
  const count = async (q: ReturnType<typeof sql>) => rowsOf<{ n: number }>(await db.execute(q))[0]?.n ?? 0;
  const details: ProbeSmoke["details"] = {
    tabellen: await count(sql`select count(*)::int as n from pg_tables where schemaname = 'public'`),
    migrationen: await count(sql`select count(*)::int as n from drizzle.__drizzle_migrations`),
    konten: await count(sql`select count(*)::int as n from users`),
    seiten: {},
  };
  // Benutzernamen erlauben Punkt, keinen Bindestrich (username-Plugin)
  const username = `probelauf.${randomBytes(4).toString("hex")}`;
  const id = `u-${username}`;
  const password = randomBytes(18).toString("base64url");
  try {
    const health = await fetchImpl(`${base}/api/health`);
    if (!health.ok) return { ok: false, error: `Health ${health.status}`, details };
    await createUserWithPassword(db, { id, name: "Probelauf (technisch)", firstName: "Probelauf", lastName: "technisch", username, role: "lehrkraft" }, { plain: password });
    const signIn = await fetchImpl(`${base}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ username, password }),
    });
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (signIn.status !== 200 || !cookie) return { ok: false, error: `Anmeldung ${signIn.status}`, details };
    for (const page of PROBE_PAGES) {
      const r = await fetchImpl(`${base}${page}`, { headers: { cookie }, redirect: "manual" });
      details.seiten[page] = r.status;
      if (r.status !== 200) return { ok: false, error: `Seite ${page}: ${r.status}`, details };
    }
    return { ok: true, details };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), details };
  } finally {
    await db.delete(users).where(eq(users.id, id));
  }
}

/**
 * Demo-Instanz zurücksetzen: alle Tabellen leeren (Schema und Migrationen bleiben) und die Demo-Schule neu einspielen.
 * Nur für Demo-Instanzen – eine Produktivinstanz wird verweigert. Die App muss dabei gestoppt sein (schulosctl erledigt das).
 */
/** `storage`: Dateispeicher der Instanz – Uploads der Demo-Konten fliegen raus, das Demo-Logo kommt neu hinein. */
export async function demoReset(db: Db, env: Env, storage?: FileStorage): Promise<{ users: number }> {
  const type = await instanceTypeInDb(db);
  if (type !== "demo") throw new OpsError("Das ist keine Demo-Instanz – demo-reset ist nur für Demo-Instanzen erlaubt.");
  const tables = rowsOf<{ name: string }>(
    await db.execute(sql`select tablename as name from pg_tables where schemaname = 'public' order by tablename`),
  ).map((r) => `"public"."${r.name.replace(/"/g, '""')}"`);
  if (tables.length) await db.execute(sql.raw(`truncate table ${tables.join(", ")} restart identity cascade`));
  if (storage) for (const f of await storage.list()) await storage.delete(f.key);
  const r = await initializeInstance(db, { ...env, SCHULOS_INSTANCE: "demo" }, new Date(), storage);
  if (r.action !== "seeded-demo") throw new OpsError(`Demo-Schule nicht eingespielt (${r.action})`);
  return { users: r.users };
}
