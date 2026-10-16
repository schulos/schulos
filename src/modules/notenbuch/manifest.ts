import { defineModule } from "@/core/modules/types";
import { NOTENBUCH_ROLES } from "./rollen";
import { NOTENBUCH_SETTINGS } from "./settings";

// Notenbuch (Block 5a, docs/PHASE5-NOTENBUCH.md): Arbeitsnotenbuch der Fachlehrkraft. Kommt ausgeschaltet – bei Neuinstallation
// (`defaultEnabled: false`) wie nach einem Update (B-34); die Schule schaltet es erst nach VVT und DSB-Prüfung ein (DSB-FRAGEN §15).
export default defineModule({
  id: "notenbuch",
  name: "Notenbuch",
  description: "Teilnoten, Gewichtung und Halbjahresvorschlag für die eigenen Lerngruppen – nur für die Fachlehrkräfte",
  icon: "NotebookPen",
  section: "unterricht",
  order: 46,
  defaultEnabled: false,
  // Kein `view_all`: Diese Rechte zählen nur ausdrücklich vergeben – Rolle `admin` und Grant `*` öffnen das Notenbuch nicht
  // (service.ts, `hasNotenbuchRight`). Die Klassenleitung sieht die Halbjahreswerte ihrer Klasse ohne eigenes Recht.
  permissions: {
    "notenbuch.own": "Eigene Notenbücher führen – nur für eigene Lehraufträge; Mitlehrkräfte gleichberechtigt, Vertretung nur per Übertragung",
    "notenbuch.term_view": "Halbjahreswerte aller Klassen einsehen (z. B. Schulleitung) – nie Teilnoten, jeder Abruf protokolliert",
    "notenbuch.transfer": "Notenbücher an eine andere Lehrkraft übertragen (ohne Einsicht in Noten, protokolliert)",
    "notenbuch.export": "Halbjahreswerte für die Schulverwaltungssoftware exportieren – nie Teilnoten",
    "notenbuch.unlock": "Abgeschlossene Notenbücher wieder öffnen (z. B. Schulleitung) – mit Begründung, protokolliert, ohne Einsicht in Noten",
    "notenbuch.auskunft":
      "Notenbuch: Auskunft erteilen – Teilnoten, Kommentare und Halbjahreswerte in die Auskunft nach Art. 15 aufnehmen (zusätzlich zu Verwaltung → Datenschutz; nie für Admin-Konten, jeder Abruf protokolliert)",
  },
  defaultGrants: { lehrkraft: ["notenbuch.own"], admin: ["notenbuch.transfer"] },
  // P5-16: für jedes ausdrücklich vergebene Notenbuch-Recht (auch nur `export`, z. B. Sekretariat) – `explicit`: Admin-`*` zählt
  // nicht. P5-14: Schüler:innen bzw. Eltern nur, wenn die Moduleinstellungen die Sicht freigeben.
  nav: [
    {
      href: "/notenbuch",
      label: "Notenbuch",
      requires: ["notenbuch.own", "notenbuch.term_view", "notenbuch.transfer", "notenbuch.export", "notenbuch.unlock"],
      explicit: true,
      // GATE-5a (Schülerzugriff): nie für Schüler:innen und Eltern, auch wenn ein Grant fälschlich an ihre Rolle/Gruppe ginge
      roles: NOTENBUCH_ROLES,
    },
    { href: "/notenbuch", label: "Noten", roles: ["schueler"], settings: [{ key: "notenbuch.student_view", off: "aus" }] },
    {
      href: "/notenbuch",
      label: "Noten",
      roles: ["eltern"],
      settings: [
        { key: "notenbuch.student_view", off: "aus" },
        { key: "notenbuch.parents_view", off: "0" },
      ],
    },
  ],
  settings: NOTENBUCH_SETTINGS,
  retention: [
    {
      table: "notenbuch_books",
      purpose: "Arbeitsnotenbuch der Fachlehrkraft je Lerngruppe, Fach und Halbjahr (Skala, Gewichtung, Sperre nach dem Abschluss)",
      categories: ["Lerngruppe", "Fach", "Schuljahr und Halbjahr", "anlegende Lehrkraft"],
      class: "LK-SJ-1J",
      start: "school_year_id",
      note: "ein Jahr nach Ende des Schuljahres; mit dem Buch gehen Lehrkräfte, Spalten, Teilnoten und Halbjahreswerte. Amtliche Noten stehen in der Schulverwaltungssoftware",
    },
    {
      table: "notenbuch_book_teachers",
      purpose: "Wer das Notenbuch führt (Fachlehrkräfte des Lehrauftrags, Übertragung)",
      categories: ["Lehrkraft"],
      follows: "notenbuch_books",
    },
    {
      table: "notenbuch_columns",
      purpose: "Leistungsnachweise eines Notenbuchs (Titel, Art, Datum, Gewicht, Notenschlüssel)",
      categories: ["Titel und Datum der Leistung", "Gewicht und Notenschlüssel"],
      follows: "notenbuch_books",
    },
    {
      table: "notenbuch_entries",
      purpose: "Teilnoten und Kurzkommentar je Schüler:in und Leistungsnachweis",
      categories: ["Schüler:in", "Note bzw. Punkte, „fehlt“/„befreit“", "Kurzkommentar (höchstens 200 Zeichen)", "zuletzt geändert von/am"],
      follows: "notenbuch_books",
    },
    {
      table: "notenbuch_term_grades",
      purpose: "Halbjahreswert je Schüler:in: berechneter Vorschlag und festgelegte Note",
      categories: ["Schüler:in", "Vorschlag", "festgelegte Note", "festgelegt von/am"],
      follows: "notenbuch_books",
    },
    {
      table: "notenbuch_sessions",
      purpose: "Sperre des Notenbuchs nach 15 Minuten ohne Aktivität (Zugangsschutz)",
      categories: ["Sitzungskennung", "letzte Aktivität im Notenbuch", "gesperrt seit"],
      follows: "sessions",
    },
    {
      table: "notenbuch_notice_acks",
      purpose: "Nachweis, dass die Person den Datenschutzhinweis zum Notenbuch vor der ersten Nutzung bestätigt hat",
      categories: ["Konto", "Fassung des Hinweises", "bestätigt am"],
      follows: "users",
      note: "geht mit dem Konto; eine neue Fassung des Hinweises verlangt eine neue Bestätigung",
    },
    {
      table: "notenbuch_offline_devices",
      purpose: "Server-Schlüsselanteil je Dienstgerät für den verschlüsselten Offline-Zwischenspeicher der Notentabelle (P5-20)",
      categories: ["Gerätekennung (zufällig)", "Konto", "zuletzt genutzte Sitzung", "Schlüsselanteil", "Grund (Zertifikat/Schulnetz)", "Frist", "letzter Abgleich"],
      // GATE-5a (G5A-C01/S06): gehört Person + Gerät, nicht der Sitzung – echtes Abmelden löscht sie, die Neuanmeldung nach der
      // 15-Minuten-Sperre nicht; Frist 7 Tage ab Einschalten (nach Entzug „jetzt“), nächtlich gelöscht (Job + Löschlauf)
      class: "LK-SESSION",
      start: "expires_at",
      note: "geht mit echtem Abmelden, Ausschalten, Rechteentzug und spätestens nach 7 Tagen (nächtlicher Lauf); ohne die Zeile ist der Zwischenspeicher im Browser unlesbar. Keine Noten auf dem Server, nur der Schlüsselanteil",
    },
  ],
  processing: {
    title: "Notenbuch der Lehrkraft",
    purpose: "Leistungen im Unterricht festhalten, gewichten und einen Vorschlag für die Halbjahresnote berechnen",
    legalBasis:
      "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1, 5 SchulG NRW und § 4 Abs. 5, Anlage 2 II Nr. 4 VO-DV I (Notenliste – Notenbuch der Lehrkraft)",
    subjects: ["Schüler:innen", "Lehrkräfte (führende Lehrkraft)"],
    recipients: [
      "Fachlehrkräfte des Notenbuchs (Teilnoten und Kommentare)",
      "Klassenleitung und Schulleitung nur Halbjahreswerte (jeder Abruf protokolliert)",
    ],
    note: "Kein Zugriff für Verwaltung und Admin-Konten, kein „alles sehen“. Zwei-Faktor-Anmeldung ist für das Modul Pflicht, Seiten werden nicht zwischengespeichert. Vor der ersten Nutzung bestätigen Lehrkräfte und Rechte-Inhaber:innen einen Datenschutzhinweis (Dienstgerät bzw. Genehmigung, keine Kopien außerhalb, keine Gesundheitsangaben). Offline-Eingabe nur auf Dienstgeräten (Gerätezertifikat bzw. nach Einstellung Schulnetz) in einem verschlüsselten Zwischenspeicher des Browsers, dessen Schlüssel nur mit einem Anteil des Servers entsteht – nie auf Privatgeräten von außen. Keine Zeugnisse, Zeugnisbemerkungen oder Benachrichtigungen nach § 50 SchulG – amtlich bleibt die Schulverwaltungssoftware.",
  },
});
