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
    { href: "/planung", label: "Stundenplanung", icon: "CalendarCog", requires: ["stundenplan.manage", "stundenplan.substitute"] },
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
      table: "timetable_substitutions",
      purpose: "Vertretungen und Ausfälle bekanntgeben",
      categories: ["Stunde", "Datum", "Vertretungslehrkraft", "Raum", "Hinweis", "Eingetragen von"],
      class: "LK-SJ-1J",
      start: "date",
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
    { table: "timetable_assignment_groups", purpose: "Unterricht verteilen (Lehraufträge)", categories: ["Gruppe"], follows: "timetable_assignments" },
    { table: "timetable_assignment_teachers", purpose: "Unterricht verteilen (Lehraufträge)", categories: ["Lehrkraft"], follows: "timetable_assignments" },
    {
      table: "timetable_deputies",
      purpose: "Deputat planen",
      categories: ["Lehrkraft", "Pflichtstunden"],
      class: "LK-SJ-1J",
      start: "school_year_id",
    },
    {
      table: "timetable_reductions",
      purpose: "Deputat planen (Ermäßigungen und Anrechnungen)",
      categories: ["Lehrkraft", "Grund (feste Liste, ohne Gesundheitsbezug)", "Stunden", "Ergänzung"],
      class: "LK-SJ-1J",
      start: "school_year_id",
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
      purpose: "Vertretungsmaterial der abwesenden Lehrkraft für die Vertretung (Q5-12)",
      categories: ["Stunde", "Datum", "Arbeitsauftrag", "Datei", "für Schüler:innen sichtbar", "Eingetragen von"],
      follows: "timetable_absences",
      note: "sichtbar für die Lehrkraft selbst, die Vertretung dieser Stunde, die Planung und – nur mit Häkchen – die Schüler:innen der Gruppe",
    },
    {
      table: "timetable_duties",
      purpose: "Pausenaufsichten planen",
      categories: ["Lehrkraft", "Bereich", "Wochentag", "Pause"],
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
        "Rücknahme-Daten (beendete und entfernte Stunden mit Lehrkraft, nur bis zum Stichtag)",
      ],
      class: "LK-90",
      start: "created_at",
      note: "SP-06: Nachtjob löscht fehlgeschlagene/abgebrochene Läufe ohne Ergebnis nach 7 Tagen und entfernt bei älteren fertigen Läufen (je Schuljahr ab dem 21.) den Vorschlag; die Herkunft `solver_run_id` an Stunden wird mit dem Lauf leer, die Stunden bleiben. SP-09: Rücknahme-Daten einer Übernahme (`undo`) bleiben nur bis zum Stichtag – der Nachtjob leert sie ab dem Stichtag, „Übernahme zurücknehmen“ sofort",
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
    note: "Automatische Stundenplanung (Solver-Läufe): Planvorschläge, Parameter, Kennzahlen und Protokoll sieht nur die Stundenplanung (`stundenplan.manage`), sie sind Entwürfe ohne Außenwirkung (90 Tage, ältere Vorschläge und gescheiterte Läufe räumt ein Nachtjob früher ab); erst die Übernahme ab einem Stichtag schreibt Stunden in den Plan, die Rücknahme-Daten dazu bleiben nur bis zu diesem Stichtag. Eine Vertretung kann ein abweichendes Fach nennen („Mathe statt Sport“, nur die Bezeichnung des Fachs, kein weiterer Personenbezug). Abwesenheiten von Lehrkräften werden ohne Grund gespeichert; Deputate und Zeitwünsche sieht nur die Planung – und die Lehrkraft ihre eigenen Zahlen und Wünsche (ohne Vergleich mit anderen); Zeitwünsche tragen Lehrkräfte im Eingabefenster der Planung selbst ein, die Planung sieht, wer abgegeben hat. Vertretungen von Pausenaufsichten melden einen Gong an die vertretende und die eingeteilte Lehrkraft. Im Modus „erst nach Freigabe“ sehen nur die Planung Änderungen eines Tages im Entwurf; alle anderen sehen den veröffentlichten Stand. Vertretungen und Entfall melden (sofort bzw. beim Veröffentlichen) einen Gong je Person und Tag an Schüler:innen, Lehrkräfte und – nach Moduleinstellung bis Jahrgang, nie in der Oberstufe – an Eltern (mit Name der Vertretungslehrkraft, ohne Grund für die Abwesenheit einer Lehrkraft und ohne die Notiz der Planung – die sehen nur Schüler:innen und Lehrkräfte).",
  },
});
