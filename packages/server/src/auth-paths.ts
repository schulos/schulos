// Better-Auth-Endpunkte, die SchulOS und SchulOS Backup über HTTP NICHT anbieten (SEC-04).
//
// Alle Formulare laufen über Server Actions (`auth.api.*` im Server) – `disabledPaths` sperrt nur den HTTP-Router unter
// /api/auth, die Server Actions bleiben unberührt. Über HTTP gebraucht werden nur /sign-in/username (Anmeldung, auch
// `schulosctl`/Smoke-Test), /get-session und /sign-out.

export const DISABLED_AUTH_PATHS = [
  // Anmeldung nur per Benutzername (mit Anmeldesperre); E-Mail-Adressen sind vorhersagbar (<name>@schulos.local)
  "/sign-in/email",
  "/sign-up/email",
  // Name/Benutzername/E-Mail/Bild legt nur die Verwaltung fest – sonst könnte sich jede:r „Schulleitung“ nennen
  "/update-user",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  // Passwort ändern nur über das Formular (Passwortregeln, Startpasswort-Pflicht)
  "/change-password",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
  // 2FA nur über die Formulare: Ausschalten prüft dort die Pflicht für Verwaltungskonten
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  // GATE-4e (G4E-S01/S02): Geheimnis abrufen und Codes prüfen nur über die Server Actions – über HTTP ließe sich sonst eine
  // liegengebliebene Einrichtung ohne Schulnetz-Prüfung abschließen und „Gerät vertrauen“ (trustDevice) setzen
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  // SEC-03: Sicherheitsschlüssel nur über die Anmeldeseite (Server Actions)
  "/two-factor/passkey-options",
  "/two-factor/verify-passkey",
  // keine Fremdanbieter-Anmeldung
  "/sign-in/social",
  "/link-social",
  "/unlink-account",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
];
