# Ganztag – Anwesenheitslisten (Modul `ganztag`)

Freigegeben von der Projektleitung am 2026-10-28 (Fragebogen Runde 11). Aufgaben: `docs/BACKLOG.md`, Block „Ganztag“
(GT-01 ff.). Dieses Dokument hält Umfang, Datenmodell grob, Rechte, Datenschutz und Entscheidungen fest.

## Ziel

Anwesenheit in Ganztags- und AG-Angeboten erfassen. Die Wahl der AGs läuft bereits über die Kurswahl. Die Leitung sieht,
wer da sein müsste (Aufsicht), die Klassenleitung erfährt von unentschuldigtem Fehlen in verpflichtenden Angeboten, Eltern
sehen Teilnahme und Fehlzeiten ihres Kindes, die Verwaltung bekommt Auswertungen ohne Namen.

## Umfang

- **Anwesenheitsliste je Termin** für Gruppen mit eingeschaltetem Gruppenmerkmal `ganztag.liste` (Arten `ag`, `foerderkurs`,
  `frei`; Klassen und Fachkurse nicht). Klick anwesend / fehlt / verspätet. Listen starten leer; „alle anwesend“ ist ein
  Schalter in der Liste.
- **Termine:** eigene Serien je Gruppe (Wochentag und Zeit, Schuljahr) und Einzeltermine; Ferien und Schulfrei werden
  übersprungen; Ausfall markieren löst einen Gong an Teilnehmende und Eltern aus.
- **Abgleich mit Abwesenheiten:** liegt eine Krankmeldung oder Beurlaubung vor, wird „entschuldigt“ vorbelegt (nur die Quelle,
  nie der Grund).
- **Klassenleitung:** gebündelter Tageshinweis bei unentschuldigtem Fehlen in verpflichtenden Angeboten. Die Übernahme ins
  Klassenbuch bleibt Sache der Klassenleitung; es gibt keine Schreibverbindung dorthin.
- **Ansichten:** Leitung (eigene Gruppen), Klassenleitung (ihre Klasse), Eltern/Schüler:innen (eigene Zeilen), Verwaltung
  („offen heute“, Auswertung als CSV ohne Namen).
- **Kurswahl:** Häkchen bei der Übernahme einer Wahl der Art `ag`, das die Liste für die entstehenden Gruppen einschaltet.

**Später, einzeln freigeben:** Mittagessen, Abholung und Heimweg, Wartelisten, Ein-/Auschecken per Scan, Raumzuordnung,
Kooperationspartner, Teilnahmebescheinigungen. **Ausdrücklich nicht:** Klassenbucheintrag, Notenbezug, Gesundheits- oder
Allergiedaten, Fotos, Kostenabrechnung, Zugang externer Anbieter ohne Konto.

## Datenmodell (grob)

Präfix `ganztag_`: `ganztag_series` (Gruppe, Wochentag, Zeit, gültig von/bis), `ganztag_sessions` (Gruppe, Datum, Zeit, Status
geplant/ausgefallen/erfasst), `ganztag_marks` (Termin, Schüler:in, Status, Minuten verspätet, entschuldigt ja/nein/offen,
Quelle), `ganztag_group_settings` (verpflichtend, Klassenleitung benachrichtigen, Vorbelegung).

## Rechte

`ganztag.manage` (Angebote und Termine für alle Gruppen, alle Listen lesen; Vorgabe Verwaltung), `ganztag.view_all`
(Auswertung; Vorgabe Schulleitung/Verwaltung). Die Leitung einer Gruppe erfasst und liest nur die eigenen Listen (im Service
geprüft). Klassenleitung liest die Zeilen ihrer Klasse. Eltern minderjähriger Kinder und volljährige Schüler:innen sehen
nur die eigenen Zeilen, nach den Regeln der Abwesenheiten. Schüler:innen sehen nicht, wer sonst fehlt.

## Datenschutz

Personenbezug: Schüler:in, Teilnahmestatus, Zeit. Keine Gründe, kein Freitext zu Krankheit. Löschklasse `LK-SJ`
(Schuljahresende) für Termine; die Markierungen folgen den Terminen. Serien und Gruppeneinstellungen haben keinen
Personenbezug. Verarbeitungszweck: Aufsicht und Organisation im Ganztag. Rechtsgrundlage und die Frage, ob Fehlen im Ganztag
als Schulversäumnis zählt, sind schulform- und länderabhängig: zu prüfen. Moduleinstellungen werden je einem Thema der
Datenschutz-Checkliste zugeordnet.

## Entscheidungen (Projektleitung 2026-10-28)

1. Eigenes Modul `ganztag`.
2. Listen nur für Gruppen mit eingeschaltetem Merkmal.
3. Verpflichtende Angebote: gebündelter Hinweis an die Klassenleitung, keine Schreibverbindung ins Klassenbuch.
4. Sichtbarkeit: Leitung eigene Gruppen, Klassenleitung ihre Klasse, Familie nur das eigene Kind, Verwaltung Auswertung ohne Namen.
5. Listen starten leer, „alle anwesend“ als Schalter.
6. Löschklasse `LK-SJ`.
7. Eigene Terminserien je Gruppe.
8. Mittagessen, Abholung und Heimweg später, einzeln.
9. Externe Anbieter zunächst nicht als Leitung; die Schule erfasst nach Papierliste.

