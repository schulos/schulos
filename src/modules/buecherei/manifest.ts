import { defineModule } from "@/core/modules/types";
import { BUECHEREI_SETTINGS } from "./settings";

// Schulbücherei (Block BU, docs/BUECHEREI.md). Bis Stufe 1 fertig ist (GATE BU1) kommt das Modul auch bei einer
// Neuinstallation ausgeschaltet; die Demo schaltet es ein. Bestand (BU-01) ohne Personenbezug; Ausleihen (BU-02) mit
// Personenbezug nur, solange sie offen sind.
export default defineModule({
  id: "buecherei",
  name: "Bücherei",
  description: "Schulbücherei und Mediothek: Bestand mit Exemplarnummern, Theke, Katalog – zuschaltbar die Schulbuchausleihe (Lernmittel, Bücherlisten)",
  icon: "Library",
  section: "organisation",
  order: 55,
  defaultEnabled: false,
  permissions: {
    "buecherei.use": "Katalog durchsuchen, eigene Ausleihen sehen, vormerken und verlängern",
    "buecherei.desk": "Theke: Ausleihe und Rückgabe verbuchen (sieht nur Name, Klasse und offene Ausleihen der Person, keinen Verlauf)",
    "buecherei.stock": "Bestand pflegen: Titel und Exemplare anlegen, ändern, importieren und aussondern",
    "buecherei.materials": "Schulbuchausleihe (Lernmittel) organisieren, Befunde bei der Rückgabe und Ersatzforderungen bearbeiten",
  },
  // BU-03 (Projektleitung 2026-10-19): ausleihen dürfen alle Rollen außer Eltern und Admin
  defaultGrants: {
    schueler: ["buecherei.use"],
    lehrkraft: ["buecherei.use"],
    personal: ["buecherei.use"],
    beratung: ["buecherei.use"],
    verwaltung: ["buecherei.use", "buecherei.desk", "buecherei.stock", "buecherei.materials"],
  },
  // BU-02: Leihfrist je Medienart, Verlängerungen; BU-03: Abholfrist, Vormerkungen je Person; BU-04: Erinnerung, Mahnabstand, Mail;
  // BU-06: ISBN-Abfrage (ab Werk aus) und ihre Quellen; BU-10: Schulbuchausleihe (Stufe 2, ab Werk aus)
  settings: BUECHEREI_SETTINGS,
  nav: [
    { href: "/buecherei", label: "Bücherei", requires: ["buecherei.use", "buecherei.desk", "buecherei.stock", "buecherei.materials"] },
    // BU-03: Eltern sehen Ausleihen und Vormerkungen ihrer Kinder (nur lesend)
    { href: "/buecherei/meine", label: "Bücherei", roles: ["eltern"] },
  ],
  retention: [
    {
      table: "buecherei_loans",
      scope: "offene Ausleihen",
      purpose: "Ausleihe von Medien der Schulbücherei (wer hat welches Exemplar bis wann)",
      categories: ["Person (Konto)", "Exemplar", "Ausleihdatum", "Fälligkeit", "Zahl der Verlängerungen", "Erinnerung verschickt", "Mahnstufe und Tag der letzten Mahnung"],
      class: "LK-KONTO",
      start: "user_id",
      where: "returned_on is null",
      note: "Rückgabe ohne Befund löscht die Ausleihe sofort (nur ein Zähler je Monat und Medienart bleibt, ohne Person); Kontolöschung entfernt die Person, das Exemplar bleibt als ausgeliehen sichtbar. Mahnstufe und Erinnerung leben nur mit der offenen Ausleihe: Rückgabe löscht bzw. leert sie, Verlängern setzt sie zurück (BU-04)",
    },
    {
      table: "buecherei_loans",
      scope: "Rückgaben mit Befund",
      purpose: "Schaden oder Unvollständigkeit bei der Rückgabe klären (Grundlage einer Ersatzforderung)",
      categories: ["Person (Konto)", "Exemplar", "Rückgabedatum", "Befund (Sache, ohne Namen)", "erledigt am"],
      class: "LK-SJ-1J",
      start: "finding_resolved_on",
      where: "returned_on is not null and finding_resolved_on is not null",
      note: "bleibt bis zur Erledigung, danach bis Schuljahresende + 1 Jahr",
    },
    {
      table: "buecherei_cards",
      purpose: "Büchereiausweis: pseudonymer Code, mit dem die Theke die Person wählt",
      categories: ["Konto", "zufälliger Ausweis-Code (ohne Namen oder Kontonummer)", "angelegt am"],
      class: "LK-KONTO",
      start: "user_id",
      note: "Ersatz bei Verlust löscht den alten Code; geht mit dem Konto",
    },
    {
      table: "buecherei_reservations",
      purpose: "Vormerkung eines ganz ausgeliehenen Titels; Benachrichtigung, wenn ein Exemplar bereitliegt",
      categories: ["Konto", "Titel", "vorgemerkt am", "bereit seit / Abholfrist"],
      class: "LK-90",
      start: "created_at",
      note: "Ausleihe an die Person, Ablauf der Abholfrist oder Löschen durch die Person entfernt die Vormerkung sofort (kein Verlauf); spätestens nach 90 Tagen; geht mit dem Konto",
    },
    {
      table: "buecherei_material_issues",
      scope: "offene Schulbuch-Ausgaben",
      purpose: "Schulbuchausleihe: welches Schulbuch (Inventarnummer) im Schuljahr bei wem ist, Rückgabe und Mahnung",
      categories: ["Person (Konto)", "Exemplar (Inventarnummer)", "Schuljahr", "ausgegeben am", "zurück bis", "Mahnstufe und Tag der letzten Mahnung"],
      class: "LK-KONTO",
      start: "user_id",
      where: "returned_on is null",
      note: "BU-11: gilt nur für das Schuljahr der Ausgabe; Rücknahme ohne Befund löscht die Zuordnung sofort (der Zustand steht am Exemplar, ohne Person). Nicht Zurückgegebenes bleibt über das Schuljahresende nur als offener Posten und geht spätestens mit dem Konto (Kontolöschung entfernt die Person)",
    },
    {
      table: "buecherei_material_issues",
      scope: "Schulbuch-Rücknahmen mit Befund",
      purpose: "Schaden oder Verlust eines Schulbuchs klären (Grundlage einer Ersatzforderung)",
      categories: ["Person (Konto)", "Exemplar (Inventarnummer)", "Rückgabedatum", "Befund (Sache, ohne Namen)", "erledigt am"],
      class: "LK-SJ-1J",
      start: "finding_resolved_on",
      where: "returned_on is not null and finding_resolved_on is not null",
      note: "bleibt bis zur Erledigung, danach bis Schuljahresende + 1 Jahr",
    },
    {
      table: "buecherei_compensations",
      scope: "offene Ersatzforderungen",
      purpose: "Ersatz für ein beschädigtes oder verlorenes Medium bzw. Schulbuch fordern (Betrag, Grund, Brief an die Eltern) – keine Zahlungsabwicklung",
      categories: ["Person (Konto)", "Gegenstand (Titel, Exemplar-/Inventarnummer)", "Grund (Sache, ohne Namen)", "Betrag", "angelegt am", "Brief gedruckt am"],
      class: "LK-KONTO",
      start: "user_id",
      where: "status = 'offen'",
      note: "BU-12: bleibt, bis sie bezahlt oder erlassen ist; Kontolöschung entfernt die Person",
    },
    {
      table: "buecherei_compensations",
      scope: "abgeschlossene Ersatzforderungen",
      purpose: "Nachweis, dass ein Ersatz bezahlt oder erlassen wurde",
      categories: ["Person (Konto)", "Gegenstand", "Grund", "Betrag", "Status", "abgeschlossen am"],
      class: "LK-SJ-1J",
      start: "closed_on",
      where: "status <> 'offen' and closed_on is not null",
      note: "Schuljahresende + 1 Jahr nach dem Abschluss",
    },
  ],
  processing: {
    title: "Schulbücherei: Ausleihe",
    purpose: "Medien der Schulbücherei ausleihen und zurücknehmen, Fristen und Schäden nachhalten, vor Fristende erinnern und Überfälliges mahnen",
    subjects: ["Schüler:innen", "Lehrkräfte", "weiteres Personal"],
    recipients: [
      "Büchereiteam an der Theke (Recht „Theke“, auch Schüler-Helfer:innen): nur Name, Klasse und offene Ausleihen der Person; Mahnliste der überfälligen Ausleihen – Mahnstufen nur Erwachsene im Team",
      "Verwaltung mit „Schulbuchausleihe“: Rückgaben mit Befund",
      "nur wenn die ISBN-Abfrage eingeschaltet ist (ab Werk aus, BU-06): öffentliche Bibliothekskataloge (ab Werk nur Deutsche Nationalbibliothek und Verbundkatalog des Hochschulbibliothekszentrums NRW; Open Library – außerhalb der EU – nur, wenn die Schule sie zuschaltet) – sie erhalten vom Server nur die ISBN eines Titels, keine Personendaten",
      "die Person selbst („Meine Ausleihen“: offene Ausleihen und Vormerkungen; Erinnerung und Mahnungen als Benachrichtigung, optional Mail), Eltern minderjähriger Schüler:innen lesend und ab der 2. Mahnstufe als Benachrichtigung (optional Mail)",
      "Schulbuchausleihe (BU-11): die Person und Eltern Minderjähriger sehen die offenen Schulbücher lesend; Mahnungen nach Ablauf der Rückgabefrist an die Person und Eltern Minderjähriger ab der 1. Stufe (optional Mail)",
    ],
    note: "Kein Ausleihverlauf je Person: Die Rückgabe ohne Befund löscht die Ausleihe sofort, es bleiben nur Zähler je Monat und Medienart ohne Personenbezug. Ausleihe und Rückgabe stehen nicht im Audit-Log, nur Befunde. Büchereiausweise tragen Name, Klasse und einen zufälligen Code ohne Namen oder Kontonummer; Ersatz macht den alten Code ungültig. Vormerkungen nur für ganz ausgeliehene Titel; andere sehen nur ihre Zahl, keine Namen – auch die Theke nicht (sie erfährt nur „liegt für eine andere Person bereit“). Erinnerungen und Mahnungen (Stufe 1–3, nur an Schultagen) nennen keinen Titel – welche Medien, steht nur nach der Anmeldung; Mahnungen werden nur gezählt (je Monat und Medienart), nicht je Person aufbewahrt. Keine Leseempfehlungen oder Auswertungen aus dem Ausleihverhalten: Die Statistik kennt nur Zähler je Monat und Medienart und je Exemplar (Zahl der Ausleihen, Monat der letzten), keine Personen. Schulbuchausleihe (Stufe 2, Schalter, BU-10): Lernmittel je Jahrgang/Fach, Exemplare mit Inventarnummer und Zustand sowie die Bücherlisten für Eltern haben keinen Personenbezug; die Zuordnung Exemplar ↔ Person (BU-11) gilt nur im laufenden Schuljahr und wird bei der Rücknahme ohne Befund gelöscht. Ausgabe (klassen-/kursweise per Scan) und Rücknahme macht nur die Verwaltung mit „Schulbuchausleihe“; der Zustand bei der Rücknahme steht am Exemplar ohne Person, Ausgabe und Rücknahme stehen im Audit-Log nur mit der Inventarnummer. Nach Ablauf der Rückgabefrist (Ende des Schuljahres) mahnt SchulOS an Schultagen wie in der Bücherei, Eltern Minderjähriger aber schon ab der 1. Mahnung – ohne Titel.",
  },
});
