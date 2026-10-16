// Mails der Schulanmeldung (P4-34/P4-35/P4-36): Alltagssprache, nur Text, datensparsam – keine Namen von Kind oder Eltern
// (Mails laufen über fremde Server), nur Verfahren, Vorgangsnummer, Termin und Links.
import { mailFooter, type MailContent } from "@/core/mail-templates";
import { TZ } from "@/core/time";

const when = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const timeOnly = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

/** „Dienstag, 10. Februar 2027 um 14:00–14:30 Uhr“ */
export function slotText(s: { startsAt: Date; endsAt: Date }, room?: string | null): string {
  return `${when.format(s.startsAt).replace(/, (\d\d:\d\d)$/, " um $1")}–${timeOnly.format(s.endsAt)} Uhr${room ? ` (${room})` : ""}`;
}

/** Double-Opt-In: Link zum Bestätigen (48 h). */
export function anmeldungConfirmMail(p: { school: string; verfahren: string; link: string; hours: number }): MailContent {
  return {
    subject: `${p.school}: Bitte bestätigen Sie Ihre Anmeldung`,
    text: [
      "Guten Tag,",
      "",
      `Sie haben bei ${p.school} ein Kind angemeldet („${p.verfahren}“). Bitte bestätigen Sie die Anmeldung mit diesem Link:`,
      "",
      p.link,
      "",
      `Der Link gilt ${p.hours} Stunden. Ohne Bestätigung löschen wir die Angaben danach vollständig.`,
      "Wenn Sie niemanden angemeldet haben, ignorieren Sie diese Nachricht einfach.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** Nach der Bestätigung: Vorgangsnummer, Termin, Unterlagen, Vorgangslink und Kalendereintrag. */
export function anmeldungReceivedMail(p: {
  school: string;
  verfahren: string;
  number: string;
  slot: string | null;
  /** Wunschtermin war bei der Bestätigung schon vergeben */
  slotLost: boolean;
  documents: string[];
  link: string;
  icsLink: string | null;
  validUntil: string;
}): MailContent {
  return {
    subject: `${p.school}: Anmeldung eingegangen (${p.number})`,
    text: [
      "Guten Tag,",
      "",
      `vielen Dank – Ihre Anmeldung für „${p.verfahren}“ ist bei uns eingegangen.`,
      `Vorgangsnummer: ${p.number}`,
      "",
      p.slot
        ? `Ihr Gesprächstermin: ${p.slot}`
        : p.slotLost
          ? "Ihr Wunschtermin war inzwischen vergeben. Bitte wählen Sie über den Link unten einen neuen Termin."
          : "Einen Gesprächstermin wählen Sie über den Link unten.",
      ...(p.icsLink ? [`Termin für Ihren Kalender: ${p.icsLink}`] : []),
      "",
      "Bitte bringen Sie zum Gespräch mit:",
      ...p.documents.map((d) => `- ${d}`),
      "",
      "Verbindlich wird die Anmeldung erst im persönlichen Gespräch.",
      "",
      `Stand ansehen, Termin ändern oder die Anmeldung zurückziehen (bis ${p.validUntil}):`,
      p.link,
      "",
      "Bitte geben Sie diesen Link nicht weiter – wer ihn kennt, kann den Termin ändern.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** Zu viele offene Anträge für diese Adresse in diesem Verfahren – geht nur an die Adresse selbst. */
export function anmeldungLimitMail(p: { school: string; verfahren: string; max: number }): MailContent {
  return {
    subject: `${p.school}: Anmeldung nicht angenommen`,
    text: [
      "Guten Tag,",
      "",
      `für „${p.verfahren}“ sind mit dieser E-Mail-Adresse schon ${p.max} Anmeldungen offen. Weitere nehmen wir online nicht an.`,
      "Wenn Sie eine Anmeldung ändern möchten, nutzen Sie bitte den Link aus Ihrer Bestätigungsmail oder wenden Sie sich an das Sekretariat.",
      "Wenn Sie niemanden angemeldet haben, ignorieren Sie diese Nachricht einfach.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** Termin geändert (durch die Eltern selbst oder durch das Sekretariat). */
export function anmeldungSlotMail(p: { school: string; number: string; slot: string | null; bySchool: boolean }): MailContent {
  return {
    subject: `${p.school}: Gesprächstermin geändert (${p.number})`,
    text: [
      "Guten Tag,",
      "",
      p.bySchool ? `das Sekretariat hat den Gesprächstermin zu Ihrer Anmeldung ${p.number} geändert.` : `der Gesprächstermin zu Ihrer Anmeldung ${p.number} ist geändert.`,
      p.slot ? `Neuer Termin: ${p.slot}` : "Zurzeit ist kein Termin eingetragen.",
      "",
      "Den Stand sehen Sie über den Link aus Ihrer Bestätigungsmail.",
      "Wenn Sie das nicht waren, wenden Sie sich bitte an das Sekretariat.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** Anmeldung zurückgezogen. */
export function anmeldungWithdrawnMail(p: { school: string; number: string }): MailContent {
  return {
    subject: `${p.school}: Anmeldung zurückgezogen (${p.number})`,
    text: [
      "Guten Tag,",
      "",
      `Ihre Anmeldung ${p.number} ist zurückgezogen, der Gesprächstermin ist wieder frei.`,
      "Wenn Sie das nicht waren, wenden Sie sich bitte an das Sekretariat.",
      mailFooter(p.school),
    ].join("\n"),
  };
}

/**
 * Nach der ersten Entscheidung (Q-35): nur „es ist entschieden, der Bescheid kommt per Post“ – ohne Ergebnis, denn der
 * Bescheid ist ein Verwaltungsakt und geht schriftlich (mit Rechtsbehelfsbelehrung).
 */
export function anmeldungDecisionMail(p: { school: string; number: string }): MailContent {
  return {
    subject: `${p.school}: Entscheidung zu Ihrer Anmeldung (${p.number})`,
    text: [
      "Guten Tag,",
      "",
      `über Ihre Anmeldung ${p.number} hat die Schulleitung entschieden.`,
      "Den schriftlichen Bescheid erhalten Sie in den nächsten Tagen per Post.",
      "",
      "Bitte haben Sie Verständnis, dass wir das Ergebnis nicht per E-Mail mitteilen.",
      mailFooter(p.school),
    ].join("\n"),
  };
}
