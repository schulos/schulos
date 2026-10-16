import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "umfragen",
  name: "Umfragen",
  description: "Umfragen an Gruppen, Rollen oder Eltern – anonym oder namentlich",
  icon: "ListChecks",
  section: "kommunikation",
  order: 30,
  permissions: {
    "umfragen.create": "Umfragen anlegen",
    "umfragen.manage": "Alle Umfragen bearbeiten und auswerten",
  },
  defaultGrants: { lehrkraft: ["umfragen.create"], verwaltung: ["umfragen.create", "umfragen.manage"] },
  nav: [{ href: "/umfragen", label: "Umfragen" }],
  retention: [
    {
      table: "umfragen_surveys",
      purpose: "Meinungen und Rückmeldungen einholen",
      categories: ["Fragen", "Verfasser:in", "Zeitraum"],
      class: "LK-ENDE-1J",
      start: "closes_at",
    },
    { table: "umfragen_targets", purpose: "Zielgruppen einer Umfrage", categories: ["Zielgruppe"], follows: "umfragen_surveys" },
    { table: "umfragen_questions", purpose: "Fragen einer Umfrage", categories: ["Fragetext", "Antwortmöglichkeiten"], follows: "umfragen_surveys" },
    {
      table: "umfragen_responses",
      purpose: "Antworten auf eine Umfrage",
      categories: ["Tag der Antwort", "Antwortende:r (nur bei namentlichen Umfragen)"],
      note: "Anonyme Umfragen speichern keinen Bezug zur Person und nur den Tag.",
      follows: "umfragen_surveys",
    },
    {
      table: "umfragen_answers",
      purpose: "Antworten auf eine Umfrage",
      categories: ["Auswahl", "Skalenwert", "Freitext", "Antwortende:r (nur bei namentlichen Umfragen)"],
      follows: "umfragen_responses",
    },
    {
      table: "umfragen_participation",
      purpose: "Doppelte Teilnahme verhindern, an Nicht-Teilnehmende erinnern",
      categories: ["Teilnehmer:in"],
      note: "Ohne Zeitpunkt und ohne Verweis auf die Antwort.",
      follows: "umfragen_surveys",
    },
  ],
  processing: {
    title: "Umfragen",
    purpose: "Meinungen und Rückmeldungen von Schüler:innen, Eltern und Personal einholen und auswerten",
    subjects: ["Schüler:innen", "Eltern", "Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["Ersteller:in der Umfrage", "Verwaltung (Recht „Alle Umfragen“)"],
    note: "Anonyme Umfragen: Antworten ohne Personenbezug, nur tagesgenau; Ergebnisse erst ab 5 Antworten. Freitext mit Hinweis, keine Namen zu nennen.",
  },
});
