// SEC-03: Anmeldung mit Sicherheitsschlüssel als zweiter Faktor – ein kleines Better-Auth-Plugin, weil nur Better Auth die
// angefangene Anmeldung (Cookie „two_factor“ nach richtigem Passwort) kennt und daraus eine Sitzung machen darf. Ablauf wie bei
// `verify-totp` des twoFactor-Plugins: Cookie → Konto, Schlüssel prüfen, Anmeldung verbrauchen, Sitzung anlegen.
// Über HTTP gesperrt (DISABLED_AUTH_PATHS) – aufgerufen nur aus den Server Actions der Anmeldeseite.
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import * as z from "zod";
import type { Db } from "@/core/db/client";
import { authenticationOptions, CHALLENGE_SECONDS, PasskeyError, relyingParty, verifyAuthentication } from "./passkeys";

/** Name des Cookies der angefangenen Anmeldung (twoFactor-Plugin, `TWO_FACTOR_COOKIE_NAME`) */
const TWO_FACTOR_COOKIE = "two_factor";
export const PASSKEY_2FA_PATHS = ["/two-factor/passkey-options", "/two-factor/verify-passkey"] as const;

const verifyBody = z.object({ response: z.record(z.string(), z.unknown()) });

const fail = (message: string, code = "PASSKEY_FAILED") => new APIError("UNAUTHORIZED", { message, code });

export function passkeySecondFactor(db: Db) {
  /** Angefangene Anmeldung aus dem signierten Cookie: Kennung + Konto – sonst „abgelaufen“ (wie beim Code). */
  async function pending(ctx: {
    context: {
      secret: string;
      createAuthCookie: (name: string) => { name: string };
      internalAdapter: { findVerificationValue: (id: string) => Promise<{ value: string } | null> };
    };
    getSignedCookie: (name: string, secret: string) => Promise<string | null | false>;
  }) {
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!identifier) throw fail("two factor cookie missing", "INVALID_TWO_FACTOR_COOKIE");
    const v = await ctx.context.internalAdapter.findVerificationValue(identifier);
    if (!v) throw fail("two factor cookie invalid", "INVALID_TWO_FACTOR_COOKIE");
    return { identifier, userId: v.value };
  }

  return {
    id: "schulos-passkey-2fa",
    endpoints: {
      passkeySecondFactorOptions: createAuthEndpoint("/two-factor/passkey-options", { method: "POST" }, async (ctx) => {
        const { identifier, userId } = await pending(ctx);
        let options;
        try {
          options = await authenticationOptions(db, userId, relyingParty(ctx.headers ?? new Headers()));
        } catch (err) {
          if (err instanceof PasskeyError) throw new APIError("BAD_REQUEST", { message: err.message, code: "NO_PASSKEY" });
          throw err;
        }
        const key = `2fa-passkey-${identifier}`;
        await ctx.context.internalAdapter.deleteVerificationByIdentifier(key);
        await ctx.context.internalAdapter.createVerificationValue({
          identifier: key,
          value: options.challenge,
          expiresAt: new Date(Date.now() + CHALLENGE_SECONDS * 1000),
        });
        return ctx.json(options);
      }),
      verifyPasskeySecondFactor: createAuthEndpoint("/two-factor/verify-passkey", { method: "POST", body: verifyBody }, async (ctx) => {
        const { identifier, userId } = await pending(ctx);
        const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
        const response = ctx.body.response as unknown as AuthenticationResponseJSON;
        const challenge = await ctx.context.internalAdapter.consumeVerificationValue(`2fa-passkey-${identifier}`);
        if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now())
          throw fail("Die Anfrage an den Schlüssel ist abgelaufen. Bitte noch einmal versuchen.", "PASSKEY_CHALLENGE_EXPIRED");
        try {
          await verifyAuthentication(db, { userId, response, expectedChallenge: challenge.value, rp: relyingParty(ctx.headers ?? new Headers()) });
        } catch (err) {
          if (err instanceof PasskeyError) throw fail(err.message);
          throw err;
        }
        // die angefangene Anmeldung gilt nur einmal (zweiter Aufruf mit demselben Cookie → „abgelaufen“)
        const consumed = await ctx.context.internalAdapter.consumeVerificationValue(identifier);
        if (!consumed || consumed.value !== userId) {
          expireCookie(ctx, cookie);
          throw fail("two factor cookie invalid", "INVALID_TWO_FACTOR_COOKIE");
        }
        const dontRememberMe = await ctx.getSignedCookie(ctx.context.authCookies.dontRememberToken.name, ctx.context.secret);
        const session = await ctx.context.internalAdapter.createSession(userId, !!dontRememberMe);
        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (!session || !user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "failed to create session" });
        await setSessionCookie(ctx, { session, user });
        expireCookie(ctx, cookie);
        return ctx.json({ token: session.token });
      }),
    },
  } satisfies BetterAuthPlugin;
}
