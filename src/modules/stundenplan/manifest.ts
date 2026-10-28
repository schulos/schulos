import { defineModule } from "@/core/modules/types";
import { STAFF_ROLES } from "@/core/roles";
import { STUNDENPLAN_SETTINGS } from "./settings";

export default defineModule({
  id: "stundenplan",
  name: "Stundenplan",
  description: "Stunden- und Vertretungsplan für Klassen, Kurse, Lehrkräfte und Räume",
  icon: "Table2",
  section: "organisation",
  order: 10,
  mobile: 2,
  permissions: {
    // SP-02: Jahresplanung (Pflege, Verteilung, Deputate, Zeitwünsche, Aufsichtsplan, Solver, Kurswahl-Übernahme)
    "stundenplan.manage": "Stundenplan planen (Pflege, Unterrichtsverteilung, Deputate, Zeitwünsche, Aufsichtsplan, automatisch planen)",
    // SP-02: Tagesgeschäft – getrennt vergebbar (Sekretariat, Schulleitung morgens)
    "stundenplan.substitute": "Vertretungen planen (Vertretungen, Abwesenheiten, Veröffentlichen, Raumsperren, Aufsichtsvertretung)",
    // I-26: Fortbildung/dienstliche Abwesenheit, die eine Lehrkraft selbst meldet, genehmigt die Schulleitung
    "stundenplan.absence_approve": "Selbst gemeldete Abwesenheiten von Lehrkräften genehmigen (Fortbildung, dienstlich – Schulleitung)",
    // SP2-12: Fachbedarf und Prognose lesen – nur Zahlen je Fach, keine Namen (Schulleitung); Details und Pflege bleiben bei `manage`
    "stundenplan.forecast_view": "Fachbedarf einsehen (Bedarf, Versorgung und Prognose je Fach – nur Summen, keine Namen)",
    // SP3-03 (F-10-3): Schulleitung prüft Planentwürfe und gibt sie frei – ohne Vier-Augen-Zwang (Migration gibt es der Gruppe Schulleitung)
    "stundenplan.review": "Planentwurf prüfen und freigeben (Entwürfe ab „in Prüfung“ lesen, kommentieren, freigeben oder zurück an die Planung)",
  },
  // SP-02 (Q-SP-3): keine Rollen-Vorgabe mehr – geplant wird über die Funktionsgruppe „Stundenplanung“ (Migration 0088 legt sie an).
  // Bestehende Installationen behalten ihren Grant `verwaltung → stundenplan.manage` (grants.synced merkt sich das Paar).
  defaultGrants: {},
  nav: [
    { href: "/stundenplan", label: "Stundenplan" },
    // SP-05: alle Beschäftigten (auch Hausmeisterei/Personal und Beratung, Q5-08) – wie die Seite (`seesAllPlans`)
    { href: "/stundenplan/raeume", label: "Räume", icon: "DoorOpen", roles: [...STAFF_ROLES] },
    // Q5-09: eigene Zahlen (Deputat, Vertretungsstunden), nur für die Lehrkraft selbst
    { href: "/stundenplan/deputat", label: "Mein Deputat", icon: "ListChecks", roles: ["lehrkraft"] },
    // P4-74: eigene Abwesenheit melden (krank sofort, Fortbildung/dienstlich mit Genehmigung) und Vertretungsmaterial hinterlegen
    { href: "/stundenplan/abwesenheit", label: "Abwesenheit melden", icon: "CalendarX", roles: ["lehrkraft"] },
    // Q5-10: eigene Zeitwünsche, im Eingabefenster der Planung selbst eintragen
    { href: "/stundenplan/zeitwuensche", label: "Zeitwünsche", icon: "CalendarCheck", roles: ["lehrkraft"] },
    // SP-03: eigener Bereich für die Planung (Jahresplanung und Tagesgeschäft) – nicht mehr unter Verwaltung
    { href: "/planung", label: "Stundenplanung", icon: "CalendarCog", requires: ["stundenplan.manage", "stundenplan.substitute", "stundenplan.forecast_view", "stundenplan.review"] },
  ],
  settings: STUNDENPLAN_SETTINGS,
  retention: [
    {
      table: "timetable_lessons",
      purpose: "Unterricht planen",
      categories: ["Gruppe", "Fach", "Lehrkraft", "Raum", "Zeit"],
      class: "LK-SJ-1J",
      start: "valid_until",
      fallback: "created_at",
      note: "zählt ab dem letzten Gültigkeitstag",
    },
    {
      // SP3-01: Hülle einer Planversion (Entwurf, Prüfung, Freigabe, gültig, archiviert, verworfen) – Personen nur als Handelnde
      table: "timetable_plan_versions",
      purpose: "Stundenplan in Versionen planen (Entwürfe, Varianten, gültige und archivierte Versionen)",
      categories: [
        "Nummer, Name (ohne Personen), Status, Stichtag",
        "Angelegt, zur Prüfung gegeben, freigegeben, veröffentlicht, verworfen – von und am",
        "Fahrplan-Häkchen und Quittierungen",
        "Rücknahme-Daten der Veröffentlichung (Stunden mit Lehrkraft, nur bis zum Stichtag)",
        "Änderungsliste an Schüler:innen/Eltern (Zeilen je Klasse/Kurs mit Kürzeln, nur bis zum Versand)",
      ],
      class: "LK-SJ-1J",
      start: "school_year_id",
      note: "nur für die Planung (`stundenplan.manage`) sichtbar; offene Entwürfe eines abgelaufenen Schuljahrs verwirft der Nachtjob, Rücknahme-Daten leert er ab dem Stichtag; bei Kontolöschung werden die Handelnden leer",
    },
    {
      // SP3-01: Stunden eines Entwurfs – Entwurf ohne Außenwirkung, gehen mit der Version
      table: "timetable_draft_lessons",
      purpose: "Stundenplan in Versionen planen (Stunden eines Entwurfs)",
      categories: ["Gruppe", "Fach", "Lehrkraft", "Raum", "Zeit", "Herkunft im gültigen Plan"],
      follows: "timetable_plan_versions",
      note: "Entwurf ohne Außenwirkung: nur die Planung sieht ihn (kein Stundenplan, Vertretungsplan, Monitor oder Export liest ihn), bis er veröffentlicht wird; bei Kontolöschung wird die Lehrkraft leer",
    },
    {
      // SP3-03: Prüfkommentare (Schulleitung, Planung) und Rückmeldungen aus der Lehrkräfte-Vorschau – gehen mit der Version
      table: "timetable_plan_comments",
      purpose: "Stundenplan in Versionen planen (Prüfung, Freigabe, Rückmeldung zur Vorschau)",
      categories: ["Text (ohne Gesundheitsangaben)", "Bezug (Version, Lehrkraft, Klasse/Kurs oder Stunde)", "Verfasst von/am", "Erledigt von/am", "aus der Lehrkräfte-Vorschau"],
      follows: "timetable_plan_versions",
      note: "sichtbar für die Planung (`stundenplan.manage`) und die Prüfung (`stundenplan.review`, ab „in Prüfung“); eine Lehrkraft sieht nur eigene Kommentare; nie Schüler:innen, Eltern, Monitor oder Gong. Bei Kontolöschung werden Verfasser:in, Bezug und „erledigt von“ leer; der Text bleibt bis zur Löschung der Version",
    },
    {
      // SP3-05 (F-10-2, F-10-13): Protokoll der Sofort-Korrekturen am gültigen Plan – Vorher/Nachher mit Kennungen, Kontolöschung ersetzt sie
      table: "timetable_plan_changes",
      purpose: "Sofort-Korrekturen am gültigen Stundenplan nachvollziehen und Betroffene benachrichtigen",
      categories: [
        "Art der Änderung (geteilt, direkt geändert, entfallen, neu) und Stichtag",
        "Stunde vorher/nachher (Gruppe, Fach, Lehrkraft, Raum, Zeit – Kennungen, keine Namen)",
        "Begründung (optional, ohne Personen)",
        "Geändert von/am",
        "Änderungsliste an Schüler:innen/Eltern: geplant und versandt (Zeitpunkte)",
      ],
      class: "LK-SJ-1J",
      start: "created_at",
      note: "nur für die Planung (`stundenplan.manage`) sichtbar; Lehrkräfte, Schüler:innen und Eltern bekommen nur ihre Änderungsliste als Gong. Bei Kontolöschung wird die Lehrkraft in Vorher/Nachher durch „gelöschte Lehrkraft“ ersetzt, „geändert von“ wird leer",
    },
    {
      table: "timetable_substitutions",
      purpose: "Vertretungen und Ausfälle bekanntgeben",
      categories: [
        "Stunde",
        "Datum",
        "Vertretungslehrkraft",
        "Raum",
        "Hinweis für Schüler:innen",
        "Verlegt in Stunde",
        "Zusammengelegt mit Stunde",
        "Grund-Kategorie (grob, z. B. „Lehrkraft abwesend“)",
        "interner Hinweis",
        "nur Betreuung",
        "Kenntnisnahme der Vertretungslehrkraft (Zeitpunkt)",
        "Eingetragen und zuletzt geändert von/am",
      ],
      class: "LK-SJ-1J",
      start: "date",
      note: "VT-01: die Grund-Kategorie ist öffentlich und bewusst grob (eine Lehrkraft-Abwesenheit heißt immer „Lehrkraft abwesend“); interner Hinweis und Kenntnisnahme nur für die Vertretungsplanung bzw. die Vertretungslehrkraft, nie für Schüler:innen, Eltern oder Monitore",
    },
    {
      // VT-01 (F-10-13): Historie mit Vorher/Nachher; Kontolöschung ersetzt die Kennung der Vertretungslehrkraft (DS-21-Muster)
      table: "timetable_substitution_changes",
      purpose: "Vertretungen nachvollziehen (Änderungsverlauf, Marker „neu/geändert“)",
      categories: ["Stunde", "Datum", "Art der Änderung", "Stand vorher/nachher (Vertretungslehrkraft, Raum, Fach, Hinweise, Grund-Kategorie)", "Geändert von/am"],
      class: "LK-SJ-1J",
      start: "date",
      note: "nur für die Vertretungsplanung sichtbar; bei Kontolöschung wird die Lehrkraft in Vorher/Nachher durch „gelöschte Lehrkraft“ ersetzt (auch Kürzel/Namen in den Hinweisen), „geändert von“ wird leer",
    },
    {
      // VT-01: Tagesmitteilungen (Freitext ohne Personen) – folgen der Tagesfreigabe
      table: "timetable_day_notes",
      purpose: "Vertretungsplan: Mitteilungen zum Tag (alle bzw. nur Beschäftigte)",
      categories: ["Datum", "Text (ohne Personen)", "Zielgruppe", "Eingetragen von"],
      class: "LK-SJ-1J",
      start: "date",
    },
    {
      // VT-04 (F-10-11): Sendewarteschlange – wer zu welchem Tag wann benachrichtigt wird; der Inhalt steht nur im Gong (`notifications`)
      table: "timetable_notification_queue",
      purpose: "Vertretungsnachricht zur eingestellten Zeit senden (Vortag, Ruhezeit)",
      categories: ["Empfänger:in", "Vertretungstag", "Zielgruppe (Lehrkräfte/Lernende)", "geplante und tatsächliche Sendezeit"],
      class: "LK-90",
      start: "created_at",
      note: "keine Inhalte, nur Zeitpunkte; bei Kontolöschung werden die Einträge der Person mitgelöscht",
    },
    {
      table: "timetable_substitution_days",
      purpose: "Vertretungsplan erst nach Freigabe veröffentlichen (Entwurf je Tag)",
      categories: ["Datum", "Angelegt von", "Veröffentlicht von und wann"],
      class: "LK-SJ-1J",
      start: "date",
    },
    {
      table: "timetable_assignments",
      purpose: "Unterricht verteilen (Lehraufträge)",
      categories: ["Fach", "Wochenstunden", "Raumwunsch", "Hinweis"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      // SP2-01: Bänder bündeln Lehraufträge zur selben Zeit; ohne Personenbezug (Name wie „Religion/Philosophie 7“), Löschung wie die Lehraufträge
      table: "timetable_bands",
      purpose: "Unterricht verteilen (Bänder: Lehraufträge zur selben Zeit)",
      categories: ["Name des Bands", "Wochenstunden"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    { table: "timetable_assignment_groups", purpose: "Unterricht verteilen (Lehraufträge)", categories: ["Gruppe"], follows: "timetable_assignments" },
    { table: "timetable_assignment_teachers", purpose: "Unterricht verteilen (Lehraufträge)", categories: ["Lehrkraft"], follows: "timetable_assignments" },
    {
      table: "timetable_deputies",
      purpose: "Deputat planen",
      categories: ["Lehrkraft", "Pflichtstunden (auch 2. Halbjahr)", "Teilzeit-Anteil"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      table: "timetable_reductions",
      purpose: "Deputat planen (Ermäßigungen und Anrechnungen)",
      categories: ["Lehrkraft", "Grund (feste Liste, ohne Gesundheitsbezug)", "Stunden", "Ergänzung", "gültig ab/bis"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      // SP2-04: Tagesregeln je Lehrkraft (Teilzeit) – Personaldaten wie das Deputat, ohne Grund
      table: "timetable_teacher_day_rules",
      purpose: "Deputat planen (Tagesregeln: Stunden je Tag, Anwesenheitstage)",
      categories: ["Lehrkraft", "höchstens Stunden am Tag", "höchstens Anwesenheitstage"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      // SP2-12: Lehrfächer (Fakultas) – Stammdatum der Lehrkraft ohne Schuljahr, geht mit dem Konto
      table: "timetable_teacher_subjects",
      purpose: "Unterricht verteilen und Fachbedarf planen (Lehrfächer je Lehrkraft)",
      categories: ["Lehrkraft", "Lehrfach"],
      class: "LK-KONTO",
      start: "teacher_id",
      note: "sieht die Planung (Verteilung, Fachbedarf, Vorschläge bei der Zuweisung und für Vertretungen); die Schulleitung mit „Fachbedarf einsehen“ nur die Zahl der Lehrkräfte je Fach",
    },
    {
      // SP2-12: Prognose – Abgang (Lehrkraft, Datum, Stunden) bzw. Zugang (Fächer, Datum, Stunden), ohne Begründung
      table: "timetable_staff_changes",
      purpose: "Fachbedarf des nächsten Schuljahres prognostizieren (bekannte Abgänge und Zugänge)",
      categories: ["Lehrkraft (nur Abgang)", "ab Datum", "Stunden", "Fächer (nur Zugang)", "Eingetragen von"],
      class: "LK-ENDE-1J",
      start: "effective_on",
      note: "ohne Begründung (kein Ruhestand, keine Elternzeit o. Ä.); Abgänge sieht nur die Planung (`stundenplan.manage`), die Schulleitung nur Summen je Fach; ein Jahr nach dem Datum gelöscht, mit dem Konto sofort",
    },
    {
      table: "timetable_room_blocks",
      purpose: "Räume sperren (Renovierung, Prüfung) und Ausweichräume planen",
      categories: ["Raum", "Zeitraum", "Grund", "Ergänzung", "Eingetragen von"],
      class: "LK-SJ-1J",
      start: "ends_on",
    },
    {
      table: "timetable_absences",
      purpose: "Vertretung planen (Abwesenheit von Lehrkräften und Klassen)",
      categories: ["Lehrkraft oder Gruppe", "Zeitraum", "Grund (feste Liste, bei Krankheit nur „krank“)", "Ergänzung", "Eingetragen von"],
      class: "LK-SJ-1J",
      start: "ends_on",
      note: "Grund nur für die Vertretungsplanung (und bei Anträgen der Schulleitung) sichtbar, nie auf dem Vertretungsplan; auch von der Lehrkraft selbst gemeldet (P4-74)",
    },
    {
      table: "timetable_absence_materials",
      purpose: "Vertretungsmaterial für die Vertretung (Q5-12; VT-01: auch ohne Abwesenheit)",
      categories: ["Stunde", "Datum", "Abwesenheit (falls vorhanden)", "Arbeitsauftrag", "Datei", "für Schüler:innen sichtbar", "Eingetragen von"],
      class: "LK-SJ-1J",
      start: "date",
      note: "sichtbar für die Lehrkraft der Stunde bzw. die abwesende Lehrkraft, die Vertretung dieser Stunde, die Planung und – nur mit Häkchen – die Schüler:innen der Gruppe; Material zu einer Abwesenheit geht zusätzlich mit ihr (VT-01, F-10-12: eigene Frist ab Datum statt „folgt der Abwesenheit“)",
    },
    {
      table: "timetable_duties",
      purpose: "Pausenaufsichten planen",
      categories: ["Lehrkraft", "Bereich", "Wochentag", "Pause"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      // SP2-07: Bereitschaft (Vertretungsreserve) – Personaldienst wie der Aufsichtsplan, nur für die Vertretungsplanung sichtbar
      table: "timetable_standby",
      purpose: "Vertretungen planen (Bereitschaften je Stunde)",
      categories: ["Lehrkraft", "Wochentag", "Stunde", "Eingetragen von"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      table: "timetable_time_prefs",
      purpose: "Stundenplan nach Zeitwünschen planen (Lehrkraft, Klasse, Raum, Fach)",
      categories: ["Lehrkraft/Gruppe/Raum/Fach", "Wochentag", "Stunde", "Wunsch −3 … +3 oder gesperrt"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      table: "timetable_time_pref_submissions",
      purpose: "Zeitwünsche selbst abgeben (Stand für die Planung)",
      categories: ["Lehrkraft", "Zeitpunkt der Abgabe"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      table: "timetable_solver_runs",
      purpose: "Automatische Stundenplanung (Läufe und Vorschläge)",
      categories: [
        "Planvorschlag (Lehrkräfte, Gruppen, Räume, Zeiten)",
        "Bezeichnung",
        "Parameter",
        "Kennzahlen",
        "Protokoll (Kürzel, Gruppen)",
        "Gestartet von",
        "Übernommen von",
        "Rücknahme-Daten (beendete und entfernte Stunden mit Lehrkraft, entfallene Vertretungen, nur bis zum Stichtag)",
      ],
      class: "LK-90",
      start: "created_at",
      note: "SP-06: Nachtjob löscht fehlgeschlagene/abgebrochene Läufe ohne Ergebnis nach 7 Tagen und entfernt bei älteren fertigen Läufen (je Schuljahr ab dem 21.) den Vorschlag; die Herkunft `solver_run_id` an Stunden wird mit dem Lauf leer, die Stunden bleiben. SP-09/SP-13: Rücknahme-Daten einer Übernahme (`undo`, inkl. der dabei entfernten Vertretungen) bleiben nur bis zum Stichtag – der Nachtjob leert sie ab dem Stichtag, „Übernahme zurücknehmen“ sofort",
    },
    {
      table: "timetable_duty_changes",
      purpose: "Pausenaufsichten vertreten",
      categories: ["Aufsicht", "Datum", "Vertretende Lehrkraft", "Eingetragen von"],
      class: "LK-SJ-1J",
      start: "date",
    },
  ],
  processing: {
    title: "Stunden-, Vertretungs- und Aufsichtsplanung",
    purpose: "Unterricht, Vertretungen, Räume und Pausenaufsichten planen und bekanntgeben",
    subjects: ["Lehrkräfte", "Schüler:innen"],
    recipients: [
      "Schulgemeinschaft (Stunden- und Vertretungsplan)",
      "Stundenplanung und Schulleitung (Deputate, Zeitwünsche, Abwesenheiten)",
      "die jeweilige Lehrkraft selbst (eigenes Deputat, eigene Vertretungsstunden und Aufsichten)",
    ],
    note: "Automatische Stundenplanung (Solver-Läufe): Planvorschläge, Parameter, Kennzahlen und Protokoll sieht nur die Stundenplanung (`stundenplan.manage`), sie sind Entwürfe ohne Außenwirkung (90 Tage, ältere Vorschläge und gescheiterte Läufe räumt ein Nachtjob früher ab); erst die Übernahme ab einem Stichtag schreibt Stunden in den Plan, die Rücknahme-Daten dazu bleiben nur bis zu diesem Stichtag. Eine Vertretung kann ein abweichendes Fach nennen („Mathe statt Sport“, nur die Bezeichnung des Fachs, kein weiterer Personenbezug). Abwesenheiten von Lehrkräften werden ohne Grund gespeichert; Deputate und Zeitwünsche sieht nur die Planung – und die Lehrkraft ihre eigenen Zahlen und Wünsche (ohne Vergleich mit anderen); Zeitwünsche tragen Lehrkräfte im Eingabefenster der Planung selbst ein, die Planung sieht, wer abgegeben hat. Bereitschaften (Vertretungsreserve je Stunde) sind Personaldienst und nur für die Vertretungsplanung sichtbar; Verlegung (Stunde rückt am selben Tag auf eine andere Stunde) und Zusammenlegung (Gruppe geht zu einer anderen Stunde, deren Lehrkraft mitbetreut) erscheinen wie Vertretungen im Vertretungsplan, die mitbetreuende Lehrkraft bekommt den Gong. Vertretungen von Pausenaufsichten melden einen Gong an die vertretende und die eingeteilte Lehrkraft. Im Modus „erst nach Freigabe“ sehen nur die Planung Änderungen eines Tages im Entwurf; alle anderen sehen den veröffentlichten Stand. Vertretungen und Entfall melden (sofort bzw. beim Veröffentlichen) einen Gong je Person und Tag an Schüler:innen, Lehrkräfte und – nach Moduleinstellung bis Jahrgang, nie in der Oberstufe – an Eltern (mit Name der Vertretungslehrkraft, ohne Grund für die Abwesenheit einer Lehrkraft und ohne die Notiz der Planung – die sehen nur Schüler:innen und Lehrkräfte). VT-01: Vertretungen nennen öffentlich nur eine grobe Grund-Kategorie (bei fehlender Lehrkraft immer „Lehrkraft abwesend“, nie krank/Fortbildung/dienstlich); ein interner Hinweis, die optionale Kenntnisnahme der Vertretungslehrkraft und der Änderungsverlauf (vorher/nachher) bleiben bei der Vertretungsplanung bzw. der Vertretungslehrkraft und erscheinen nie bei Schüler:innen, Eltern oder auf Monitoren.",
  },
});
