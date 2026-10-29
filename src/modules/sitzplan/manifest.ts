import { defineModule } from "@/core/modules/types";
import { SITZPLAN_SETTINGS } from "./settings";

export default defineModule({
  id: "sitzplan",
  name: "Sitzplan",
  description: "Sitzpläne je Lerngruppe für Lehrkräfte – mit Anwesenheit per Klick im Klassenbuch",
  icon: "Armchair",
  section: "unterricht",
  order: 45,
  permissions: {
    "sitzplan.edit": "Sitzpläne eigener Lerngruppen anlegen und ändern (nur Lehrkräfte der Gruppe und Klassenleitung, kein Zugriff auf fremde Gruppen)",
  },
  defaultGrants: { lehrkraft: ["sitzplan.edit"] },
  nav: [{ href: "/sitzplan", label: "Sitzpläne", roles: ["lehrkraft"], requires: "sitzplan.edit" }],
  settings: SITZPLAN_SETTINGS,
  retention: [
    {
      table: "sitzplan_plans",
      purpose: "Sitzordnung einer Lerngruppe für den Unterricht (Raster, Tische, Titel, Fach, Raum, ggf. Verweis auf das kopierte Raumlayout)",
      categories: ["Lerngruppe", "anlegende Lehrkraft", "Fach und Raum"],
      class: "LK-SJ",
      start: "updated_at",
      note: "zum Ende des Schuljahres der letzten Änderung; mit dem Plan gehen alle Plätze",
    },
    {
      table: "sitzplan_seats",
      purpose: "Platz einer Schüler:in im Sitzplan",
      categories: ["Schüler:in", "Platz (Reihe, Spalte)"],
      follows: "sitzplan_plans",
    },
  ],
  processing: {
    title: "Sitzpläne",
    purpose: "Sitzordnung für den Unterricht festhalten und im Klassenbuch die Anwesenheit am Platz erfassen",
    legalBasis:
      "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1, 5 SchulG NRW und § 1 Abs. 2 S. 4, Anlage 2 II Nr. 3 VO-DV I (aus Klassenlisten abgeleitete Daten); Fotos nur mit Einwilligung (§ 120 Abs. 2 SchulG NRW)",
    subjects: ["Schüler:innen", "Lehrkräfte (anlegende Person)"],
    recipients: ["Lehrkräfte der Lerngruppe und Klassenleitung", "im Klassenbuch die Lehrkraft, die die Stunde hält (auch Vertretung)"],
    note: "Nur Name, Initialen und Platz. Profilbilder nur von Personen mit Einwilligung (abschaltbar), der Druck enthält nie Fotos. Schüler:innen, Eltern und Verwaltung sehen keine Sitzpläne; Admin-Konten ohne Bezug zur Gruppe ebenfalls nicht.",
  },
});
