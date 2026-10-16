import { and, eq, gt, like, sql } from "drizzle-orm";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { authThrottle, users } from "@/core/db/schema";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { blockingLock, clientIp, ipKey, lockMessage, THROTTLE, userKey, type ThrottleState } from "@schulos/server/throttle";

/**
 * Anmeldesperre in der DB (B-10). Läuft als Better-Auth-Plugin-Hook – greift damit für Server Actions (auth.api) UND
 * direkte HTTP-Aufrufe von /api/auth. Die Regeln (Grenzen, Fenster) stehen in @schulos/server/throttle.
 */
async function load(db: Db, key: string): Promise<ThrottleState | undefined> {
  const [row] = await db.select().from(authThrottle).where(eq(authThrottle.key, key));
  return row;
}

async function accountExists(db: Db, username: string): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username.trim().toLowerCase()));
  return Boolean(u);
}

/**
 * Sperre, die einer Anmeldung mit diesem Benutzernamen (und dieser IP) gerade entgegensteht – oder null. Die IP-Sperre
 * gilt nur für unbekannte Namen und Konten mit Fehlversuchen (SEC-04, Begründung bei `blockingLock`).
 */
export async function activeLock(db: Db, username: string, ip: string | null, now = new Date()): Promise<Date | null> {
  const [user, ipState] = await Promise.all([load(db, userKey(username)), ip ? load(db, ipKey(ip)) : undefined]);
  return blockingLock(user, ipState, ipState?.lockedUntil ? await accountExists(db, username) : true, now);
}

/**
 * Fehlversuch atomar verbuchen: Zähler, Fenster und Sperre rechnet die DB im Upsert aus dem aktuellen Zeilenstand
 * (Regeln wie `afterFailure`) – gleichzeitige Fehlversuche gehen so nicht verloren.
 */
async function bump(db: Db, key: string, max: number, now: Date): Promise<ThrottleState> {
  const t = authThrottle;
  const minutes = (n: number) => sql.raw(`interval '${Math.trunc(n)} minutes'`);
  const fresh = sql`(${t.windowStartedAt} < excluded.updated_at - ${minutes(THROTTLE.windowMinutes)} or (${t.lockedUntil} is not null and ${t.lockedUntil} <= excluded.updated_at))`;
  const failures = sql`(case when ${fresh} then 1 else ${t.failures} + 1 end)`;
  const [row] = await db
    .insert(t)
    .values({ key, failures: 1, windowStartedAt: now, lockedUntil: 1 >= max ? new Date(now.getTime() + THROTTLE.lockMinutes * 60_000) : null, updatedAt: now })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        failures,
        windowStartedAt: sql`case when ${fresh} then excluded.window_started_at else ${t.windowStartedAt} end`,
        lockedUntil: sql`case when ${failures} >= ${sql.raw(String(Math.trunc(max)))} then excluded.updated_at + ${minutes(THROTTLE.lockMinutes)} end`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({ failures: t.failures, windowStartedAt: t.windowStartedAt, lockedUntil: t.lockedUntil });
  return row!;
}

/** Fehlversuch zählen; beginnt dabei eine Kontosperre, steht sie im Audit-Log (ohne IP). */
export async function recordFailure(db: Db, username: string, ip: string | null, now = new Date()): Promise<void> {
  const state = await bump(db, userKey(username), THROTTLE.maxPerUser, now);
  if (ip) await bump(db, ipKey(ip), THROTTLE.maxPerIp, now);
  // genau der Fehlversuch, der die Grenze erreicht, beginnt die Sperre (auch bei gleichzeitigen Anfragen nur einer)
  if (state.failures === THROTTLE.maxPerUser) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username.trim().toLowerCase()));
    if (u) await audit(db, null, "konto.anmeldung.gesperrt", u.id, { minuten: THROTTLE.lockMinutes, fehlversuche: state.failures });
  }
}

/** Erfolgreiche Anmeldung: Zähler des Benutzernamens zurücksetzen (die IP zählt weiter). */
export async function recordSuccess(db: Db, username: string): Promise<void> {
  await db.delete(authThrottle).where(eq(authThrottle.key, userKey(username)));
}

export interface LockedLogin {
  username: string;
  userId: string | null;
  name: string | null;
  lockedUntil: Date;
  failures: number;
}

/** Für die Verwaltung: gerade gesperrte Benutzernamen (bekannte Konten mit Namen). */
export async function lockedLogins(db: Db, now = new Date()): Promise<LockedLogin[]> {
  const rows = await db
    .select({ key: authThrottle.key, lockedUntil: authThrottle.lockedUntil, failures: authThrottle.failures, userId: users.id, name: users.name })
    .from(authThrottle)
    .leftJoin(users, eq(users.username, sql<string>`substr(${authThrottle.key}, 3)`))
    .where(and(like(authThrottle.key, "u:%"), gt(authThrottle.lockedUntil, now)));
  return rows.map((r) => ({ username: r.key.slice(2), userId: r.userId, name: r.name, lockedUntil: r.lockedUntil!, failures: r.failures }));
}

/** Sperre eines Benutzernamens aufheben (Verwaltung). */
export async function unlockLogin(db: Db, actorId: string, username: string): Promise<void> {
  await db.delete(authThrottle).where(eq(authThrottle.key, userKey(username)));
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username.trim().toLowerCase()));
  await audit(db, actorId, "verwaltung.user.anmeldesperre_aufgehoben", u?.id ?? null, u ? undefined : { username });
}

/**
 * Benutzername einer Anmeldung: direkt bzw. bei der E-Mail-Anmeldung über die Adresse aufgelöst (unbekannte Adressen
 * zählen unter der Adresse selbst). Die E-Mail-Anmeldung ist über HTTP abgeschaltet (`DISABLED_AUTH_PATHS`); greift sie
 * doch einmal (z. B. `auth.api.signInEmail`), gilt dieselbe Sperre wie für den Benutzernamen (SEC-04).
 */
async function signInName(db: Db, path: string | undefined, body: unknown): Promise<string> {
  const b = body as { username?: unknown; email?: unknown } | undefined;
  if (path !== "/sign-in/email") return String(b?.username ?? "");
  const email = String(b?.email ?? "")
    .trim()
    .toLowerCase();
  const [u] = await db.select({ username: users.username }).from(users).where(eq(users.email, email));
  return u?.username ?? email;
}

/** Better-Auth-Plugin: vor der Anmeldung Sperre prüfen, danach Fehlversuch bzw. Erfolg verbuchen. */
export function loginThrottle(db: Db): BetterAuthPlugin {
  const isSignIn = (path: string | undefined) => path === "/sign-in/username" || path === "/sign-in/email";
  return {
    id: "schulos-login-throttle",
    hooks: {
      before: [
        {
          matcher: (ctx) => isSignIn(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const username = await signInName(db, ctx.path, ctx.body);
            const until = await activeLock(db, username, clientIp(ctx.headers));
            if (until) throw new APIError("TOO_MANY_REQUESTS", { message: lockMessage(until) });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => isSignIn(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const username = await signInName(db, ctx.path, ctx.body);
            const returned = ctx.context.returned;
            // nur falsches Passwort/unbekannter Name zählt (UNAUTHORIZED) – gesperrte Konten (FORBIDDEN) nicht
            if (isAuthApiError(returned)) {
              if (returned.status === "UNAUTHORIZED") await recordFailure(db, username, clientIp(ctx.headers));
            } else await recordSuccess(db, username);
          }),
        },
      ],
    },
  };
}
