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
Kooperationspartner, Teilnahmebescheinigungen. (Mittagessen, Abholung/Heimweg und externe Anbieter sind seit 2026-11-03 freigegeben, siehe „Folge (Runde 14)“ unten.) **Ausdrücklich nicht:** Klassenbucheintrag, Notenbezug, Gesundheits- oder
Allergiedaten, Fotos, Kostenabrechnung, Zugang externer Anbieter ohne Konto (bleibt ausgeschlossen).

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
9. ~~Externe Anbieter zunächst nicht als Leitung; die Schule erfasst nach Papierliste.~~ **Aufgehoben 2026-11-03 (Runde 14, gt-8):** befristete Konten der Rolle `personal` als Gruppenleitung, gebaut mit GT-13 (siehe „Umgesetzt (GT-13/GT-14)“); die Papierliste bleibt Fallback.

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


## Umgesetzt (GT-04…GT-08) – Modul fertig

Stand 2026-10-29, ohne neue Migration (Spalten und Schalter aus 0118 genügen). Damit ist der Block GT abgeschlossen; die unter
„Später, einzeln freigeben“ genannten Erweiterungen bleiben offen.

- **Abgleich mit den Abwesenheiten (GT-04, `abgleich.ts`):** Stand je Kind und Tag aus `excusedStateOn` plus noch offene Meldungen
  („gemeldet“) – Beurlaubung, „entschuldigt“ oder „gemeldet“ = `ja`, „nicht entschuldigt“ = `nein`, sonst keine Meldung. Beim Öffnen einer
  erfassbaren Liste werden Kinder mit `ja` „fehlt (entschuldigt)“ vorbelegt (Herkunft `abwesenheiten`, ohne „erfasst von“), je Angebot
  abschaltbar. „Entschuldigt?“ einer Zeile „fehlt“ kommt immer aus den Abwesenheiten (auch bei Klick der Leitung, `offen` ohne Meldung)
  und wird beim Öffnen und im Tageslauf nachgezogen (Nachmeldungen bis 14 Tage). Vorbelegungen, deren Meldung wegfällt, verschwinden;
  beim Ausfall ebenso. Vorbelegungen allein machen eine Liste nicht „erfasst“. Die Leitung kann jede Zeile ändern; leert sie eine
  vorbelegte Zeile, kommt die Vorbelegung beim nächsten Öffnen wieder, solange die Meldung gilt (eigene Festlegung).
- **Einstellungen je Angebot** (nur „Ganztag verwalten“, Karte „Einstellungen“ auf der Angebotsseite): verpflichtend (Vorgabe aus),
  Klassenleitung benachrichtigen (an), Vorbelegung aus den Abwesenheiten (an).
- **Tageshinweis an die Klassenleitung:** Job `ganztag-hinweis` (19–23 Uhr, nur bei eingeschaltetem Modul) – je Klassenleitung ein
  gebündelter Gong (`notifyBundled`, Schlüssel `ganztag-fehlen:<Datum>`) zu den **heutigen** erfassten Terminen verpflichtender Angebote
  mit „fehlt“ und nicht entschuldigt (Name, Klasse, Angebot – kein Grund); höchstens einmal je Tag, ein zweiter Lauf schickt nichts.
  Später nachgetragene Listen lösen keinen Hinweis mehr aus, stehen aber in der Übersicht der Klassenleitung. Keine Schreibverbindung
  ins Klassenbuch (Test prüft `classbook_absences`).
- **Klassenleitung** (`/ganztag/klasse`, Knopf „Meine Klasse“): Zeilen „fehlt“/„verspätet“ der Kinder der eigenen Klasse(n) in diesem
  Schuljahr mit Angebot, Pflichtangebot und „entschuldigt?“, Summen und Teilnahme je Kind; Lesezugriff protokolliert (`lesen.ganztag`).
- **Familie (GT-05):** Menüpunkt „Ganztag“ auch für Schüler:innen und Eltern (gleiche Seite `/ganztag`, Ansicht nach Rolle).
  Schüler:innen sehen ihre Angebote (nächster Termin, Ausfälle der nächsten vier Wochen) und ihre eigenen Zeilen, Eltern dasselbe je
  Kind nach `childrenOf(…, "inform")` (minderjährig bzw. eigenständig mit Einwilligung); Einsicht der Eltern protokolliert. Gelesen wird
  nur über `ganztag_marks.student_id`.
