// DSB-Checkliste (DS-13): Arbeitsliste für die/den Datenschutzbeauftragte(n) der Schule – je Thema, was SchulOS tut, welche
// Vorgabe gilt und was die Schule entscheiden bzw. dokumentieren muss. Eine Datenquelle für beides:
//   · docs/DSB-FRAGEN.md – die Kurzfassung je Thema steht dort zwischen `<!-- dsb:<id> -->` und `<!-- /dsb -->` und wird aus
//     dieser Datei erzeugt (`npx tsx scripts/dsb-checkliste.ts`); `checkliste.test.ts` schlägt an, wenn beides auseinanderläuft.
//   · Verwaltung → Datenschutz → Einrichtung (DS-12) – jedes Thema ist dort ein abhakbarer Punkt.
// Grundsatz (Projektleitung 2026-10-11): Die Schule ist Verantwortliche und entscheidet; SchulOS liefert sichere Vorgaben und Werkzeuge.
// Alle Rechtsaussagen sind Planungsannahmen – zu prüfen.
import type { ModuleSettingDecl } from "@/core/modules/settings";

export interface DsbTopic {
  /** stabile Kennung (Statusspeicher DS-12, Marker in DSB-FRAGEN.md) */
  id: string;
  /** Abschnittsnummer in docs/DSB-FRAGEN.md (Verweise wie „DSB-FRAGEN §8“ bleiben gültig) */
  nr: number;
  title: string;
  /** was SchulOS technisch tut */
  schulos: string;
  /** Vorgabe ab Werk */
  vorgabe: string;
  /** was die Schule entscheiden bzw. dokumentieren muss */
  schule: string;
  /** zugehörige Moduleinstellungen (volle Schlüssel) – jede Moduleinstellung gehört zu genau einem Thema (Test) */
  settings?: readonly string[];
  /**
   * Baustein für Nutzungsordnung bzw. Dienstanweisung (P5-17): Textvorschlag, den die Schule übernehmen und anpassen kann –
   * erscheint in docs/DSB-FRAGEN.md und unter Verwaltung → Datenschutz → Einrichtung.
   */
  baustein?: string;
  /** Stelle in SchulOS, an der die Schule es einstellt bzw. nachsieht */
  where?: { label: string; href: string };
}

