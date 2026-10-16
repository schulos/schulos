// Ohne Anmeldung erreichbar: Login (inkl. zweiter Faktor), Statusmonitore (/monitor/<token> – die geheime Adresse ist
// der Zugang), Datenschutzhinweise (Art. 13: vor der Anmeldung lesbar), Auth-API, Healthcheck und das Schullogo
// (genau /api/schule/logo – Login, Monitor, Druck, Favicon), Impressum (genau /impressum, P4-33), Schulanmeldung ohne Konto
// (P4-34: /anmeldung, /anmeldung/<verfahren>, /anmeldung/bestaetigen/<token>, /anmeldung/vorgang/<token> – genau dieser
// Ordner, nicht /anmeldungX; die Seiten prüfen Modulsperre und Token selbst). Liste in docs/SICHERHEIT.md S30.
// P4-70: „Passwort vergessen“ (/passwort-vergessen, /passwort-vergessen/<token>) – Link nur per Mail, nur Konten mit 2FA.
// A11Y-02: Erklärung zur Barrierefreiheit (genau /barrierefreiheit) – vor der Anmeldung lesbar wie das Impressum.
// P4-73: Service Worker (genau /sw.js) und Web-App-Manifest (genau /manifest.webmanifest) – der Browser lädt sie ohne
// Cookies bzw. prüft auch auf der Anmeldeseite auf Updates; beide enthalten keine Personendaten.
// Kalender-Abo (Q5-15): genau /api/kalender/abo/<token> – nicht in der Außen-Allowlist (von außen nur im Modus „alles“, S39).
const PUBLIC = /^\/(login|passwort-vergessen(?:\/|$)|datenschutzhinweise|impressum$|barrierefreiheit$|sw\.js$|manifest\.webmanifest$|anmeldung(?:\/|$)|api\/auth|api\/health|monitor\/|api\/monitor\/|api\/schule\/logo$|api\/kalender\/abo\/[A-Za-z0-9_-]+$)/;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC.test(pathname);
}