- **Auswertung (GT-06,** `/ganztag/auswertung`, „Ganztag auswerten“ oder „Ganztag verwalten“): „offen heute“ (heutige Termine ohne
  Erfassung, mit Leitung) und je Angebot und Monat des laufenden Schuljahres Termine, Ausfälle, nicht erfasst, Teilnehmertage
  (anwesend + verspätet), gefehlt (davon entschuldigt) und Quote; CSV unter `/api/ganztag/auswertung`. Die Abfragen lesen keine
  Schüler-IDs (Test prüft, dass weder IDs noch Namen vorkommen).
- **Kurswahl (GT-07):** bei der Übernahme einer Wahl der Art `ag` und eingeschaltetem Modul das Häkchen „Anwesenheitsliste (Ganztag) für
  diese Gruppen einschalten“ (Vorgabe aus) → `enableListForGroups` für die neuen bzw. ergänzten Gruppen in derselben Transaktion; das
  Recht dafür ist „Gruppen verwalten“, das die Übernahme ohnehin verlangt.
- **Datenschutz/Doku (GT-08):** VVT-Text (Empfänger Klassenleitung, Familie, Auswertung) und Hinweis zur Quelle aus den Abwesenheiten im
  Manifest, Löschtabelle unverändert (`LK-SJ`, Markierungen folgen), DATENSCHUTZ.md §3.4, DSB-FRAGEN §21 neu erzeugt (Vorgaben je
  Angebot, Fragen zu Namen im Hinweis und kleinen Gruppen). Kontolöschung: Zeilen gehen mit dem Konto der Schüler:in, der Hinweis mit dem
  Konto der Klassenleitung. Tests `src/modules/ganztag/rest.test.ts`, E2E `e2e/ganztag-rest.spec.ts`.

## Folge (Runde 14) – Abholung/Heimweg, Mittagessen, externe Anbieter

Freigegeben von der Projektleitung am 2026-11-03 (Runde 14, Fragebogen gt-1…gt-8, alle wie vorgeschlagen). Aufgaben: BACKLOG, Block
„Ganztag“, Folge GT-09…GT-14. Reihenfolge: A (Abholung) → B (Mittagessen) → C (externe Anbieter); die Runde-14-Reihenfolge insgesamt
steht im BACKLOG (zuletzt, nach den Veranstaltungs-Folgen).

- **A Abholung/Heimweg (GT-09, GT-10):** je Teilnehmende nur die *Art* der Regel (geht allein / wird abgeholt / Bus), **keine Namen
  oder Kontaktdaten Dritter** (keine Informationspflicht nach Art. 14, keine fremden Daten zu löschen). Eltern ändern den Heimweg
  tagesaktuell bis 12:00 desselben Tages (Moduleinstellung) mit Gong an die Leitung; die Leitung klickt „gegangen“, die Uhrzeit wird am
  Eintrag gespeichert und folgt dem Termin (Löschung zum Schuljahresende). Kein Ein-/Auschecken per Scan.
- **B Mittagessen (GT-11, GT-12):** Speiseplan je Woche von Hand (Menü-Nr. + Kurzbeschreibung, „Ganztag verwalten“), Anmeldung und
  Abmeldung je Tag mit Menüwahl und Frist, Zählung/Ausgabeliste für die Küche, **keine Abrechnung** (keine Zahlungsdaten). Allergien,
  Unverträglichkeiten und Kostformen werden **nicht** erfasst (Art. 9); Hinweis „Allergien direkt mit Ganztagsleitung/Küche klären“.
  CSV-Import vom Anbieter bleibt eine spätere Option.
- **C Externe Anbieter (GT-13):** befristete Konten der Rolle `personal` als Gruppenleitung (2FA, nur die eigene Gruppe, Ablauf zum
  Angebotsende, Verpflichtung zur Vertraulichkeit bei der Schule). Zugang ohne Konto bleibt ausgeschlossen, die Papierliste bleibt
  Fallback. Entscheidung 9 oben ist damit aufgehoben.
- **Datenschutz:** Fragen an die DSB stehen in DSB-FRAGEN §21 (Erweiterung Runde 14); Tabelle/Vorgaben und VVT zieht GT-14 nach.

## Umgesetzt (GT-09/GT-10) – Heimweg

Stand 2026-11-03, Migration 0135 (`ganztag_way_home_rules`, `ganztag_departures`, Enum `ganztag_way_home`).

- **Regel je Angebot und Kind** (`ganztag_way_home_rules`): nur die Art – „geht allein“, „wird abgeholt“, „fährt mit dem Bus“. Kein
  Freitext, keine Namen oder Kontaktdaten Abholberechtigter (die Datenbank kennt nur diese drei Werte). Setzen dürfen die Eltern
  minderjähriger Kinder (`childrenOf(…, "act")`), eigenständige Schüler:innen für sich selbst, die Leitung des Angebots und „Ganztag
  verwalten“ (z. B. nach dem Anmeldebogen; Karte „Heimweg“ auf der Angebotsseite). Ändert die Familie, bekommt die Leitung einen Gong.
  Minderjährige Schüler:innen sehen ihren Heimweg nur.
