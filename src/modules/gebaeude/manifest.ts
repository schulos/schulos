import { defineModule } from "@/core/modules/types";
import { GEBAEUDE_SETTINGS } from "./settings";

export default defineModule({
  id: "gebaeude",
  name: "Gebäude & Technik",
  description: "Mängel und Störungen melden und abarbeiten, Inventar mit QR-Etiketten, Prüffristen und Wartung (Raum, Gerät, IT)",
  icon: "Wrench",
  section: "organisation",
  order: 45,
  permissions: {
    "gebaeude.report": "Mängel und Störungen melden, Veranstaltungen bei der Hausmeisterei anmelden, eigene Meldungen und Anmeldungen verfolgen",
    "gebaeude.manage": "Meldungen bearbeiten (annehmen, zuweisen, Status, Raum sperren), Prüfungen erfassen, Wartungstermine, Veranstaltungen bestätigen/zurückfragen/ablehnen",
    "gebaeude.inventory": "Inventar pflegen (anlegen, ändern, ausmustern, CSV-Import und -Export), Etiketten drucken, Inventur durchführen – alle Kategorien",
    "gebaeude.configure": "Prüfarten, Inventar-Kategorien (Präfix, Prüfpflicht, verantwortliche Gruppe) und Zuständigkeiten je Meldungskategorie festlegen; schließt das Inventar-Recht ein",
    "gebaeude.view_all": "Alle Meldungen, Prüfungen, Wartungstermine, Veranstaltungen und das Inventar lesen (auch als CSV)",
    // VA-01: nur wirksam, wenn die Moduleinstellung „Freigabe durch die Schulleitung“ an ist; Migration 0131 gibt es der Gruppe Schulleitung
    "gebaeude.event_approve": "Veranstaltungsanmeldungen freigeben oder ablehnen, bevor sie an die Hausmeisterei gehen (Schulleitung, nur mit eingeschalteter Freigabe)",
  },
  // Schüler:innen melden per Vorgabe nicht (Q-21) – die Schule kann es z. B. der SV-Gruppe geben.
  // Die Hausmeisterei bekommt „manage“ und „inventory“ über ihre Gruppe (Rechte über Gruppen), nicht über die Rolle; eine
  // verantwortliche Gruppe je Inventar-Kategorie pflegt ohne „inventory“ nur ihre Kategorie (INV-01, inv-4).
  defaultGrants: {
    lehrkraft: ["gebaeude.report"],
    personal: ["gebaeude.report"],
    verwaltung: ["gebaeude.report", "gebaeude.manage", "gebaeude.inventory", "gebaeude.configure", "gebaeude.view_all"],
  },
  // Q5-26: Aufbewahrung der Prüfprotokolle wählbar (Vorgabe bis zur übernächsten Prüfung)
  settings: GEBAEUDE_SETTINGS,
  // Navigation für alle, die melden, lesen oder einrichten dürfen (Lehrkräfte, Personal, Verwaltung, freigeschaltete Gruppen)
  nav: [{ href: "/gebaeude", label: "Gebäude & Technik", requires: ["gebaeude.report", "gebaeude.view_all", "gebaeude.configure", "gebaeude.inventory"] }],
  retention: [
    {
      table: "gebaeude_tickets",
      purpose: "Mängel und Störungen melden und abarbeiten (Betrieb und Verkehrssicherung des Schulgebäudes)",
      categories: ["Meldende Person", "Bearbeitende Person", "Ort/Raum", "Kategorie", "Beschreibung", "Status", "Zeitpunkte"],
      class: "LK-ENDE-1J",
      start: "closed_at",
      note: "Ende = erledigt oder abgelehnt; offene Meldungen bleiben",
    },
    { table: "gebaeude_ticket_events", purpose: "Verlauf einer Meldung", categories: ["Handelnde Person", "Statuswechsel", "Kommentar", "Zeitpunkt"], follows: "gebaeude_tickets" },
    {
      table: "gebaeude_ticket_photos",
      purpose: "Fotos zu einer Meldung (nur Sachen, Metadaten entfernt)",
      categories: ["Foto", "Hochladende Person"],
      follows: "gebaeude_tickets",
    },
    {
      table: "gebaeude_maintenance",
      purpose: "Wartungstermine von Firmen planen (Raumsperre, Schulkalender, Hinweis an betroffene Lehrkräfte)",
      categories: ["Anlegende Person", "Firma", "Zeitraum", "Räume"],
      class: "LK-ENDE-1J",
      start: "ends_at",
    },
    {
      // G4-01: reale Protokolle (DGUV V3, Feuerlöscher) tragen Namen/Unterschrift der prüfenden Person, die Bemerkung kann Namen
      // enthalten. Die Prüfung selbst (Termin, Ergebnis, Firma) bleibt als Nachweis; Protokoll und Bemerkung werden geleert,
      // sobald so viele spätere Prüfungen derselben Art am selben Ziel erledigt sind, wie die Moduleinstellung sagt (Q5-26,
      // Vorgabe 2 = „bis zur übernächsten Prüfung“; 3 bzw. 5), und die Prüfung mindestens ein Jahr zurückliegt (DSB-FRAGEN §11).
      table: "gebaeude_inspections",
      scope: "Protokoll-PDF und Bemerkung",
      purpose: "Nachweis der Prüfung gegenüber dem Schulträger (Protokoll der prüfenden Firma, Bemerkung)",
      categories: ["Protokoll-PDF (ggf. Name/Unterschrift der prüfenden Person)", "Bemerkung (Freitext)"],
      class: "LK-1J",
      start: "done_on",
      clear: ["report_key", "report_size", "note"],
      where:
        "done_on is not null and (report_key is not null or note is not null) and (select count(*) from gebaeude_inspections n where n.type_id = gebaeude_inspections.type_id and n.asset_id is not distinct from gebaeude_inspections.asset_id and n.room_id is not distinct from gebaeude_inspections.room_id and n.building is not distinct from gebaeude_inspections.building and n.done_on is not null and n.done_on > gebaeude_inspections.done_on) >= {setting}",
      setting: "gebaeude.report_keep",
      note: "Vorgabe bis zur übernächsten Prüfung (letzte 2 Protokolle), als Moduleinstellung auch letzte 3 oder 5 – jeweils mindestens 1 Jahr; Termin, Ergebnis und Firma bleiben ohne Personenbezug als Nachweis",
    },
    { table: "gebaeude_maintenance_rooms", purpose: "Räume eines Wartungstermins", categories: ["Raum", "Raumsperre"], follows: "gebaeude_maintenance" },
    {
      // INV-05: Ausleihe von Inventar (Leihgeräte) – wer hat was bis wann; offene Ausleihen bleiben, bis die Rückgabe gebucht ist
      table: "gebaeude_loans",
      purpose: "Ausleihe von Leihgeräten der Schule (Tablets, Instrumente, Messgeräte) an Schüler:innen und Beschäftigte: Rückgabedatum, Erinnerungen, Leihvertrag",
      categories: ["Entleihende Person", "Gerät", "ausgeliehen am", "Rückgabe bis", "zurückgegeben am", "Zubehör", "Befund bei Rückgabe (Sache)", "Erinnerungsstand"],
      class: "LK-ENDE-1J",
      start: "returned_at",
      note: "Ende = Rückgabe gebucht; offene Ausleihen bleiben; der Leihvertrag wird nur gedruckt, nicht gespeichert",
    },
    {
      // VA-01: Veranstaltungsanmeldung an die Hausmeisterei – auch abgelehnte/abgesagte laufen bis 1 Jahr nach dem geplanten Ende
      table: "gebaeude_veranstaltungen",
      purpose: "Veranstaltungen bei der Hausmeisterei anmelden (Aufbau, Räume, Bestuhlung, Technik, Schließzeiten) und bestätigen",
      categories: ["Anmeldende Person", "Titel", "Zeitraum mit Auf-/Abbau", "Ort/Räume", "Personenzahl", "Bedarf", "Status"],
      class: "LK-ENDE-1J",
      start: "ends_at",
      note: "Ende = geplantes Ende der Veranstaltung (auch bei Ablehnung oder Absage)",
    },
    { table: "gebaeude_veranstaltung_raeume", purpose: "Räume einer Veranstaltung", categories: ["Raum"], follows: "gebaeude_veranstaltungen" },
    { table: "gebaeude_veranstaltung_sperren", purpose: "Raumsperren aus einer bestätigten Veranstaltung", categories: ["Raumsperre"], follows: "gebaeude_veranstaltungen" },
    {
      table: "gebaeude_veranstaltung_verlauf",
      purpose: "Verlauf einer Veranstaltungsanmeldung (Freigabe, Bestätigung, Rückfrage, Antwort, Ablehnung, Absage, Änderung)",
      categories: ["Handelnde Person", "Schritt", "Text", "Zeitpunkt"],
      follows: "gebaeude_veranstaltungen",
    },
  ],
  processing: {
    title: "Mängel- und Störungsmeldungen (Gebäude & Technik)",
    purpose: "Mängel und Störungen an Gebäude, Haustechnik und IT melden und beheben; Leihgeräte aus dem Inventar verleihen und zurücknehmen (INV-05); Veranstaltungen bei der Hausmeisterei anmelden, ändern und als Serie planen (VA-01…07)",
    legalBasis:
      "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 79 SchulG NRW (Schulträger stellt und unterhält das Schulgebäude – zu prüfen) und § 120 SchulG NRW; für Lehrkräfte VO-DV II",
    subjects: ["Lehrkräfte", "Verwaltungspersonal", "weiteres Personal", "Schüler:innen (nur Leihgeräte)", "Eltern minderjähriger Entleihender (nur Erinnerungen)"],
    recipients: [
      "Hausmeisterei/IT (Zuständigkeitsgruppe)",
      "Schulleitung",
      "meldende Person (Status der eigenen Meldung)",
      "anmeldende Person (Stand der eigenen Veranstaltung); Schulleitung bei eingeschalteter Freigabe",
      "Pflegende der Inventar-Kategorie (Ausleihe: Person, Gerät, Fristen)",
      "entleihende Person und bei Minderjährigen die Eltern (eigene Leihgeräte, Erinnerungen)",
    ],
    note: "Fotos nur von Sachen, Metadaten (EXIF/GPS) werden beim Hochladen entfernt. Keine Auswertung je Person – Statistik nur je Kategorie/Monat. Anlagen und Prüfarten ohne Personenbezug; Prüfnachweise nennen die Firma statt einer Prüfer:in (Erfassung nur im Audit-Log), Protokoll-PDF und Bemerkung können aber Namen enthalten und werden nach der übernächsten Prüfung derselben Art (Vorgabe; als Moduleinstellung nach der dritt- bzw. fünftnächsten), frühestens nach einem Jahr, geleert; CSV-Exporte ohne Namen und Freitext. Wartungstermine nennen die anlegende Person (1 Jahr nach Termin gelöscht). Leihgeräte (INV-05): nur an Personen mit Konto; Person und Klasse sehen nur die Pflegenden der Kategorie und die Person selbst (Eltern lesend), alle anderen höchstens „verliehen bis …“; Erinnerungen (Benachrichtigung, optional Mail) nennen kein Gerät, nur „Meine Leihgeräte“ nach der Anmeldung; wer verliehen hat, steht nur im Audit-Log; Ausleihen werden 1 Jahr nach der Rückgabe gelöscht, der Leihvertrag ist nur Druck. Veranstaltungen (VA-01): anmeldende Person, Zeitraum, Räume, Personenzahl und Bedarf sehen die Person selbst, die Hausmeisterei/Verwaltung (`manage`/`view_all`) und bei eingeschalteter Freigabe die Schulleitung; „Heute im Haus“ und Schulkalender nennen nur Titel, Zeit und Ort; gelöscht 1 Jahr nach dem geplanten Ende. Ändern (VA-05) nur durch die anmeldende Person – der Verlauf nennt die geänderten Angaben, nicht die alten Werte; Serien (VA-06) sind einzelne Termine mit eigener Löschfrist.",
  },
});
