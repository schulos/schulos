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