- **Tagesänderung je Termin** (`ganztag_departures.way`): in der Familienansicht für die Termine der nächsten 7 Tage („wie immer“ oder
  eine andere Art). Für spätere Tage jederzeit, am Tag selbst bis zur Frist `ganztag.way_home_deadline` (Vorgabe 12:00, 10–14 Uhr
  einstellbar, DSB-FRAGEN §21); danach „bitte direkt bei der Leitung melden“. Gong an die Leitung („Heimweg heute geändert: <Name>“,
  Angebot, Uhrzeit, neue Art). Leitung und „Ganztag verwalten“ können den Tag bis zum Ende des Termintags ändern (Anruf), ohne Gong.
  Bei ausgefallenen Terminen nicht.
- **Liste der Leitung (GT-10):** je Zeile „Heimweg: …“ (Regel bzw. Tagesänderung mit Hinweis „für diesen Tag geändert“) und für
  anwesende bzw. verspätete Kinder der Knopf „gegangen“ – gespeichert wird die Uhrzeit (`left_at`), erneuter Klick nimmt es zurück.
  Gleiches Erfassungsfenster wie die Liste (ab dem Termintag, Leitung bis `ganztag.edit_days`). Die Familie sieht „gegangen <Uhrzeit>“
  an den Terminen der nächsten Tage.
- **Datenschutz:** Regeln `LK-SJ` ab der letzten Änderung (zum Ende dieses Schuljahres), Tagesänderung und „gegangen“ folgen dem
  Termin; beides geht mit dem Konto der Schüler:in, „geändert von“/„vermerkt von“ werden bei der Kontolöschung geleert. Auskunft:
  Schüler:in ihre Zeilen, handelnde Personen nur Angebot bzw. Termin. Audit: „Heimweg geändert“, „Heimweg für einen Termin geändert“,
  „gegangen vermerkt/zurückgenommen“. Abholberechtigungen (wer abholen darf) klärt die Schule außerhalb von SchulOS.
- Tests: `heimweg.test.ts`, `heimweg.migration.test.ts`, E2E `e2e/ganztag-heimweg.spec.ts` (Mutter, Leitung, Lea 360 px dunkel).

## Umgesetzt (GT-11/GT-12) – Mittagessen

Stand 2026-11-03, Migration 0136 (`ganztag_menus`, `ganztag_meal_orders`).

- **Speiseplan** (`/ganztag/essen`, nur „Ganztag verwalten“ pflegt): je Tag (Mo–Fr) bis zu vier nummerierte Menüs mit Kurzbeschreibung
  (höchstens 80 Zeichen), Wochenansicht mit Vor-/Folgewoche. Hinweis im Formular: Menüs nach dem Gericht benennen, nicht nach Kostform
  oder Diät (DSB-FRAGEN §21); Allergene gehören auf den Aushang der Küche. Ein Menü mit Anmeldungen lässt sich nicht entfernen.
  `ganztag_menus` ohne Personenbezug (`NO_PERSONAL_DATA`, wer gepflegt hat, steht im Audit-Log). Demo: zwei Menüs je Schultag für zwei Wochen.
- **Anmeldung je Tag** (`ganztag_meal_orders`: Tag, Schüler:in, Menünummer): in der Familienansicht der Speiseplan der nächsten zwei
  Wochen, je Tag „nicht angemeldet“ oder „Menü n: …“. Anmelden/abmelden/ändern bis zum Anmeldeschluss `ganztag.meal_deadline` (Vorgabe am
  Werktag davor 12:00 – für Montag am Freitag; am Tag selbst 8/9 Uhr, Werktag davor 14 Uhr oder zwei Werktage vorher einstellbar). Handeln dürfen Eltern minderjähriger Kinder und
  eigenständige Schüler:innen; minderjährige Schüler:innen sehen ihre Anmeldung nur. „Ganztag verwalten“ meldet auch nach dem Schluss an
  oder ab (bis zum Tag selbst). Überall der Hinweis „Allergien und Unverträglichkeiten bitte direkt mit der Küche bzw. der
  Ganztagsleitung klären – SchulOS erfasst sie nicht.“ **Keine Abrechnung**, keine Allergien/Unverträglichkeiten/Kostformen, kein Freitext.
