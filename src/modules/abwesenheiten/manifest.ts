import { defineModule } from "@/core/modules/types";
import { ABWESENHEITEN_SETTINGS } from "./settings";

export default defineModule({
  id: "abwesenheiten",
  name: "Abwesenheiten",
  description: "Krankmeldungen der Eltern, Entschuldigungen durch die Klassenleitung",
  icon: "BedDouble",
  section: "organisation",
  order: 25,
  permissions: {
    "abwesenheiten.manage": "Alle Abwesenheiten bearbeiten",
    "abwesenheiten.phone": "Krankmeldungen im Namen der Eltern erfassen (Telefon)",
    "abwesenheiten.leave_decide": "Beurlaubungen über der Grenze entscheiden (Schulleitung)",
  },
  defaultGrants: { verwaltung: ["abwesenheiten.phone"] },
  nav: [
    { href: "/abwesenheiten", label: "Abwesenheiten", roles: ["eltern", "lehrkraft", "verwaltung", "admin"] },
    // Q5-13: eigene Fehlzeiten (Fehlstunden, Verspätungen, Status)
    { href: "/abwesenheiten", label: "Fehlzeiten", roles: ["schueler"] },
  ],
  settings: ABWESENHEITEN_SETTINGS,
  retention: [
    {
      table: "absence_reports",
      purpose: "Abwesenheiten melden und entschuldigen",
      categories: ["Schüler:in", "Zeitraum", "Grund (krank/sonstiges, ohne Freitext)", "Status", "Meldende Person"],
      class: "LK-SJ",
      start: "to_date",
      // DS-16: gilt die digitale Meldung als schriftliche Entschuldigung, bleibt sie, bis der Archivexport, der genau diese Meldung
      // enthält, als übergeben bestätigt ist (G4D-S01: je Meldung vermerkt, nicht „irgendeine Klasse des Schuljahres“)
      setting: "abwesenheiten.digital_written",
      where:
        "{setting} = 0 or exists (select 1 from record_archives ra where ra.id = absence_reports.archive_id and ra.handed_over_at is not null and ra.handed_over_at >= absence_reports.archived_at)",
      held: "Meldungen warten auf die Übergabe des Archivexports ihrer Klasse (Schuljahreswechsel: Archivexport erstellen, Übergabe bestätigen) – als Entschuldigung Teil der Schülerakte, daher keine Löschung ohne Archiv",
      note: "Gesundheitsbezug – so kurz wie möglich; das Ergebnis „entschuldigt“ steht im Klassenbuch. Gilt die digitale Meldung als schriftliche Entschuldigung (Einstellung, Vorgabe ja), geht sie als Teil „Entschuldigungen“ in den Archivexport (5 Jahre, § 9 Abs. 1 Nr. 4 VO-DV I, BASS 12-51 Nr. 5 Nr. 3) und wird erst gelöscht, wenn der Export, der sie enthält, als übergeben bestätigt ist; bis dahin zählt die Löschvorschau sie als „zurückgehalten“",
    },
    {
      table: "absence_leave_requests",
      purpose: "Beurlaubung vorab beantragen und entscheiden",
      categories: ["Schüler:in", "Zeitraum", "Schultage", "Grund (Auswahl ohne Freitext, ohne Religion/Gesundheit)", "Status", "Antragstellende und entscheidende Person"],
      class: "LK-SJ-1J",
      start: "to_date",
      note: "Nachweis der Genehmigung bis ein Jahr nach Schuljahresende (Rückfragen zur Schulpflicht); das Ergebnis „entschuldigt“ steht im Klassenbuch",
    },
  ],
  processing: {
    title: "Krankmeldungen, Entschuldigungen und Beurlaubungen",
    purpose: "Krankmeldungen der Eltern entgegennehmen, Fehlzeiten entschuldigen, Beurlaubungen vorab beantragen und entscheiden sowie Schüler:innen bzw. Eltern minderjähriger Kinder über die eigenen Fehlzeiten informieren",
    // DS-17 (B05-KRANKMELDUNG.md): § 122 Abs. 1 Satz 2 SchulG erklärt selbst, dass § 120 auf Art. 9 Abs. 2 lit. g DSGVO beruht
    legalBasis:
      "Art. 6 Abs. 1 lit. e, Abs. 3 und Art. 9 Abs. 2 lit. g DSGVO i. V. m. § 120 Abs. 1, § 122 Abs. 1 Satz 2 und § 43 Abs. 2 SchulG NRW sowie VO-DV I Anlage 1 Abschn. A Nr. II Ziff. 19.1 (Schulversäumnis: Beginn, Ende, Grund), Anlage 2 I Nr. 1 (Klassenbuch) und II Nr. 1 (Schülerakte); Beurlaubung: § 43 Abs. 4 SchulG NRW, VO-DV I Anlage 1 Abschn. A Nr. II Ziff. 18 (Beurlaubung: Beginn, Ende, Grund)",
    subjects: ["Schüler:innen", "Eltern"],
    recipients: [
      "Klassenleitung",
      "Schulleitung (u. a. Beurlaubungen über der eingestellten Zahl Schultage)",
      "Personen mit dem Recht „Alle Abwesenheiten bearbeiten“ (Meldungen und Gründe aller Klassen)",
      "Admin-Konten (technische Betreuung; sehen Meldungen ohne Grund „krank“/„sonstiges“ – DS-20 – und Beurlaubungen samt Grund)",
      "Sekretariat (nimmt telefonische Meldungen im Namen der Eltern auf; sieht dabei nur die eigene Eingabe)",
      "alle verknüpften Eltern minderjähriger Kinder (Meldungen und Anträge samt Grund, auch die des anderen Elternteils)",
      "meldendes bzw. antragstellendes Elternteil bzw. die eigenständige (volljährige) Schüler:in selbst (Status der eigenen Meldung bzw. des Antrags)",
      "Schüler:in (eigene Fehlstunden, Verspätungen und deren Status)",
      "Eltern minderjähriger Kinder (Fehlzeiten des eigenen Kindes; Gong erst nach der Entscheidung „nicht entschuldigt“ durch die Klassenleitung) – bei eigenständigen (volljährigen) Schüler:innen nur mit deren Einwilligung und ohne Gründe der Meldungen",
    ],
    note: "Gesundheitsdaten nur als „krank“ bzw. „sonstiger Grund“, nie mit Diagnose. Einsicht der Eltern in Fehlzeiten wird protokolliert; ab einer einstellbaren Zahl unentschuldigter Fehltage bekommt nur die Klassenleitung einen Hinweis – keine automatische Meldung an Schulleitung oder Behörden. Beurlaubungsgründe nur als Auswahl (familiärer Anlass, Wettkampf/Veranstaltung, sonstiger Grund) – ohne Freitext, keine Religion als Grund. Fachlehrkräfte sehen nur „entschuldigt“/„nicht entschuldigt“. Melde- und Beurlaubungsformular tragen einen Hinweis nach Art. 13 DSGVO (Rechtsgrundlage, Aufbewahrung, wer den Grund sieht, keine Atteste über Messenger oder Dateien).",
  },
});
