import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { nextCookies } from "better-auth/next-js";
import { twoFactor, username } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/core/db/client";
import { DISABLED_AUTH_PATHS } from "@schulos/server/auth-paths";
import { PASSWORD_MAX, PASSWORD_MIN } from "@schulos/server/passwort";
import { externalAccessFor } from "@/core/device-certs/service";
import { loginThrottle } from "./sperre";
import { passkeySecondFactor } from "./passkey-plugin";
import { accounts, sessions, twoFactors, users, verifications, type NewUser } from "@/core/db/schema";

const DEV_SECRET = "schulos-dev-secret-nicht-fuer-produktion-0123456789";

function secret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production" && !process.env.SCHULOS_ALLOW_DEV_SECRET) {
    throw new Error("BETTER_AUTH_SECRET fehlt");
  }
  return DEV_SECRET;
}

export function createAuth(db: Db) {
  return betterAuth({
    secret: secret(),
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications, twoFactor: twoFactors },
    }),
    // Konten legt die Verwaltung an – keine Selbstregistrierung.
    // Länge gilt beim Setzen (Better-Auth prüft sie nicht bei der Anmeldung); die übrigen Regeln: passwort.ts
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: PASSWORD_MIN, maxPasswordLength: PASSWORD_MAX },
    // SEC-04: E-Mail-Anmeldung, Selbständerung von Name/Benutzername, 2FA-Abschalten usw. nicht über HTTP (nur Server Actions)
    disabledPaths: DISABLED_AUTH_PATHS,
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    // Cookies: httpOnly, SameSite=Lax; Secure, sobald SchulOS über HTTPS läuft (BETTER_AUTH_URL https://…)
    advanced: {
      useSecureCookies: (process.env.BETTER_AUTH_URL ?? "").startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    user: {
      additionalFields: {
        firstName: { type: "string", input: false },
        lastName: { type: "string", input: false },
        shortCode: { type: "string", required: false, input: false },
        role: { type: "string", input: false },
        status: { type: "string", input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Gesperrte Konten bekommen keine Session.
          before: async (session, ctx) => {
            const [u] = await db.select({ status: users.status, role: users.role }).from(users).where(eq(users.id, session.userId));
            if (u?.status === "locked") throw new APIError("FORBIDDEN", { message: "Dieses Konto ist gesperrt." });
            // P4-40b (S27/S28): von außen nur nach Rolle und Gerätezertifikat. Antwort wie bei falschem Passwort – sonst
            // verriete die Ablehnung, dass das Passwort stimmt (der Hinweis steht vorab auf der Anmeldeseite).
            const h = ctx?.headers ?? ctx?.request?.headers;
            if (h && !(await externalAccessFor(db, h, { id: session.userId, role: u?.role ?? "" })).allowed)
              throw new APIError("UNAUTHORIZED", { message: "Benutzername oder Passwort ist falsch." });
          },
        },
      },
    },
    // Für direkte HTTP-Aufrufe von /api/auth (Server Actions laufen über auth.api ohne diesen Limiter – dafür loginThrottle)
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/*": { window: 60, max: 10 }, "/two-factor/*": { window: 60, max: 10 } },
    },
    plugins: [
      // Benutzernamen vergibt die Verwaltung (SEC-04; /update-user ist zusätzlich abgeschaltet)
      username({ immutableUsername: true }),
      loginThrottle(db),
      // TOTP (RFC 6238, 30 s, 6 Stellen) + 10 Wiederherstellungscodes; nach 10 Fehlversuchen 15 min gesperrt (Plugin-Standard)
      // GATE-4e (G4E-S02): „Gerät vertrauen“ gibt es nicht – ein Vertrauens-Cookie würde den zweiten Faktor dauerhaft ersetzen
      // (auch nach Zurücksetzen/Passwort-Reset). maxAge 0 = Eintrag und Cookie sind sofort abgelaufen.
      twoFactor({ issuer: "SchulOS", twoFactorTable: "twoFactor", trustDeviceMaxAge: 0 }),
      // SEC-03: Sicherheitsschlüssel als zweiter Faktor (nur nach dem Passwort, Endpunkte nur per Server Action)
      passkeySecondFactor(db),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __schulosAuth?: Promise<Auth> };

export function getAuth(): Promise<Auth> {
  globalForAuth.__schulosAuth ??= getDb().then(createAuth);
  return globalForAuth.__schulosAuth;
}

/**
 * Legt einen Benutzer samt Passwort-Konto an (für Seed und Verwaltung).
 * `passwordHash` kann vorberechnet übergeben werden – scrypt ist absichtlich langsam.
 */
export async function createUserWithPassword(
  db: Db,
  user: Omit<NewUser, "email"> & { email?: string; username: string },
  password: { plain: string } | { hash: string },
): Promise<string> {
  const hash = "hash" in password ? password.hash : await hashPassword(password.plain);
  const uname = user.username.toLowerCase();
  await db.insert(users).values({
    ...user,
    username: uname,
    displayUsername: user.username,
    email: user.email ?? `${uname}@schulos.local`,
  });
  await db.insert(accounts).values({
    id: crypto.randomUUID(),
    accountId: user.id,
    providerId: "credential",
    userId: user.id,
    password: hash,
  });
  return user.id;
}

export { hashPassword };
