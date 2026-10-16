// Zwei-Faktor-Anmeldung (B-09): reine Helfer, gemeinsam für SchulOS und SchulOS Backup.

/** Better-Auth antwortet bei aktivem 2FA statt mit einer Sitzung mit `twoFactorRedirect`. */
export function needsSecondFactor(res: unknown): boolean {
  return typeof res === "object" && res !== null && "twoFactorRedirect" in res && res.twoFactorRedirect === true;
}

export function secondFactorUrl(next: string): string {
  return next === "/" ? "/login/zweiter-faktor" : `/login/zweiter-faktor?next=${encodeURIComponent(next)}`;
}

/** Deutsche Meldung zu einem Better-Auth-Fehler beim zweiten Faktor (Code im body bzw. Text der Meldung). */
export function twoFactorErrorMessage(err: { message?: string; body?: { code?: string } }): string {
  const code = err.body?.code ?? "";
  const msg = err.message ?? "";
  if (code === "INVALID_TWO_FACTOR_COOKIE" || /two factor cookie/i.test(msg)) return "Die Anmeldung ist abgelaufen. Bitte erneut mit Benutzername und Passwort anmelden.";
  if (code === "ACCOUNT_TEMPORARILY_LOCKED" || code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" || /too many/i.test(msg))
    return "Zu viele Fehlversuche. Das Konto ist für 15 Minuten gesperrt.";
  if (code === "INVALID_PASSWORD" || /password/i.test(msg)) return "Das Passwort ist falsch.";
  return "Der Code ist falsch oder abgelaufen.";
}

/** Geheimnis (Base32) aus der otpauth-URI – zum Abtippen, falls die App keinen QR-Code lesen kann. */
export function secretFromUri(uri: string): string {
  return new URL(uri).searchParams.get("secret") ?? "";
}

/** Base32 in Vierergruppen, damit es sich abtippen lässt. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
