// Vorlagen für Transaktionsmails (P4-30): Alltagssprache, nur Text, ohne Daten, die nicht gebraucht werden.
// Jede Vorlage liefert Betreff + Text; die Warteschlange (src/core/mail.ts) ergänzt Empfänger und Zweck.

export interface MailContent {
  subject: string;
  text: string;
}

/** Fußzeile aller Transaktionsmails. */
export function mailFooter(school: string): string {
  return [
    "",
    "--",
    `${school} · SchulOS`,
    "Diese Nachricht wurde automatisch erstellt. Bitte nicht darauf antworten.",
  ].join("\n");
}

const hoursText = (h: number) => (h === 1 ? "einer Stunde" : `${h} Stunden`);

/** E-Mail-Adresse bestätigen (Q5-04, Selbstbedienung „E-Mail ändern“). */
export function emailConfirmMail(p: { school: string; name: string; link: string; hours: number; bySchool?: boolean }): MailContent {
  return {
    subject: `${p.school}: E-Mail-Adresse bestätigen`,
    text: [
      `Hallo ${p.name},`,
      "",
      p.bySchool
        ? "Ihre Schule hat in SchulOS diese E-Mail-Adresse für Ihr Konto eingetragen. Bitte bestätigen Sie sie mit diesem Link:"
        : "Sie haben in SchulOS diese E-Mail-Adresse für Ihr Konto eingetragen. Bitte bestätigen Sie sie mit diesem Link:",
      "",
      p.link,
      "",
      `Der Link gilt ${hoursText(p.hours)}. Sie müssen dafür in SchulOS angemeldet sein.`,
      p.bySchool
        ? "Wenn die Adresse nicht zu Ihnen gehört, ignorieren Sie diese Nachricht einfach – dann ändert sich nichts."
        : "Wenn Sie das nicht waren, ignorieren Sie diese Nachricht einfach – dann ändert sich nichts.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** Hinweis an die alte Adresse, wenn eine neue bestätigt wurde. */
export function emailChangedMail(p: { school: string; name: string }): MailContent {
  return {
    subject: `${p.school}: E-Mail-Adresse geändert`,
    text: [
      `Hallo ${p.name},`,
      "",
      "für Ihr SchulOS-Konto ist jetzt eine andere E-Mail-Adresse eingetragen. Nachrichten gehen künftig an die neue Adresse.",
      "Wenn Sie das nicht waren, wenden Sie sich bitte an das Sekretariat.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** SEC-01 (Q-5A-30): Hinweis an die bestätigte Adresse, wenn für das Konto 2FA eingerichtet wurde – fällt Fremden auf. */
export function twoFactorEnabledMail(p: { school: string; name: string }): MailContent {
  return {
    subject: `${p.school}: Zwei-Faktor-Anmeldung wurde eingerichtet`,
    text: [
      `Hallo ${p.name},`,
      "",
      "für Ihr SchulOS-Konto wurde soeben die Zwei-Faktor-Anmeldung eingerichtet. Ab jetzt fragt SchulOS bei der Anmeldung nach einem Code aus der Authenticator-App.",
      "Wenn Sie das nicht waren, wenden Sie sich bitte sofort an das Sekretariat – dann kennt jemand Ihr Passwort.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** SEC-03: Sicherheitsschlüssel/Passkey eingerichtet (beim ersten zweiten Faktor zugleich „2FA eingerichtet“). */
export function passkeyAddedMail(p: { school: string; name: string; keyName: string; first: boolean }): MailContent {
  return {
    subject: p.first ? `${p.school}: Zwei-Faktor-Anmeldung wurde eingerichtet` : `${p.school}: Neuer Sicherheitsschlüssel`,
    text: [
      `Hallo ${p.name},`,
      "",
      p.first
        ? `für Ihr SchulOS-Konto wurde soeben die Zwei-Faktor-Anmeldung mit dem Sicherheitsschlüssel „${p.keyName}“ eingerichtet. Ab jetzt fragt SchulOS bei der Anmeldung nach diesem Schlüssel.`
        : `zu Ihrem SchulOS-Konto wurde soeben der Sicherheitsschlüssel „${p.keyName}“ hinzugefügt. Er gilt ab jetzt als zweiter Faktor bei der Anmeldung.`,
      "Wenn Sie das nicht waren, wenden Sie sich bitte sofort an das Sekretariat – dann kennt jemand Ihr Passwort.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** P4-70: Link „Passwort vergessen“ (1 h). */
export function passwordResetMail(p: { school: string; name: string; link: string }): MailContent {
  return {
    subject: `${p.school}: Passwort zurücksetzen`,
    text: [
      `Hallo ${p.name},`,
      "",
      "für Ihr SchulOS-Konto wurde ein neues Passwort angefordert. Mit diesem Link legen Sie es fest:",
      "",
      p.link,
      "",
      "Der Link gilt eine Stunde und nur einmal. Bei der Anmeldung fragt SchulOS danach wie gewohnt nach dem Code aus der Authenticator-App.",
      "Wenn Sie das nicht waren, ignorieren Sie diese Nachricht – Ihr Passwort bleibt dann unverändert.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** P4-70: Hinweis nach dem Zurücksetzen per Link. */
export function passwordChangedMail(p: { school: string; name: string }): MailContent {
  return {
    subject: `${p.school}: Passwort geändert`,
    text: [
      `Hallo ${p.name},`,
      "",
      "das Passwort Ihres SchulOS-Kontos wurde soeben über den Link „Passwort vergessen“ geändert. Alle Geräte wurden abgemeldet.",
      "Wenn Sie das nicht waren, wenden Sie sich bitte sofort an das Sekretariat.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** Testnachricht (Verwaltung → System) – derselbe Weg wie alle Transaktionsmails. */
export function testMail(p: { school: string; now: Date }): MailContent {
  return {
    subject: `[SchulOS ${p.school}] Testnachricht`,
    text: [
      `Diese Testnachricht zeigt, dass SchulOS ${p.school} E-Mails versenden kann (${p.now.toISOString()}).`,
      "An diese Adresse gehen Alarme: Backup überfällig, Prüfung fehlgeschlagen, Speicherplatz knapp, Update fehlgeschlagen.",
      "Über denselben Weg verschickt SchulOS auch Bestätigungslinks (z. B. E-Mail-Adresse bestätigen).",
      mailFooter(p.school),
    ].join("\n"),
  };
}
