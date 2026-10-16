// P4-70 (Q-52): Passwort vergessen – Link per E-Mail, aber **nur für Konten mit eingerichteter Zwei-Faktor-Anmeldung**
// (Lehrkräfte, Personal, Eltern) und bestätigter echter Adresse. Wer nur das Postfach kapert, kommt damit nicht ins Konto: nach
// dem Reset verlangt die Anmeldung weiter den Code aus der App. Alle anderen Konten setzt das Sekretariat zurück.
//
// Ablauf: Benutzername oder Adresse eingeben → Antwort immer gleich (kein Aufzählen) → Mail mit Link (1 h, nur als SHA-256 in
// `verifications`, ein offener Link je Konto) → neues Passwort nach den Regeln → alle Sitzungen enden, Audit, Hinweis-Mail.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, like, lt, or } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { accounts, sessions, users, verifications, type Role } from "@/core/db/schema";
import { appUrl, enqueueMail } from "@/core/mail";
import { passwordChangedMail, passwordResetMail } from "@/core/mail-templates";
import { endLiveStreams } from "@/core/notifications/bus";
import { consumeRate } from "@/core/rate-limit";
import { checkPassword } from "@schulos/server/passwort";
import { realEmail } from "./email";
import { dropTrustedDevices } from "./geraete-vertrauen";

export const RESET_ROLES: readonly Role[] = ["lehrkraft", "personal", "eltern"];
export const RESET_HOURS = 1;
const PREFIX = "password-reset:";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class PasswordResetError extends Error {}

/** Rein: darf dieses Konto per Mail zurücksetzen? */
export function resetEligible(u: { role: Role; status: string; twoFactorEnabled: boolean; emailVerified: boolean; email: string }): boolean {
  return u.status === "active" && RESET_ROLES.includes(u.role) && u.twoFactorEnabled && u.emailVerified && realEmail(u.email) !== null;
}

/** Antwort für die Oberfläche – immer dieselbe, ob es das Konto gibt oder nicht */
export const RESET_REQUESTED_TEXT =
  "Wenn es zu dieser Angabe ein Konto mit bestätigter E-Mail-Adresse und Zwei-Faktor-Anmeldung gibt, ist ein Link unterwegs. Er gilt eine Stunde. Ohne Zwei-Faktor-Anmeldung setzt das Sekretariat das Passwort zurück.";

/**
 * Link anfordern. `ip` ist das gekürzte Subjekt der Client-Adresse (Rate-Limit). Liefert den Link (nur für Tests) oder null –
 * die Oberfläche zeigt immer `RESET_REQUESTED_TEXT`.
 */
export async function requestPasswordReset(db: Db, raw: string, opts: { school: string; ip: string; now?: Date }): Promise<string | null> {
  const now = opts.now ?? new Date();
  const input = raw.trim().toLowerCase();
  if (!input || input.length > 200) return null;
  if (!(await consumeRate(db, "passwort.reset.ip", opts.ip, now)).allowed) return null;
  const [u] = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      status: users.status,
      twoFactorEnabled: users.twoFactorEnabled,
      emailVerified: users.emailVerified,
      email: users.email,
    })
    .from(users)
    .where(or(eq(users.username, input), eq(users.email, input)));
  if (!u || !resetEligible(u)) return null;
  if (!(await consumeRate(db, "passwort.reset.konto", u.id, now)).allowed) return null;
  // ein offener Link je Konto; abgelaufene Links aller Konten gleich mit aufräumen
  await db
    .delete(verifications)
    .where(and(like(verifications.identifier, `${PREFIX}%`), or(eq(verifications.value, u.id), lt(verifications.expiresAt, now))));
  const token = randomBytes(32).toString("base64url");
  await db.insert(verifications).values({
    id: crypto.randomUUID(),
    identifier: `${PREFIX}${hashToken(token)}`,
    value: u.id,
    expiresAt: new Date(now.getTime() + RESET_HOURS * 3_600_000),
    createdAt: now,
    updatedAt: now,
  });
  const link = appUrl(`/passwort-vergessen/${token}`);
  await enqueueMail(
    db,
    { to: realEmail(u.email)!, ...passwordResetMail({ school: opts.school, name: u.name, link }), purpose: "passwort-reset" },
    now,
  );
  await audit(db, u.id, "konto.passwort.reset_angefordert", u.id);
  return link;
}

/** Konto zum Link – oder null (unbekannt, abgelaufen, Konto nicht mehr berechtigt). */
export async function pendingPasswordReset(db: Db, token: string, now = new Date()): Promise<{ userId: string; name: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await db
    .select()
    .from(verifications)
    .where(eq(verifications.identifier, `${PREFIX}${hashToken(token)}`));
  if (!row || row.expiresAt <= now) return null;
  const [u] = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      status: users.status,
      twoFactorEnabled: users.twoFactorEnabled,
      emailVerified: users.emailVerified,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, row.value));
  return u && resetEligible(u) ? { userId: u.id, name: u.name } : null;
}

/** Neues Passwort setzen: Regeln, Link verbraucht, alle Sitzungen beendet, Audit, Hinweis-Mail. Feldfehler als Error. */
export async function completePasswordReset(
  db: Db,
  token: string,
  input: { next: string; repeat: string },
  opts: { school: string; now?: Date },
): Promise<void> {
  const now = opts.now ?? new Date();
  const pending = await pendingPasswordReset(db, token, now);
  if (!pending) throw new PasswordResetError("Der Link ist ungültig oder abgelaufen. Bitte einen neuen anfordern.");
  const [u] = await db
    .select({ username: users.username, firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(eq(users.id, pending.userId));
  const problem = checkPassword(input.next, u ?? {});
  if (problem) throw new PasswordResetError(problem);
  if (input.next !== input.repeat) throw new PasswordResetError("Die beiden Eingaben stimmen nicht überein.");
  const hash = await hashPassword(input.next);
  // G4E-C12: Link verbrauchen, Passwort setzen, Sitzungen beenden – ganz oder gar nicht (sonst wäre der Link verbraucht, ohne
  // dass das Passwort gilt, oder fremde Sitzungen blieben trotz „alle Geräte abgemeldet“)
  await db.transaction(async (tx) => {
    const used = await tx
      .delete(verifications)
      .where(eq(verifications.identifier, `${PREFIX}${hashToken(token)}`))
      .returning({ id: verifications.id });
    if (used.length === 0) throw new PasswordResetError("Der Link wurde schon benutzt.");
    await tx
      .update(accounts)
      .set({ password: hash })
      .where(and(eq(accounts.userId, pending.userId), eq(accounts.providerId, "credential")));
    await tx.update(users).set({ mustChangePassword: false }).where(eq(users.id, pending.userId));
    // alle Sitzungen enden (beim Reset gibt es keine eigene) – der zweite Faktor bleibt Pflicht bei der nächsten Anmeldung
    await tx.delete(sessions).where(eq(sessions.userId, pending.userId));
    // G4E-S02: auch kein „Gerät vertrauen“ – sonst reichte nach dem Reset das neue Passwort allein
    await dropTrustedDevices(tx, pending.userId);
    await audit(tx, pending.userId, "konto.passwort.reset_mail", pending.userId);
  });
  endLiveStreams(pending.userId);
  const to = realEmail(u?.email);
  if (to) await enqueueMail(db, { to, ...passwordChangedMail({ school: opts.school, name: pending.name }), purpose: "passwort-geaendert" }, now);
}
