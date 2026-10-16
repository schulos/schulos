// Konten der Web-UI des Backupservers (INSTALLATION.md §4.2 „Konten & Protokoll“): alle Konten haben volle Rechte,
// Zwei-Faktor-Anmeldung ist Pflicht. Neue Konten und Zurücksetzen nur durch einen anderen Admin, nie am eigenen Konto.
import { and, asc, count, eq, ne } from "drizzle-orm";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { generatePassword, validatePasswordChange, type PasswordFieldErrors } from "@schulos/server/passwort";
import { audit } from "@/audit";
import { createUserWithPassword, hashPassword, type Auth } from "@/auth/auth";
import type { Db } from "@/db/client";
import { accounts, sessions, twoFactors, users } from "@/db/schema";

export class AccountError extends Error {}

export async function listAccounts(db: Db) {
  return db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      status: users.status,
      twoFactorEnabled: users.twoFactorEnabled,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.name));
}

export interface NewAccount {
  firstName: string;
  lastName: string;
  username: string;
}

/** Neues Konto mit Startpasswort (wird einmal angezeigt); beim ersten Anmelden Pflicht-Wechsel und 2FA-Einrichtung. */
export async function createAccount(db: Db, actorId: string, input: NewAccount): Promise<{ id: string; password: string }> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const username = input.username.trim().toLowerCase();
  if (!firstName || !lastName) throw new AccountError("Vor- und Nachname sind Pflicht.");
  if (!/^[a-z0-9._]{3,30}$/.test(username)) throw new AccountError("Benutzername: 3–30 Zeichen a–z, 0–9, Punkt, Unterstrich.");
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (taken) throw new AccountError("Der Benutzername ist vergeben.");
  const id = crypto.randomUUID();
  const password = generatePassword(12);
  await createUserWithPassword(db, { id, username, firstName, lastName, mustChangePassword: true }, { plain: password });
  await audit(db, actorId, "konto.angelegt", id, { benutzername: username });
  return { id, password };
}

function notSelf(actorId: string, id: string) {
  if (actorId === id) throw new AccountError("Das geht nicht am eigenen Konto – ein anderer Admin muss es tun.");
}

/** Sperren beendet alle Sitzungen; das letzte aktive Konto lässt sich nicht sperren (sonst kommt niemand mehr hinein). */
export async function setLocked(db: Db, actorId: string, id: string, locked: boolean): Promise<void> {
  notSelf(actorId, id);
  if (locked) {
    const [active] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.status, "active"), ne(users.id, id)));
    if ((active?.n ?? 0) === 0) throw new AccountError("Das letzte aktive Konto kann nicht gesperrt werden.");
  }
  await db.transaction(async (tx) => {
    await tx.update(users).set({ status: locked ? "locked" : "active" }).where(eq(users.id, id));
    if (locked) await tx.delete(sessions).where(eq(sessions.userId, id));
  });
  await audit(db, actorId, locked ? "konto.gesperrt" : "konto.entsperrt", id);
}

/** Gerät verloren: zweiten Faktor zurücksetzen – beim nächsten Anmelden neu einrichten (Pflicht). */
export async function resetTwoFactor(db: Db, actorId: string, id: string): Promise<void> {
  notSelf(actorId, id);
  await db.transaction(async (tx) => {
    await tx.delete(twoFactors).where(eq(twoFactors.userId, id));
    await tx.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, id));
    await tx.delete(sessions).where(eq(sessions.userId, id));
  });
  await audit(db, actorId, "konto.2fa_zurueckgesetzt", id);
}

/** Neues Startpasswort; alle Sitzungen enden, beim Anmelden Pflicht-Wechsel. */
export async function resetPassword(db: Db, actorId: string, id: string): Promise<string> {
  notSelf(actorId, id);
  const password = generatePassword(12);
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({ password: hash })
      .where(and(eq(accounts.userId, id), eq(accounts.providerId, "credential")));
    await tx.update(users).set({ mustChangePassword: true }).where(eq(users.id, id));
    await tx.delete(sessions).where(eq(sessions.userId, id));
  });
  await audit(db, actorId, "konto.passwort_zurueckgesetzt", id);
  return password;
}

/** Eigenes Passwort ändern (auch Pflicht-Wechsel): Regeln, Better-Auth (andere Sitzungen enden), Flag löschen, Protokoll. */
export async function changeOwnPassword(
  db: Db,
  auth: Auth,
  headers: Headers,
  user: { id: string; username: string | null; firstName?: string; lastName?: string },
  input: { current: string; next: string; repeat: string },
): Promise<PasswordFieldErrors | null> {
  const invalid = validatePasswordChange(user, input);
  if (invalid) return invalid;
  try {
    await auth.api.changePassword({ body: { currentPassword: input.current, newPassword: input.next, revokeOtherSessions: true }, headers });
  } catch (err) {
    if (isAuthApiError(err) && /password/i.test(err.message)) return { current: "Das bisherige Passwort ist falsch." };
    throw err;
  }
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, user.id));
  await audit(db, user.id, "konto.passwort_geaendert", user.id);
  return null;
}