- **Küche (GT-12):** Zahl der Anmeldungen je Tag und Menü auf der Wochenseite (auch für „Ganztag auswerten“) und als CSV
  `/api/ganztag/essen?von=…&bis=…` (Datum, Menü, Beschreibung, Anmeldungen; höchstens drei Monate, ohne Namen); Ausgabeliste je Tag
  (`/ganztag/essen/ausgabe?datum=…`, nur „Ganztag verwalten“): Menü, Name, Klasse – sortiert nach Menü und Klasse, Einsicht protokolliert
  (`lesen.ganztag_essen`).
- **Datenschutz:** Anmeldungen `LK-SJ` ab dem Tag, gehen mit dem Konto der Schüler:in; „angemeldet von“ wird bei der Kontolöschung
  geleert; Auskunft der handelnden Person nur mit dem Tag. Tests `essen.test.ts`, `essen.migration.test.ts`, E2E `e2e/ganztag-essen.spec.ts`.

## Umgesetzt (GT-13/GT-14) – externe Leitungen, Doku

Stand 2026-11-03, Migration 0137 (`users.expires_on`, `ganztag_external_leaders`).

- **Befristetes Konto** (`/ganztag/extern`, „Ganztag verwalten“ **und** „Benutzer verwalten“; Knopf „Externe Leitungen“ auf `/ganztag`):
  Vorname, Nachname, E-Mail (freiwillig), Anbieter (Verein, Musikschule …), Angebot mit Liste, „befristet bis“ (Vorgabe: Ende der letzten
  Terminserie des Angebots, sonst Schuljahresende; höchstens ein Jahr) und das Pflicht-Häkchen „Die Person ist von der Schule
  schriftlich auf Vertraulichkeit verpflichtet“. Angelegt wird ein normales Konto der Rolle `personal` (Startpasswort, einmal angezeigt)
  als **Gruppenleitung genau dieses Angebots** – sie sieht damit nur Liste, Termine und Heimweg der eigenen Gruppe (Leitungsprüfung im
  Service). Zugang ohne Konto bleibt ausgeschlossen, die Papierliste bleibt Fallback.
- **Befristung im Kern** (`users.expires_on`, `core/permissions`): ab dem Tag nach dem Ablauf ohne Rechte (`locked`), unabhängig vom
  Tageslauf; die **2FA ist sofort Pflicht** (`twoFactorDuty(…, { temporary })`, nicht erst ab dem Stichtag der Schule). Ersteinrichtung
  wie bei allen Beschäftigten im Schulnetz oder mit Freigabe der Verwaltung.
- **Job `ganztag-extern`** (täglich, auch bei ausgeschaltetem Modul): 14 Tage vor Ablauf einmal ein Gong an die Person und an
  „Ganztag verwalten“; am Tag nach dem Ablauf Abgang = Ablaufdatum, Sitzungen beendet – gelöscht wird nach der Karenz wie jeder Abgang
  (LK-KONTO). **Verlängern** setzt ein neues Datum und nimmt einen vom Ablauf gesetzten Abgang zurück, **Zugang beenden** sperrt sofort.
- **Datenschutz:** `ganztag_external_leaders` (Anbieter, Angebot, Vertraulichkeit bestätigt am, Hinweis verschickt, angelegt von/am)
  geht mit dem Konto. Audit: angelegt, verlängert, beendet, abgelaufen. DSB-FRAGEN §21 (Tabelle aus `checkliste.ts`) beschreibt jetzt
  den gebauten Stand von Heimweg, Mittagessen und externen Leitungen.
- **Nur Ganztag (GT-15, Projektleitung 04.11.2026):** befristete Konten gelten als extern (`PermissionSet.external`, aus
  `users.expires_on`). Sie bekommen keine Grants (weder die der Rolle `personal` noch über Gruppen) und keine „group.*“-Rechte der
  Leitung; Module nur aus `EXTERNAL_MODULES` (`ganztag`). Serverseitig: `requireModulePage`/`moduleActions` (404 bzw. Forbidden),
  `apiUser` (nur `/api/ganztag/`, `/api/gong/`, `/api/profilbild/`, `/api/eigenexport`, sonst 403), Raumfinder und Druckansichten
  (`requireInternalPage`), Navigation, Startseite, Suche, Handbuch-„?“, Gong (nur `ganztag`/`verwaltung`) und Live-Strom (nur Gong).
  Konto, Passwort und 2FA bleiben offen. Ohne Migration. Tests `extern-rechte.test.ts`, E2E `e2e/ganztag-extern.spec.ts`.
- **Handbuch:** Starter-Seite „Ganztag: Heimweg, Mittagessen und externe Leitungen“ (Bereich „Ganztag“, für alle; Kontexthilfe „?“ auf
  `/ganztag`). Tests `extern.test.ts`, `extern.migration.test.ts`, E2E `e2e/ganztag-extern.spec.ts`.