export const DSB_TOPICS: readonly DsbTopic[] = [
  {
    id: "verantwortung",
    nr: 0,
    title: "Verantwortung und Datenschutzbeauftragte:r",
    schulos: "Erzeugt Datenschutzhinweise und VVT als Vorlage aus den eingeschalteten Modulen; nennt die Schule als Verantwortliche.",
    vorgabe: "Ohne Angaben der Schule bleiben Verantwortliche Stelle, DSB und Betrieb leer und die Einrichtung offen.",
    schule: "Bestätigt, dass sie Verantwortliche nach Art. 4 Nr. 7 DSGVO ist, trägt DSB (Name/Kontakt), Betreiber und Aufsichtsbehörde ein; klärt Auftragsverarbeitung, wenn der Schulträger oder ein Dienstleister betreibt.",
    where: { label: "Verwaltung → Datenschutz → Hinweise und VVT", href: "/verwaltung/datenschutz/angaben" },
  },
  {
    id: "krankmeldungen",
    nr: 1,
    title: "Krankmeldungen als Gesundheitsdaten (Art. 9)",
    schulos:
      "Speichert bei Abwesenheiten nur „krank“ oder „sonstiger Grund“, nie eine Diagnose; kein Freitext mit Gesundheitsbezug, kein Attest-Upload. Den Grund sehen nur Klassenleitung, Personen mit „Alle Abwesenheiten bearbeiten“ (z. B. Schulleitung), alle verknüpften Eltern minderjähriger Kinder bzw. die eigenständige Person selbst und – nur bei der Aufnahme – das Sekretariat bei Telefonmeldungen; Admin-Konten (technische Betreuung) sehen Zeitraum und Stand, aber keinen Grund (DS-20); Fachlehrkräfte nur „entschuldigt“/„nicht entschuldigt“. Hinweis nach Art. 13 am Melde- und Beurlaubungsformular.",
    vorgabe:
      "Mindestangabe „krank“/„sonstiger Grund“; die digitale Meldung gilt als schriftliche Entschuldigung (DS-16): eigener Teil „Entschuldigungen“ im Archivexport (5 Jahre), im System bis zur Übergabe des Exports, der die Meldung enthält (Löschvorschau: „zurückgehalten“), sonst Löschung zum Schuljahresende (LK-SJ).",
    schule:
      "Bestätigt die Lesart § 120 Abs. 1, § 122 Abs. 1 Satz 2, § 43 Abs. 2 SchulG NRW + VO-DV I Anlage 1 Ziff. 19.1 als Grundlage nach Art. 9 Abs. 2 lit. g DSGVO und dokumentiert sie im VVT; legt fest, ob die Meldung über SchulOS als schriftliche Entschuldigung gilt (sonst „nein“: Eltern entschuldigen zusätzlich auf Papier); vergibt „Alle Abwesenheiten bearbeiten“ sparsam (Admin-Konten sehen die Gründe nicht – dafür das Recht ausdrücklich vergeben).",
    settings: ["abwesenheiten.digital_written"],
    where: { label: "Verwaltung → Rechte & Module → Abwesenheiten", href: "/verwaltung/rechte" },
  },
  {
    id: "vo-dv",
    nr: 2,
    title: "VO-DV I und ihre Anlagen",
    schulos: "Ordnet jede Tabelle mit Personenbezug einem Zweck und einer Löschklasse zu; Module lassen sich einzeln abschalten.",
    vorgabe: "Alle Module der Demo-Auswahl eingeschaltet; Datenfelder nach Datensparsamkeit.",
    schule: "Gleicht Datenfelder und Module mit den Anlagen der VO-DV I ab und schaltet nicht Abgedecktes ab bzw. holt Einwilligungen ein.",
    where: { label: "Verwaltung → Rechte & Module", href: "/verwaltung/rechte" },
  },
  {
    id: "anmeldung",
    nr: 3,
    title: "Schulanmeldung",
    schulos: "Öffentliches Formular mit E-Mail-Bestätigung; erhebt nur, was Termin und Gespräch brauchen; Auskunft ohne Konto per Vorgangsnummer.",
    vorgabe: "Unbestätigte Anträge 48 h, abgelehnte/Warteliste Verfahrensabschluss + 60 Tage (je Verfahren 31–365), zurückgezogene/übernommene 90 Tage.",
    schule: "Entscheidet über Felder (Empfehlung, Anschrift), Fristen je Verfahren, Information von Elternteil 2, Identitätsprüfung bei Auskunft und Impressum.",
    where: { label: "Verwaltung → Schulanmeldung", href: "/verwaltung/anmeldung" },
  },
  {
    id: "schultraeger",
    nr: 4,
    title: "Hausmeister-Fotos und Beschäftigte des Schulträgers",
    schulos: "Mängelfotos nur von Sachen (Hinweis), EXIF entfernt, nur für Zuständige sichtbar; Rolle Personal ohne Schülerverzeichnis.",
    vorgabe: "Fotos gehen mit der Meldung (1 Jahr nach Abschluss).",
    schule: "Regelt mit dem Schulträger die Verantwortung für dessen Beschäftigte (ggf. Vereinbarung), bevor Konten angelegt werden.",
  },
  {
    id: "web-push",
    nr: 5,
    title: "Web-Push",
    schulos: "Kein Push über Dienste der Browserhersteller; Benachrichtigungen nur im Gong bzw. per Mail über den eigenen SMTP-Weg.",
    vorgabe: "Kein Push.",
    schule: "Entscheidet nur, falls Push später kommt: opt-in je Gerät, Nachricht ohne Namen und Inhalt.",
  },
  {
    id: "anonymitaet",
    nr: 6,
    title: "Anonymität auf Datenbankebene",
    schulos: "Anonyme Umfragen sind gegenüber allen Nutzenden anonym (Ergebnisse ab 5, in Fünferschritten); direkter Datenbankzugriff könnte Teilnahme und Antwort verknüpfen.",
    vorgabe: "Datenbankzugriff nur über die Wartungsrolle (TOM).",
    schule: "Beschränkt und protokolliert den Datenbankzugriff im Betrieb und legt die Grenze im Hinweis der Umfrage offen.",
  },
  {
    id: "barrierefreiheit",
    nr: 7,
    title: "Barrierefreiheitserklärung",
    schulos: "Liefert eine Vorlage mit dem Prüfergebnis (Block 4e).",
    vorgabe: "Noch keine Erklärung veröffentlicht.",
    schule: "Ergänzt Kontakt und Schlichtungsstelle und veröffentlicht die Erklärung, falls sie als öffentliche Stelle dazu verpflichtet ist.",
  },
  {
    id: "beratung",
    nr: 8,
    title: "Schulsozialarbeit: Beratungsgeheimnis und Träger",
    schulos: "Rolle Beratung ohne Fallakte; Chats mit Schüler:innen/Eltern nur zur Terminabsprache, nur von deren Seite begonnen, kürzere Löschfrist.",
    vorgabe: "Chat mit der Schulsozialarbeit aus; eingeschaltet Löschung 90 Tage nach der letzten Nachricht.",
    schule: "Holt das DSB-Votum ein (Beratungsgeheimnis, Träger, Verantwortlichkeit), schaltet erst danach ein und legt die Frist fest.",
    settings: ["messenger.counseling_chat", "messenger.counseling_keep_days"],
    where: { label: "Verwaltung → Rechte & Module → Messenger", href: "/verwaltung/rechte" },
  },
  {
    id: "beurlaubung",
    nr: 9,
    title: "Beurlaubung vorab",
    schulos: "Antrag durch Eltern ohne Freitext und ohne Art.-9-Gründe; Entscheidung nach Schultagen durch Klassenleitung bzw. Schulleitung; ersetzt keine Unterschrift.",
    vorgabe: "Klassenleitung bis 2 Schultage, Aufbewahrung Schuljahresende + 1 Jahr.",
    schule: "Prüft Zuständigkeit und Formerfordernis nach § 43 SchulG NRW, stellt die Grenze passend ein und vergibt das Recht „Beurlaubungen über der Grenze entscheiden“ (z. B. an die Gruppe Schulleitung) – sonst entscheiden darüber nur Admin-Konten.",
    settings: ["abwesenheiten.leave_class_lead_days"],
    where: { label: "Verwaltung → Rechte & Module → Abwesenheiten", href: "/verwaltung/rechte" },
  },
  {
    id: "fehlzeiten-eltern",
    nr: 10,
    title: "Information der Eltern über Fehlzeiten",
    schulos: "Eltern minderjähriger Kinder sehen Fehlzeiten (Einsicht protokolliert); Gong erst nach „nicht entschuldigt“ durch die Klassenleitung; keine Meldung an Behörden.",
    vorgabe: "Hinweis an die Klassenleitung ab 5 unentschuldigten Tagen im Halbjahr.",
    schule: "Klärt, ob die Information Pflicht oder zulässig ist (§ 43, § 123 SchulG NRW), und stellt die Schwelle ein.",
    settings: ["abwesenheiten.unexcused_hint"],
    where: { label: "Verwaltung → Rechte & Module → Abwesenheiten", href: "/verwaltung/rechte" },
  },
  {
    id: "pruefprotokolle",
    nr: 11,
    title: "Aufbewahrung der Prüfprotokolle",
    schulos: "Leert Protokoll-PDF und Bemerkung älterer Prüfungen; Termin, Ergebnis und Firma bleiben als Nachweis.",
    vorgabe: "Letzte 2 Protokolle, frühestens ein Jahr nach der Prüfung.",
    schule: "Klärt mit dem Schulträger die Nachweispflicht und wählt 2, 3 oder 5 Protokolle.",
    settings: ["gebaeude.report_keep"],
    where: { label: "Verwaltung → Rechte & Module → Gebäude & Technik", href: "/verwaltung/rechte" },
  },
  {
    id: "loeschfristen",
    nr: 12,
    title: "Löschfristen und Löschlauf",
    schulos: "Löscht nachts nach den Löschklassen, mit Vorschau, Löschprotokoll und Löschsperren; einstellbare Fristen nur innerhalb fester Grenzen (DATENSCHUTZ.md §3.9).",
    vorgabe: "Regelfristen der Löschklassen (Konten 90 Tage nach Abgang, Chats 1 Jahr, Termine 2 Jahre).",
    schule: "Prüft die Fristen, ändert sie bei Bedarf (Recht „Datenschutz“), kontrolliert jährlich Löschprotokoll, Sperren und Archivexporte.",
    settings: ["verwaltung.account_grace", "messenger.keep_days", "kalender.keep_days"],
    where: { label: "Verwaltung → Datenschutz (Löschkonzept, Löschlauf)", href: "/verwaltung/datenschutz" },
  },
  {
    id: "sichtbarkeit",
    nr: 13,
    title: "Kommunikation unter Schüler:innen und Information der Eltern",
    schulos:
      "Schaltet Direktchats unter Schüler:innen, die Eltern-Info zu Vertretungen und Hausaufgaben je Jahrgang und die Veröffentlichung des Vertretungsplans (Profilbilder im Sitzplan: §16).",
    vorgabe: "Direktchats nur in der eigenen Klasse, Eltern-Info Vertretung bis Jahrgang 10, Hausaufgaben für Eltern aus, Vertretungsplan sofort.",
    schule: "Entscheidet je Schalter nach pädagogischem Konzept und Erforderlichkeit und dokumentiert die Wahl.",
    settings: ["messenger.student_direct", "stundenplan.parents_substitution", "stundenplan.substitution_release", "klassenbuch.parents_homework"],
    where: { label: "Verwaltung → Rechte & Module", href: "/verwaltung/rechte" },
  },
  {
    id: "aussenzugang",
    nr: 14,
    title: "Außenzugang und Kalender-Abo",
    schulos: "Von außen per Vorgabe nichts erreichbar; öffentliche Seiten nur per Allowlist; Personal nur mit Gerätezertifikat; IP-Adressen nur gekürzt und gehasht für Rate-Limits. Kalender-Abo per widerrufbarem Link (nur lesend, eigene sichtbare Kalender) im Schulnetz, von außen nur im Modus „alles“ und nach denselben Regeln wie eine Anmeldung.",
    vorgabe: "Außenzugang „keiner“; Verwaltung/Admin von außen gesperrt; unbenutzte Abo-Links nach einem Jahr gelöscht.",
    schule: "Entscheidet mit dem Schulträger über Außenzugang und Gerätezertifikate, ergänzt die Datenschutzhinweise um die Technik der öffentlichen Seiten und weist in der Nutzungsordnung darauf hin, dass Abo-Links Termine an die Kalender-App der Person weitergeben.",
    where: { label: "Verwaltung → System", href: "/verwaltung/system" },
  },
  {
    id: "notenbuch",
    nr: 15,
    title: "Notenbuch der Lehrkraft",
    schulos:
      "Arbeitsnotenbuch der Fachlehrkraft (Anlage 2 II Nr. 4 VO-DV I): Teilnoten, Gewichtung, Vorschlag der Halbjahresnote, Kurzkommentar je Note (höchstens 200 Zeichen, keine Beobachtungsnotizen). Teilnoten sehen nur die Fachlehrkräfte des Lehrauftrags (Mitlehrkräfte gleichberechtigt, Vertretung nur per Übertragung); Klassenleitung und Schulleitung sehen nur Halbjahreswerte, jeder Abruf steht im Audit-Log; Verwaltung und Admin-Konten sehen keine Noten. Zwei-Faktor-Anmeldung ist für das Modul Pflicht. Offline-Eingabe nur auf Dienstgeräten: Teilnoten landen ohne Verbindung in einem verschlüsselten Zwischenspeicher des Browsers (Schlüssel nur zusammen mit einem Anteil des Servers, weg bei Abmeldung, Sitzungsablauf, Rechteentzug, spätestens nach 7 Tagen), Abgleich mit Konfliktanzeige – auf Privatgeräten von außen nie. Keine Zeugnisse, Zeugnisbemerkungen oder Benachrichtigungen nach § 50 SchulG – amtlich bleibt die Schulverwaltungssoftware.",
    vorgabe:
      "Modul ausgeschaltet; Notenbücher werden ein Jahr nach Ende ihres Schuljahres gelöscht (LK-SJ-1J); Noten für Schüler:innen und Eltern nicht sichtbar (einschaltbar: nur Halbjahresnoten nach dem Abschluss oder zusätzlich Teilnoten, nie Kommentare; Eltern bis zu einem Jahrgang der Sek I, bei eigenständigen Schüler:innen nur mit deren Einwilligung); Zwei-Faktor-Pflicht fest an; Offline-Eingabe nur auf Geräten mit Gerätezertifikat der Schule (einschaltbar: zusätzlich im Schulnetz mit Bestätigung je Gerät, dass es ein Dienstgerät ist; oder ganz aus).",
    schule:
      "Nimmt das Notenbuch ins VVT auf (Schulleitung, § 2 Abs. 2 VO-DV II) und lässt es vor Echtdaten durch die DSB prüfen (DA ADV Nr. 3); regelt den Zugriff vom Privatgerät (Genehmigung nach § 2 Abs. 2 VO-DV I bzw. Dienstgerät), die Aufbewahrung der Halbjahresliste und die Übertragung bei Ausfall einer Lehrkraft; vergibt „Halbjahreswerte einsehen“, „Übertragen“ und „Exportieren“ sparsam (z. B. an die Gruppe Schulleitung), legt fest, wer den Notenbuch-Teil der Auskunft erteilt (Recht „Notenbuch: Auskunft erteilen“, nie Admin-Konten), wählt die Rundung des Vorschlags auf der Grenze x,5 und ergänzt die Nutzungsordnung.",
    baustein:
      "Notenbuch in SchulOS: Lehrkräfte führen Teilnoten nur im Notenbuch von SchulOS und nur für die eigenen Lerngruppen. Der Zugriff erfolgt auf dienstlichen Geräten; ein privates Gerät nur mit schriftlicher Genehmigung der Schulleitung nach § 2 Abs. 2 VO-DV I. Kopien außerhalb von SchulOS (Bildschirmfotos, Exporte in private Cloud-Speicher oder Apps ohne Vertrag mit der Schule) sind nicht erlaubt. Kommentare bleiben kurz und sachlich, ohne Angaben zu Gesundheit, Familie oder Verhalten. Das Gerät wird beim Verlassen gesperrt, nach der Arbeit wird abgemeldet. Die Zwei-Faktor-Anmeldung ist für das Notenbuch Pflicht. Die Offline-Eingabe wird nur auf Dienstgeräten der Schule eingeschaltet, nie auf privaten Geräten; nach der Arbeit ohne Verbindung wird der Abgleich abgewartet und Konflikte werden aufgelöst. Notenbücher sind Daten der Schule und werden bei Abgang oder längerem Ausfall von der Schulleitung übertragen.",
    settings: ["notenbuch.student_view", "notenbuch.parents_view", "notenbuch.offline", "notenbuch.rounding"],
    where: { label: "Verwaltung → Rechte & Module → Notenbuch", href: "/verwaltung/rechte" },
  },
  {
    id: "sitzplan",
    nr: 16,
    title: "Sitzplan",
    schulos:
      "Sitzpläne je Lerngruppe nur für Lehrkräfte der Gruppe und die Klassenleitung, im Klassenbuch zusätzlich für die Lehrkraft, die die Stunde hält (Vertretung); nur Name, Initialen und Platz, keine Bemerkungen am Platz. Profilbilder nur von Personen mit Einwilligung (DS-09), der Druck enthält nie Fotos.",
    vorgabe: "Löschung zum Ende des Schuljahres der letzten Änderung (LK-SJ); Profilbilder im Sitzplan an (nur mit Einwilligung).",
    schule:
      "Bestätigt die Grundlage (aus Klassenlisten abgeleitete Daten, Anlage 2 II Nr. 3 VO-DV I), entscheidet über Profilbilder im Sitzplan und weist darauf hin, dass Fotositzpläne außerhalb von SchulOS nur mit Einwilligung zulässig sind.",
    settings: ["sitzplan.photos"],
    where: { label: "Verwaltung → Rechte & Module → Sitzplan", href: "/verwaltung/rechte" },
  },
  {
    id: "konferenz",
    nr: 17,
    title: "Externe Konferenzdienste im Kursraum",
    schulos:
      "Leitung, Lehrkräfte der Gruppe und Gruppenverwaltung können je Kursraum einen https-Link auf einen externen Konferenzraum hinterlegen (V-01). SchulOS speichert nur den Link, ruft den Dienst nie selbst auf und gibt die Adresse des Kursraums nicht weiter; der Knopf nennt den Rechnernamen und weist auf den externen Dienst hin. Sichtbar nur für Personen, die den Kursraum öffnen dürfen; das Protokoll enthält nur den Rechnernamen (der Link kann ein Raum-Passwort enthalten).",
    vorgabe: "Konferenzlinks aus; der Link wird mit der Gruppe gelöscht.",
    schule:
      "Wählt den Konferenzdienst (mit Vertrag zur Auftragsverarbeitung, z. B. über den Schulträger), nimmt ihn ins VVT auf und schaltet die Konferenzlinks erst danach ein; weist in der Nutzungsordnung darauf hin, dass nur dieser Dienst verlinkt wird.",
    settings: ["kurse.konferenz"],
    where: { label: "Verwaltung → Rechte & Module → Kursraum", href: "/verwaltung/rechte" },
  },
  {
    id: "buecherei",
    nr: 18,
    title: "Schulbücherei: Ausleihe ohne Leseprofil",
    schulos:
      "Speichert eine Ausleihe (Person, Exemplar, Fälligkeit) nur, solange sie offen ist: Die Rückgabe ohne Befund löscht sie sofort, es bleiben nur Zähler je Monat und Medienart ohne Person – kein Ausleihverlauf, keine Leseempfehlungen, Ausleihe und Rückgabe nicht im Audit-Log. Die Theke (Büchereiteam, auch Schüler-Helfer:innen) sieht nur Name, Klasse und offene Ausleihen der gewählten Person; Rückgaben mit Befund (Schaden, unvollständig) sieht nur die Verwaltung mit „Schulbuchausleihe“. Büchereiausweise tragen Name, Klasse und einen zufälligen Code (ohne Namen oder Kontonummer); Ersatz bei Verlust macht den alten Code ungültig, der Code geht mit dem Konto. Vormerkungen (Titel ↔ Person) gibt es nur für ganz ausgeliehene Titel; sie verschwinden mit der Ausleihe, mit Ablauf der Abholfrist, auf Wunsch sofort und spätestens nach 90 Tagen – die anderen sehen nur die Zahl der Vormerkungen, nie Namen. „Meine Ausleihen“ zeigt nur Aktuelles (offene Ausleihen und Vormerkungen), Eltern Minderjähriger sehen das ihrer Kinder lesend. Vor Fristende kommt eine Erinnerung, Überfälliges wird an Schultagen in drei Stufen gemahnt – ab der 2. Stufe auch an die Eltern Minderjähriger, auf Wunsch zusätzlich per Mail; Benachrichtigungen und Mails nennen keinen Titel. Die Mahnstufe endet mit der Rückgabe (nur ein Zähler je Monat bleibt); die Mahnliste des Büchereiteams zeigt Schüler-Helfer:innen keine Mahnstufen. Die Statistik zählt nur je Monat, Medienart und Exemplar, ohne Person. Optional schlägt der Bestand Titelangaben per ISBN bei öffentlichen Bibliothekskatalogen nach – übertragen wird nur die ISBN. Die Schulbuchausleihe (Stufe 2, zuschaltbar) pflegt Lernmittel je Jahrgang und Fach mit Inventarnummern und veröffentlichte Bücherlisten für Eltern – ohne Personenbezug; wem ein Schulbuch gehört, hält SchulOS nur im laufenden Schuljahr fest.",
    vorgabe: "Modul ab Werk aus; Leihfrist Buch 4 Wochen, Film/Spiel/Sonstiges 2 Wochen, Gerät 1 Woche, höchstens 2 Verlängerungen (nicht bei Vormerkung); bis 5 Vormerkungen je Person, Abholfrist 1 Woche; Erinnerung 2 Tage vor Fristende, Mahnungen im Abstand von 1 Woche, Mail aus; ISBN-Abfrage aus (eingeschaltet ab Werk nur die beiden deutschen Kataloge, Open Library außerhalb der EU aus); Befunde bis zur Erledigung + Schuljahresende + 1 Jahr (LK-SJ-1J); Schulbuchausleihe aus.",
    schule:
      "Bestätigt die Grundlage (Erfüllung der Aufgabe Schulbücherei, Anlage 1 bzw. 2 VO-DV I – zu prüfen), entscheidet, wer zum Büchereiteam gehört (Schüler-Helfer:innen sehen Namen und offene Ausleihen anderer), weist das Team auf Verschwiegenheit hin und stellt Leihfristen, Verlängerungen, Erinnerung und Mahnungen (auch per Mail) ein.",
    settings: [
      "buecherei.loan_days_buch",
      "buecherei.loan_days_film",
      "buecherei.loan_days_spiel",
      "buecherei.loan_days_geraet",
      "buecherei.loan_days_sonstiges",
      "buecherei.max_renewals",
      "buecherei.hold_days",
      "buecherei.max_reservations",
      "buecherei.remind_days",
      "buecherei.dunning_days",
      "buecherei.dunning_mail",
      "buecherei.isbn",
      "buecherei.isbn_dnb",
      "buecherei.isbn_lobid",
      "buecherei.isbn_openlibrary",
      "buecherei.lernmittel",
    ],
    baustein:
      "Büchereiteam: Wer an der Theke der Schulbücherei mithilft, sieht dort Namen, Klasse und offene Ausleihen anderer Schüler:innen und Lehrkräfte. Diese Angaben sind vertraulich und werden nur für die Ausleihe genutzt – nicht weitererzählt, nicht notiert, nicht fotografiert. Wer was liest, ist privat. Schäden werden nur als Sache beschrieben („Wasserschaden“), ohne Namen.",
    where: { label: "Verwaltung → Rechte & Module → Bücherei", href: "/verwaltung/rechte" },
  },
];