## Umgesetzt (GT-01…GT-03)

Stand 2026-10-28, Migration 0118 (`ganztag_series`, `ganztag_sessions`, `ganztag_marks`, `ganztag_group_settings`, Enums
`ganztag_session_status`, `ganztag_mark_status`, `ganztag_excused`, `ganztag_mark_source`).

- **Modul `ganztag`** (Menü „Ganztag“, Bereich Organisation, für Personal; neue Installationen eingeschaltet, nach einem Update wie jedes
  neue Modul zunächst aus). Rechte `ganztag.manage` („Ganztag verwalten“: Merkmal schalten, Termine und Listen aller Angebote, Nachtrag
  ohne Frist) und `ganztag.view_all` („Ganztag auswerten“, für GT-06; Vorgabe Verwaltung, in der Demo auch die Schulleitung). Die
  **Leitung** ist die Gruppenleitung (`group_members.role = leader`) – sie pflegt Termine und Listen nur ihrer Gruppen (im Service geprüft,
  kein eigenes Recht).
- **Gruppenmerkmal `ganztag.liste`** nur für AG, Förderkurs und frei: neue Manifest-Angabe `groupFeatureRules` (Gruppenarten,
  `manageOnly`). Die Gruppenverwaltung bietet das Merkmal nur passenden Gruppen an, der Kursraum gar nicht; eigene Seite
  `/ganztag/angebote` mit Schalter je Gruppe. Ausschalten blendet die Liste aus, Daten bleiben bis zur Löschfrist.
- **Termine** (`/ganztag/gruppe/<id>`): wöchentliche Serie (Mo–Fr, Beginn/Ende, gültig von/bis, höchstens ein Jahr, Vorgabe: Schuljahr ab
  heute); Ferien, Feiertage und unterrichtsfreie Tage aus dem Schulkalender (`SchoolCalendar.dayOff`) werden übersprungen und gemeldet.
  Einzeltermine sind an jedem Tag möglich (z. B. Ausflug). Je Gruppe, Tag und Beginn höchstens ein Termin. Serie löschen entfernt die
  noch nicht erfassten Termine, erfasste bleiben als Einzeltermine.
- **Ausfall**: nur ohne Erfassung; bei heutigen und künftigen Terminen ein Gong „<Angebot> fällt aus“ (Datum, Zeit – ohne Grund) an die
  Teilnehmenden und ihre Eltern (minderjährig bzw. mit Einwilligung informiert, `guardianRecipients`); Zurücknehmen schickt „findet doch
  statt“. Vergangene Termine lassen sich ohne Gong als ausgefallen vermerken.
- **Liste** (`/ganztag/termin/<id>`): Teilnehmende = Mitglieder der Gruppe mit Rolle Schüler:in (plus frühere Mitglieder mit Markierung).
  Startet leer; je Zeile anwesend / fehlt / verspätet (Minuten wählbar), erneuter Klick leert. „Alle anwesend“ ist ein Schalter: an setzt
  alle Zeilen ohne Markierung auf anwesend (Herkunft `alle_anwesend`), aus nimmt genau diese zurück – von Hand gesetzte bleiben. Erfassen
  frühestens am Tag des Termins; die Leitung bis `ganztag.edit_days` Tage danach (Vorgabe 7; 0/3/7/14/30), „Ganztag verwalten“ auch
  später. Erfasste Termine löscht nur „Ganztag verwalten“.
- **Datenschutz:** `ganztag_sessions` `LK-SJ` ab Datum, `ganztag_marks` folgen dem Termin (und gehen mit dem Konto der Schüler:in),
  Serien und Gruppeneinstellungen ohne Personenbezug (`NO_PERSONAL_DATA`). Auskunft: Schüler:in ihre Zeilen; Leitung nur die Handlung
  (Termin, Zeitpunkt – ohne Schüler:in und Status). Kontolöschung der Leitung leert „erfasst von“. DSB-FRAGEN §21, Zeile in
  DATENSCHUTZ.md §3.4.

**Andockpunkte:** GT-04 → `ganztag_marks.excused`/`source = 'abwesenheiten'` beim Öffnen bzw. Erfassen aus `excusedStateOn` vorbelegen
(nur die Quelle), Schalter in `ganztag_group_settings` (`mandatory`, `notify_class_lead`, `prefill_absences`) liegen schon an;
Tageshinweis als Job mit `notifyBundled`. GT-05 → Lesefunktion „eigene Zeilen“ über `ganztag_marks_student_idx`, Regeln aus
`core/school/majority.ts`, Navigation für Eltern/Schüler:innen ergänzen. GT-06 → `ganztag.view_all`, Zählung je Angebot und Monat aus
`ganztag_marks`/`ganztag_sessions` ohne Namen; „offen heute“ wie `listOffers().open`. GT-07 → in der Kurswahl-Übernahme für Wahlen der
Art `ag` `setListFeature` (bzw. `setGroupFeature` + `ganztag_group_settings`) für die neuen Gruppen aufrufen. GT-08 → Löschtabelle,
VVT-Text, E2E für Familie/Klassenleitung.

