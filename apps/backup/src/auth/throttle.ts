import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import { isAuthApiError } from "@schulos/server/auth-errors";
import { blockingLock, clientIp, ipKey, lockMessage, THROTTLE, userKey, type ThrottleState } from "@schulos/server/throttle";
import { audit } from "@/audit";
import type { Db } from "@/db/client";
import { authThrottle, users } from "@/db/schema";

// Anmeldesperre des Backupservers – dieselben Regeln wie im Hauptsystem (@schulos/server/throttle), eigene Tabelle.

async function load(db: Db, key: string): Promise<ThrottleState | undefined> {
  const [row] = await db.select().from(authThrottle).where(eq(authThrottle.key, key));
  return row;
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

/** Sperre, die der Anmeldung entgegensteht – IP-Sperre nur für unbekannte Namen und Konten mit Fehlversuchen (SEC-04). */
export async function activeLock(db: Db, username: string, ip: string | null, now = new Date()): Promise<Date | null> {
  const [user, ipState] = await Promise.all([load(db, userKey(username)), ip ? load(db, ipKey(ip)) : undefined]);
  let exists = true;
  if (ipState?.lockedUntil) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username.trim().toLowerCase()));
    exists = Boolean(u);
  }
  return blockingLock(user, ipState, exists, now);
}

/** Benutzername der Anmeldung – bei der (über HTTP abgeschalteten) E-Mail-Anmeldung über die Adresse aufgelöst (SEC-04). */
async function signInName(db: Db, path: string | undefined, body: unknown): Promise<string> {
  const b = body as { username?: unknown; email?: unknown } | undefined;
  if (path !== "/sign-in/email") return String(b?.username ?? "");
  const email = String(b?.email ?? "")
    .trim()
    .toLowerCase();
  const [u] = await db.select({ username: users.username }).from(users).where(eq(users.email, email));
  return u?.username ?? email;
}

export async function recordFailure(db: Db, username: string, ip: string | null, now = new Date()): Promise<void> {
  const state = await bump(db, userKey(username), THROTTLE.maxPerUser, now);
  if (ip) await bump(db, ipKey(ip), THROTTLE.maxPerIp, now);
  // genau der Fehlversuch, der die Grenze erreicht, beginnt die Sperre (auch bei gleichzeitigen Anfragen nur einer)
  if (state.failures === THROTTLE.maxPerUser) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username.trim().toLowerCase()));
    if (u) await audit(db, null, "konto.anmeldung.gesperrt", u.id, { minuten: THROTTLE.lockMinutes, fehlversuche: state.failures });
  }
}

/** Better-Auth-Plugin: vor der Anmeldung Sperre prüfen, danach Fehlversuch bzw. Erfolg verbuchen. */
export function loginThrottle(db: Db): BetterAuthPlugin {
  const isSignIn = (path: string | undefined) => path === "/sign-in/username" || path === "/sign-in/email";
  return {
    id: "schulos-backup-login-throttle",
    hooks: {
      before: [
        {
          matcher: (ctx) => isSignIn(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const until = await activeLock(db, await signInName(db, ctx.path, ctx.body), clientIp(ctx.headers));
            if (until) throw new APIError("TOO_MANY_REQUESTS", { message: lockMessage(until) });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => isSignIn(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            const name = await signInName(db, ctx.path, ctx.body);
            if (isAuthApiError(returned)) {
              if (returned.status === "UNAUTHORIZED") await recordFailure(db, name, clientIp(ctx.headers));
            } else await db.delete(authThrottle).where(eq(authThrottle.key, userKey(name)));
          }),
        },
      ],
    },
  };
}
