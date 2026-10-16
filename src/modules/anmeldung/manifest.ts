import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "anmeldung",
  name: "Schulanmeldung",
  description: "Eltern melden ihr Kind online vor (mit Gesprächstermin); Sekretariat bearbeitet, Schulleitung entscheidet",
  icon: "ClipboardPen",
  section: "verwaltung",
  order: 30,
  // Öffentliche Seiten und Mails: erst einschalten, wenn SMTP eingerichtet ist (Q-32) – neue Installationen bekommen es aus
  defaultEnabled: false,
  needsMail: "Die Schulanmeldung braucht den E-Mail-Versand (Bestätigungslinks). Erst SMTP in schulos.env einrichten (Verwaltung → System).",
  permissions: {
    "anmeldung.manage": "Anmeldeverfahren und Gesprächstermine anlegen, Anträge bearbeiten (bis „Unterlagen vollständig“), Export",
    "anmeldung.decide": "Über Anträge entscheiden (aufgenommen, Warteliste, abgelehnt) und Verfahren abschließen",
    "anmeldung.view": "Anmeldeverfahren und Anträge lesen",
    "anmeldung.spam": "Anträge als Spam-Verdacht markieren und die Markierung zurücknehmen (ohne Mail) – ablehnen bestätigt, wer entscheiden darf",
  },
  // Entscheiden: Gruppe „Schulleitung“ (im Demo-Seed) und Admins – bewusst nicht die Rolle Verwaltung (Rechtsakt, § 46 SchulG NRW)
  defaultGrants: {
    verwaltung: ["anmeldung.manage", "anmeldung.view", "anmeldung.spam"],
  },
  // Familien mit Konto melden ein weiteres Kind im geschützten Bereich an (P4-34b, Q-32 Weg 1)
  nav: [{ href: "/schulanmeldung", label: "Schulanmeldung", roles: ["eltern"] }],
  retention: [
    {
      table: "anmeldung_verfahren",
      purpose: "Anmeldeverfahren organisieren (Zeitraum, Termine, Hinweistext)",
      categories: ["Anlegende Person", "Zeitpunkte"],
      class: "LK-ENDE-1J",
      start: "completed_at",
      note: "Ende = Abschluss des Verfahrens; laufende Verfahren bleiben",
    },
    {
      table: "anmeldung_antraege",
      purpose: "Vormerkung zur Aufnahme (Terminvergabe, Vorbereitung des Aufnahmegesprächs, Entscheidung, Übernahme)",
      categories: [
        "Kind: Name, Geburtsdatum, Grundschule, Geschwisterkind",
        "Eltern: Name, E-Mail, Telefon, Anschrift",
        "Zweiter Elternteil (optional): Name, E-Mail – nur für das Elternkonto bei der Übernahme",
        "Wunsch: Zweitwunsch, Termin, Hinweise",
        "Einwilligung Datenschutzhinweis (Zeitpunkt)",
        "Elternkonto (nur bei Anmeldung über das Konto)",
        "Vorgelegte Unterlagen (nur ja/nein)",
        "Entscheidung, interne Notiz",
      ],
      class: "LK-90",
      start: "retention_from",
      note: "Fristbeginn setzt die Statusmaschine: unbestätigt → Eingang (Job löscht nach 48 h); zurückgezogen → Rücknahme; abgelehnt/Warteliste → so, dass nach Verfahrensabschluss + Löschfrist (Vorgabe 60 Tage, Q-36) gelöscht wird; aufgenommen → Übernahme (auch beim Nachrücken von der Warteliste nach Abschluss bis Schuljahresbeginn, Q5-19: Fristbeginn wird wieder gelöscht). Offene Anträge haben keinen Fristbeginn und bleiben",
    },
    {
      table: "anmeldung_ereignisse",
      purpose: "Verlauf eines Antrags (Eingang, Termin, Status, Notizen)",
      categories: ["Handelnde Person", "Vorgang", "Notiz", "Zeitpunkt"],
      follows: "anmeldung_antraege",
    },
  ],
  processing: {
    title: "Schulanmeldung (Vormerkung mit Gesprächstermin)",
    purpose: "Anmeldung neuer Schüler:innen vorbereiten: Daten für Terminvergabe und Aufnahmegespräch erfassen, Vorgang bis zur Entscheidung verfolgen",
    legalBasis:
      "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1, 5 SchulG NRW und VO-DV I (Aufnahmedaten); Aufnahme nach § 46 SchulG NRW durch die Schulleitung (zu prüfen)",
    subjects: ["Kinder, die angemeldet werden (noch keine Schüler:innen)", "Eltern bzw. Sorgeberechtigte"],
    recipients: ["Sekretariat", "Schulleitung (Entscheidung)", "Eltern (eigener Vorgang über den Bearbeitungslink)"],
    note: "Online nur, was Terminvergabe und Gespräch brauchen – keine Religionszugehörigkeit, kein Förderbedarf, keine Gesundheitsdaten, keine Noten, keine Uploads (Unterlagen werden im Original vorgelegt). Die rechtlich maßgebliche Aufnahme läuft weiter über Papier bzw. die Schulverwaltungssoftware. Keine automatische Auswahl. Mails gehen nur an Elternteil 1; die Adresse des zweiten Elternteils (optional, Q5-23) wird erst bei der Übernahme für dessen Elternkonto genutzt.",
  },
});
