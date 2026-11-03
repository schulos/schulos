import { defineModule } from "@/core/modules/types";
import { ANMELDUNG_SETTINGS } from "./settings";

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
  // KB-02: Richtwert Klassengröße für den Klassenbildungs-Vorschlag im Schuljahreswechsel
  settings: ANMELDUNG_SETTINGS,
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
        "Klassenbildung: Familie „getrennt“ (ja/nein)",
        "Wartelisten-Rang aus einem Losverfahren (LO-01)",
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
    {
      table: "anmeldung_klassenwuensche",
      purpose: "Klassenbildung: interne Wünsche „zusammen“/„nicht zusammen“ zwischen zwei Anträgen (KB-03), vom Sekretariat erfasst",
      categories: ["Antrag und Partner-Antrag", "Art des Wunsches (ohne Begründung)", "Erfassende Person", "Zeitpunkt"],
      follows: "anmeldung_antraege",
    },
    {
      table: "anmeldung_lose",
      purpose: "Losverfahren bei Anmeldeüberhang (LO-01): nachrechenbares Protokoll für Widerspruch und Klage",
      categories: [
        "Teilnehmende nur als Antrags-ID und Vorgangsnummer (keine Namen)",
        "Plätze, Seed, Seed-Hash, gezogene Reihenfolge",
        "Zeug:innen nur als Funktionen",
        "Begründung beim Verwerfen bzw. Neulosen",
        "Vorbereitet/gezogen/übernommen/verworfen von und am",
      ],
      follows: "anmeldung_verfahren",
    },
  ],
  processing: {
    title: "Schulanmeldung (Vormerkung mit Gesprächstermin)",
    purpose: "Anmeldung neuer Schüler:innen vorbereiten: Daten für Terminvergabe und Aufnahmegespräch erfassen, Vorgang bis zur Entscheidung verfolgen; Klassenbildung (Vorschlag für die Verteilung der Neuaufnahmen)",
    legalBasis:
      "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1, 5 SchulG NRW und VO-DV I (Aufnahmedaten); Aufnahme nach § 46 SchulG NRW durch die Schulleitung (zu prüfen)",
    subjects: ["Kinder, die angemeldet werden (noch keine Schüler:innen)", "Eltern bzw. Sorgeberechtigte"],
    recipients: ["Sekretariat", "Schulleitung (Entscheidung)", "Eltern (eigener Vorgang über den Bearbeitungslink)"],
    note: "Online nur, was Terminvergabe und Gespräch brauchen – keine Religionszugehörigkeit, kein Förderbedarf, keine Gesundheitsdaten, keine Noten, keine Uploads (Unterlagen werden im Original vorgelegt). Die rechtlich maßgebliche Aufnahme läuft weiter über Papier bzw. die Schulverwaltungssoftware. Keine automatische Auswahl. Losverfahren (LO-01…03): die Schulleitung bildet aus gleichrangigen offenen Anträgen selbst eine Losgruppe für N Plätze; SchulOS bewertet keine Kriterien, zieht nur die Reihenfolge (Seed-Hash vorab, nachrechenbar) und übernimmt das Ergebnis erst auf Klick; das Protokoll speichert nur Vorgangsnummern, Seed und Zeug:innen-Funktionen und folgt dem Verfahren (LK-ENDE-1J). Klassenbildung (KB-01…03): der Schritt „Neuaufnahmen“ schlägt aus Grundschule, Familie (gleiche E-Mail, Häkchen „getrennt“) und internen Klassenwünschen (zusammen/nicht zusammen, höchstens 2 je Kind, ohne Begründung, vom Sekretariat aus Aufnahmegespräch oder Grundschulbogen erfasst; Eltern sehen sie nicht, die Auskunft nennt das Partnerkind nicht) eine Verteilung auf die neuen Klassen vor – nur ein Vorschlag im Browser, nicht gespeichert; kein Geschlecht, keine weiteren Merkmale. Mails gehen nur an Elternteil 1; die Adresse des zweiten Elternteils (optional, Q5-23) wird erst bei der Übernahme für dessen Elternkonto genutzt.",
  },
});