/** Rein: die Kurzfassung eines Themas für docs/DSB-FRAGEN.md (zwischen den Markern). */
export function topicMarkdown(topic: DsbTopic, settings: readonly ModuleSettingDecl[]): string {
  const rows: [string, string][] = [
    ["Was SchulOS tut", topic.schulos],
    ["Vorgabe", topic.vorgabe],
    ["Die Schule entscheidet / dokumentiert", topic.schule],
  ];
  const named = (topic.settings ?? []).map((k) => {
    const s = settings.find((x) => x.key === k);
    const def = s?.options.find((o) => o.value === s.default)?.label;
    return s ? `„${s.label}“ (Vorgabe: ${def ?? s.default})` : k;
  });
  if (named.length) rows.push(["Einstellungen", named.join("; ")]);
  if (topic.baustein) rows.push(["Baustein Nutzungsordnung", topic.baustein]);
  if (topic.where) rows.push(["In SchulOS", topic.where.label]);
  return ["| Punkt | |", "|---|---|", ...rows.map(([a, b]) => `| ${a} | ${b.replace(/\|/g, "\\|")} |`)].join("\n");
}

const BLOCK = (id: string) => new RegExp(`<!-- dsb:${id} -->\\n(?:(?!<!-- )[\\s\\S])*?<!-- /dsb -->`);

/** Rein: setzt die erzeugten Kurzfassungen in den Text von DSB-FRAGEN.md ein (fehlende Marker bleiben fehlend – Test). */
export function renderChecklistDoc(doc: string, settings: readonly ModuleSettingDecl[]): string {
  let out = doc.replace(/\r\n/g, "\n");
  for (const t of DSB_TOPICS) out = out.replace(BLOCK(t.id), `<!-- dsb:${t.id} -->\n${topicMarkdown(t, settings)}\n<!-- /dsb -->`);
  return out;
}
