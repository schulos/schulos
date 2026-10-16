import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { nextCookies } from "better-auth/next-js";
import { twoFactor, username } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { DISABLED_AUTH_PATHS } from "@schulos/server/auth-paths";
import { PASSWORD_MAX, PASSWORD_MIN } from "@schulos/server/passwort";
import { audit } from "@/audit";
import { getDb, type Db } from "@/db/client";
import { accounts, sessions, twoFactors, users, verifications } from "@/db/schema";
import { loginThrottle } from "./throttle";

const DEV_SECRET = "schulos-backup-dev-secret-nicht-fuer-produktion-0123";

/** App-Geheimnis (Sitzungen, Verschlüsselung von Geheimnissen in der DB). */
export function appSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production" && !process.env.SCHULOS_ALLOW_DEV_SECRET) throw new Error("BETTER_AUTH_SECRET fehlt");
  return DEV_SECRET;
}

export function createAuth(db: Db) {
  return betterAuth({
    secret: appSecret(),
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3100",
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications, twoFactor: twoFactors },
    }),
    // Konten legt nur der Erststart bzw. ein Admin an – keine Selbstregistrierung
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: PASSWORD_MIN, maxPasswordLength: PASSWORD_MAX },
    // SEC-04: E-Mail-Anmeldung, Selbständerung von Name/Benutzername, 2FA-Abschalten usw. nicht über HTTP (nur Server Actions)
    disabledPaths: DISABLED_AUTH_PATHS,
    // Kürzer als im Hauptsystem: hier liegen die Schlüssel zu allen Sicherungen
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    advanced: {
      // Cookies gelten je Host, nicht je Port – eigener Präfix, damit sich Backup und Hauptsystem auf einem Rechner nicht abmelden
      cookiePrefix: "schulos-backup",
      useSecureCookies: (process.env.BETTER_AUTH_URL ?? "").startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    user: {
      additionalFields: {
        firstName: { type: "string", input: false },
        lastName: { type: "string", input: false },
        status: { type: "string", input: false },
        mustChangePassword: { type: "boolean", input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Gesperrte Konten bekommen keine Sitzung
          before: async (session) => {
            const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, session.userId));
            if (u?.status === "locked") throw new APIError("FORBIDDEN", { message: "Dieses Konto ist gesperrt." });
          },
          after: async (session) => {
            await audit(db, session.userId, "konto.anmeldung", session.userId);
          },
        },
      },
    },
    // Für direkte HTTP-Aufrufe von /api/auth (Server Actions laufen über auth.api – dafür loginThrottle)
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/*": { window: 60, max: 10 }, "/two-factor/*": { window: 60, max: 10 } },
    },
    plugins: [username({ immutableUsername: true }), loginThrottle(db), twoFactor({ issuer: "SchulOS Backup", twoFactorTable: "twoFactor", trustDeviceMaxAge: 0 }), nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __backupAuth?: Promise<Auth> };

export function getAuth(): Promise<Auth> {
  globalForAuth.__backupAuth ??= getDb().then(createAuth);
  return globalForAuth.__backupAuth;
}

/** Konto samt Passwort anlegen (Erststart, später Kontenverwaltung). */
export async function createUserWithPassword(
  db: Db,
  user: { id: string; username: string; firstName: string; lastName: string; mustChangePassword?: boolean },
  password: { plain: string } | { hash: string },
): Promise<string> {
  const hash = "hash" in password ? password.hash : await hashPassword(password.plain);
  const uname = user.username.toLowerCase();
  await db.insert(users).values({
    id: user.id,
    name: `${user.firstName} ${user.lastName}`,
    firstName: user.firstName,
    lastName: user.lastName,
    username: uname,
    displayUsername: user.username,
    email: `${uname}@backup.schulos.local`,
    mustChangePassword: user.mustChangePassword ?? false,
  });
  await db.insert(accounts).values({ id: crypto.randomUUID(), accountId: user.id, providerId: "credential", userId: user.id, password: hash });
  return user.id;
}

export { hashPassword };
