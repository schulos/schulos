# SchulOS – Stunden- und Raumplanung, Statusmonitor, Schulformen

> Stand: 2026-10 (Umbau, siehe §0) · Konzept vom 2026-10-03 · Status: **bestätigt** – Phase 2b vor Track B, echter Solver in 2b, alle weiterführenden
> Schulformen ohne Berufskolleg, alle 16 Länder (NRW ausgearbeitet). Aufgaben: `BACKLOG.md` P2b-01 … P2b-25
> Anlass: Vorgabe der Projektleitung nach Phase 2 – das Stundenplanmodul soll verbreiteter Stundenplan-Software nahekommen, Raumplanung
> gehört gleichrangig dazu, ein Statusmonitor für den Vertretungsplan ist Pflicht, und SchulOS soll für
> viele weiterführende Schulformen taugen.

---

## 0. Stand 2026-10 (nach dem Stundenplan-Umbau)

Der Umbau (Plan und Begründungen: [`STUNDENPLAN-UMBAU.md`](STUNDENPLAN-UMBAU.md), Aufgaben BACKLOG SP-01 … SP-12) hat die Planung in einen
eigenen Bereich verlegt und die automatische Planung zu einer Funktion mit Läufen ausgebaut. §1 beschreibt den alten Stand Ende Phase 2 und
bleibt als Ausgangslage stehen; die Abschnitte 2 bis 6 sind das Konzept – was davon gebaut ist, steht in BACKLOG P2b.

| Thema | Stand |
|---|---|
| **Bereich `/planung`** | Eigener Bereich „Stundenplanung“ (Navigation, nur mit `stundenplan.manage` oder `stundenplan.substitute`, sonst 404). Reiter nach Recht: Übersicht · Stundenplan · Unterrichtsverteilung · Zeitwünsche · Automatisch planen (`manage`) · Vertretungen (`substitute`) · Aufsichten. Stammdaten (Fächer, Räume, Zeitraster, Schuljahre, Ferien) und Deputate bleiben in der Verwaltung. Die alten Adressen unter `/verwaltung/…` leiten weiter |
| **Übersicht** | Kennzahlen aus den vorhandenen Diensten, je Recht getrennt: Jahresplanung (offene Lehraufträge, Diagnose, Zeitwunsch-Fenster, letzter Lauf) und Tagesgeschäft (Vertretungsbedarf, Entwürfe, unbesetzte Aufsichten, Raumsperren) |
| **Rechte** | Zwei getrennte Rechte (`manage` = Jahresplanung, `substitute` = Tagesgeschäft), vergeben über die Funktionsgruppe „Stundenplanung“ statt über eine Rolle; Schulleitung hat `substitute`. Das Sekretariat plant per Vorgabe nicht mehr (Bestandsinstallationen behalten ihren Grant, bis der Admin ihn entzieht). 2FA ist für beide Rechte sofort Pflicht. Die Gruppe darf Kurswahlen lesen (`kurswahl.view`, nur Zahlen je Angebot, nie Schüler:innen-Wünsche). Mitglieder trägt nur ein, wer beide Rechte selbst hat – auf neuen Installationen der Admin (SICHERHEIT S80) |
| **Solver-Läufe** | Jeder Lauf hat Bezeichnung, Gründlichkeit, Startwert und Gewichtung (Voreinstellungen oder eigene). Läufe kommen in eine **Warteschlange** (ein Lauf rechnet gleichzeitig, der Rest wartet), lassen sich **abbrechen** (wartend sofort, laufend mit dem bis dahin besten Stand), sind nach einem Neustart des Servers nicht verloren und werden vor dem Start auf fehlende Eingaben **geprüft** (Zeitraster, Lehraufträge, Räume). Die Detailseite zeigt Fortschritt, Vorprüfung, Protokoll, Kostenposten und „nicht gesetzt“ mit Grund je Einheit sowie eine Vorschau je Klasse oder Lehrkraft |
| **Vergleich** | 2 bis 3 fertige Läufe nebeneinander: Kennzahlen mit Bestwert und Abstand zum ersten Lauf, Parameter-Abweichungen, Vorschau |
| **Übernahme / Zurücknehmen** | Übernahme ab einem Stichtag, der ein **Schultag** sein muss (sonst Vorschlag des nächsten Schultags); vorab der Hinweis, wie viele Vertretungen entfallen. Jede übernommene Stunde merkt sich ihren Lauf. **Zurücknehmen** geht, solange der Stichtag in der Zukunft liegt – von Hand geänderte Stunden werden nie überschrieben, entfallene Vertretungen kommen zurück, sofern ihre Stunde an dem Tag wieder gilt (SP-13). Bis zum Stichtag ist ein übernommener Lauf nicht löschbar; danach leert ein Nachtjob die Rücknahme-Daten. Aufräumen: gescheiterte/abgebrochene Läufe nach 7 Tagen, je Schuljahr bleiben die neuesten 20 fertigen Läufe mit Vorschlag (Löschfrist DATENSCHUTZ §3.4) |
| **Kopplungen im Solver** | Eine Kopplung wird als Block gesetzt; **jeder Teil bekommt seinen eigenen Raum** (geteilte Klasse mit zwei Lehrkräften → zwei Räume; dieselbe Lehrkraft in mehreren Teilen → derselbe Raum) |
| **Vertretung mit Fachtausch** | Die Vertretung kann ein abweichendes Fach tragen („Mathe statt Sport“); Vorschläge bevorzugen Lehrkräfte, die die Klasse kennen, und übernehmen Lehrkraft **und** Fach mit einem Knopf. Die Anzeige in Plänen, Vertretungsplan, Druck, Monitor und Gong nennt das tatsächliche Fach, das Klassenbuch trägt es ein, die Statistik zählt „davon mit eigenem Fach“ |
| **Bänder (SP2-01)** | Unterrichtsverteilung → „Bänder“: ein Band (Schuljahr, Name, Wochen- und Doppelstunden) bündelt Lehraufträge, die zur selben Zeit liegen (Religion/Philosophie, WP, E-/G-Kurse, Oberstufen-Schiene, eine Lehrkraft für mehrere Gruppen). Jeder Lehrauftrag hat genau eine Gruppe, ein Fach und höchstens zwei Lehrkräfte; im Band übernimmt er Wochen- und Doppelstunden des Bands. Soll/verplant je Band (schwächstes Mitglied) und „zur selben Zeit“ (Slots aller Mitglieder). Das frühere „Gekoppelt mit“ ist entfallen, bestehende Kopplungen hat Migration 0100 in Bänder überführt. Lehrkräfte zählen ein Band im Deputat einmal. **Solver, Setzhilfe und Übernahme (SP2-02):** ein Band ist **eine Einheit je Wochenstunde** mit einem Teil je Lehrauftrag (bei Teamteaching je Lehrkraft) – eigenes Fach, eigene Lehrkraft, eigener Raum je Teil; Fachsperren, Zeitwünsche des Fachs und „Fach mehrfach am Tag“ gelten je Teil, fixierte Stunden zählen je Mitglied. Die Setzhilfe setzt und verschiebt ein Band als Kopplung (Raum je Teil), Übernahme und Demo-Plan vergeben eine `coupling_id` je Band-Stunde. Mitglieder mit gemeinsamen Schüler:innen dürfen parallel liegen – die Diagnose („Bänder“: zur selben Zeit, gemeinsame Schüler:innen, leere Bänder) und die Vorprüfung eines Laufs weisen darauf hin |
| **Deputat** | Neuer Anrechnungsgrund „Stundenplanung“ (Ermäßigung für das Planen selbst). **Tagesregel je Lehrkraft (SP2-04):** in der Deputats-Karte „höchstens Stunden am Tag“ und „höchstens Anwesenheitstage“ (z. B. Teilzeit, ohne Grund) – hart im Solver und in der Setzhilfe (Sperrgrund „LIN: höchstens 3 Anwesenheitstage je Woche“), bei „nicht gesetzt“ als Ursache „Tagesregel“, Vorprüfung und Diagnose-Kategorie „Tagesregeln Lehrkräfte“; die Lehrkraft sieht ihre Regel unter „Mein Deputat“ |
| **Fachverteilung (SP2-04)** | Weiche Kosten der Solver-Läufe: „Fach an Folgetagen“ (`subjectSpread`, je vermeidbarem Folgetag, an dem eine Gruppe dasselbe Fach wieder hat – unvermeidbare Folgetage bei vielen Wochenstunden zählen nicht) und „Anwesenheitstag Lehrkraft“ (`teacherDays`). Vorgabe „ausgewogen“ ohne beide (Pläne bleiben gleich), „klassenkompakt“ mit Fachverteilung, „lehrkräfteschonend“ mit Anwesenheitstagen; eigene Gewichte im Startformular |
| **Oberstufe / Zeitwünsche (SP2-05)** | Jahrgänge nur aus Kursen (Oberstufe) zählen Lücken zwischen den Kurs-Stunden des Jahrgangs als Hohlstunden (Posten „Jahrgang 12 Mo“); Tagesgrenzen gelten nur für Klassen. Diagnose-Kategorie **„Zeitwünsche“**: Unterricht in einer gesperrten Zeit (Lehrkraft, Klasse/Kurs, Raum, Fach) ist ein Fehler, in einer Zeit mit −3/−2 eine Warnung. Tauschen in der Setzhilfe prüft auch die Sperrzeiten der getauschten Stunde |
| **CSV-Import (SP2-06)** | Unterrichtsverteilung → „CSV-Import“ (`/planung/unterricht/import`, Recht `stundenplan.manage`): Lehraufträge aus einer Datei mit den Spalten Klasse/Kurs; Fach; Stunden; Lehrkraft[; Doppelstunden; Raumwunsch; Band] (Kopfzeile optional, Semikolon oder Komma, UTF-8 oder Windows-1252, Vorlage zum Herunterladen). Zuordnung über Kürzel oder Namen, zwei Lehrkräfte mit „/“. Die **Vorschau** zeigt je Zeile neu/ändern/unverändert/Fehler; übernommen wird nur eine fehlerfreie Datei, alles in einer Transaktion (Audit `stundenplan.assignment.csv_import`). Vorhandene Lehraufträge (gleiche Gruppe, gleiches Fach, eine gleiche Lehrkraft) werden geändert; Bänder werden ergänzt (vorhandenes Band – Stunden müssen passen – oder neues), nie aufgelöst. Nur Lehraufträge, keine Pläne |
| **Gültigkeit (SP2-09)** | Ein Lehrauftrag kann „gültig ab/bis“ haben (Halbjahr, Epoche; leer = ganzes Schuljahr). Die Unterrichtsverteilung zeigt den Stand an einem wählbaren **Stichtag** (Lehraufträge, die dann nicht gelten, stehen unter „Zu anderer Zeit gültig“ und zählen nirgends mit – auch nicht im Deputat oder in der Diagnose). Ein Solver-Lauf rechnet mit den Lehraufträgen am gewählten Tag („Lehraufträge am“, leer = heute); bei der Übernahme enden die Stunden mit ihrem Lehrauftrag, ein Lauf für das 2. Halbjahr lässt sich erst ab dessen Beginn übernehmen |
| **Vertretung Stufe 2 (SP2-07)** | Im Vertretungsformular zwei neue Arten: **Verlegung** – die Stunde rückt am selben Tag in eine andere Stunde (typisch: auf die ausgefallene Stunde vorziehen; „Tauschen“ legt den Unterricht der Gruppe aus der Zielstunde in diese Stunde); eine Band-/Kopplungsstunde bewegt sich mit allen Teilen. Geprüft: Gruppe, Lehrkräfte und Räume in der Zielstunde frei, Raumsperren; solange etwas in eine Stunde verlegt ist, kann dort nichts anderes stattfinden. **Zusammenlegung/Mitbetreuung** – die Gruppe geht zu einer anderen Stunde derselben Zeit, deren Lehrkraft (bzw. Vertretung) mitbetreut; die aufnehmende Stunde kann dann nicht entfallen. **Bereitschaften** (`/planung/vertretungen/bereitschaft`, Recht `stundenplan.substitute`): Vertretungsreserve je Wochentag und Stunde; wer Bereitschaft hat, steht bei den Vorschlägen oben. Vertretungen beachten die **Tagesregeln** der Lehrkräfte (SP2-04): wer mit der Vertretung darüber käme, wird nicht vorgeschlagen und nicht gespeichert. Pläne, Vertretungsplan, Druck, Monitor, Raumbelegung und Gong zeigen „Verlegung aus der 5. Std.“/„verlegt in die 1. Std.“ bzw. „Zusammenlegung mit 7a“ |
| **Dauervertretung, Wochenblick (SP2-08)** | Fehlt eine Lehrkraft mehrere Tage, bietet das Vertretungsformular „Dauervertretung: für alle Tage der Abwesenheit“ an: dieselbe Vertretung wird an jedem Tag eingetragen, an dem die Stunde in der Abwesenheit stattfindet – je Tag eine gewöhnliche Vertretung, die sich einzeln ändern oder aufheben lässt. Tage, an denen die Stunde schon geregelt ist oder die Vertretung nicht kann (selbst Unterricht, abwesend, Tagesregel), bleiben offen und werden genannt. Oben auf der Seite zeigt der **Wochenblick** die nächsten fünf Schultage mit offenen und geregelten Stunden |
| **Demo** | Login `frank.schulte` (Passwort `schulos`) gehört zur Gruppe Stundenplanung und plant unter `/planung` |

**Grenzen (kommen im Folgeblock SP2, siehe [`STUNDENPLAN-UMBAU.md`](STUNDENPLAN-UMBAU.md) §7):** keine Oberstufen-Blockung aus Kurswahlen
(Bänder werden von Hand gebildet), Verlegung nur innerhalb desselben Tages, kein Warmstart des Solvers vom aktuellen Plan, keine Exporte/Drucke/Statistiken der Planung (nur der bestehende Plandruck). Der Solver
setzt Sek I belastbar (Benchmark 7-zügig, 1 323 Einheiten, unter 1 s), Oberstufenkurse mit dichten Konflikten über mehrere Schienen können
offen bleiben – sie stehen dann mit Grund unter „nicht gesetzt“.

---

## 1. Ausgangslage (Ende Phase 2)

| Bereich | vorhanden |
|---|---|
| Stundenplan | Stunden je Gruppe (Wochentag, Stunde, Fach, **eine** Lehrkraft, **ein** Raum, A/B-Woche, Gültigkeit), Pflege mit Kollisionsprüfung, „parallel“ für geteilte Klassen, Pläne für Person/Klasse/Lehrkraft/Raum |
| Vertretung | Entfall, Vertretung, Raumänderung je Stunde und Tag, Prüfung „Lehrkraft frei“, Gong, Vertretungsplan heute/morgen |
| Raum | Raumplan, Raumänderung bei Vertretung, Buchungen mit Konfliktprüfung gegen den Stundenplan |
| Drumherum | Klassenbuch, Abwesenheiten (Schüler:innen), Klausurplan mit Regeln |

**Grundlegende Lücke, unabhängig vom Abgleich:** Es gibt **keine Oberfläche für Stammdaten** (Fächer,
Räume, Zeitraster, Schuljahre). Die Demo bekommt sie aus dem Seed. Eine **leere Produktivinstanz
(Installer!) ließe sich so nicht einrichten.** Das muss zuerst kommen.

---

## 2. Abgleich mit verbreiteter Stundenplan-Software

Bewertung: **A = für den Start nötig** · **B = bald danach** · **C = später/optional** · ✅ vorhanden

### 2.1 Planungsgrundlagen
| Übliche Funktion | Bedeutung | SchulOS | Prio |
|---|---|---|---|
| Stammdaten (Fächer, Räume, Zeitraster, Lehrkräfte, Klassen) | Basis von allem | Daten ja, **Pflege-UI fehlt** | **A** |
| **Unterrichtsverteilung / Lehrfächerverteilung** | „Klasse 7b, Deutsch, 4 Wochenstunden, BRA“ als Planungsauftrag vor dem Stundenplan; Soll gegen verplant | fehlt – Stunden werden direkt gesetzt | **A** |
| **Deputat / Wochenstunden-Konto** je Lehrkraft | Pflichtstunden, Ermäßigungen, Ist laut Plan, Über-/Unterdeckung | fehlt | **A** |
| **Kopplungen** | Mehrere Gruppen/Lehrkräfte/Räume gleichzeitig als ein Block: Religion/Philosophie, WP-Kurse, E-/G-Kurse über Klassen hinweg, Teamteaching, Sport geteilt | nur „parallel“-Häkchen, je Stunde 1 Lehrkraft/1 Raum | **A** |
| Stundentafel je Jahrgang/Schulform | Soll-Stunden je Fach | nur im Seed fest verdrahtet | **A** (als Vorlage je Schulform) |
| Doppelstunden-Regeln | min./max. Doppelstunden je Fach | Seed-Planer kennt sie, Pflege nicht | B |
| Zeitwünsche | gesperrte/ungünstige Zeiten je Lehrkraft, Klasse, Raum (z. B. „Mo frei“, Teilzeit) | fehlt | B |
| Perioden / Halbjahreswechsel | neuer Plan ab Datum, alter läuft aus | Gültigkeit je Stunde ✅, kein „Periode kopieren“ | **A** (Kopieren + Stichtag) |
| Mehrwochen-Plan | A/B-Wochen, epochaler Unterricht | A/B ✅ | C (Epochen) |
| Ferien, Feiertage, unterrichtsfreie Tage | Stunden fallen aus, Pläne zeigen „Ferien“ | **fehlt** | **A** |

### 2.2 Stundenplanerstellung
| Übliche Funktion | SchulOS | Prio |
|---|---|---|
| Manuelles Setzen im Raster mit Kollisionsanzeige | ✅ | – |
| **Setzhilfe**: beim Setzen einer Stunde aus der Unterrichtsverteilung sofort sehen, wo Lehrkraft, Klasse und Raum frei sind; Tausch/Verschieben | ✅ P2b-12 | – |
| **Diagnose**: offene Stunden der Verteilung, Hohlstunden je Lehrkraft/Klasse, Fach mehrfach am Tag, Stundentafel unter-/übererfüllt, Raum ungeeignet | fehlt | **A** |
| Automatische Optimierung (Kern solcher Software) | Seed-Planer existiert (gierig + Lückenschluss) | **A – entschieden: echter Solver in 2b** (P2b-21…23) |
| Kursplanung Oberstufe (Bänder/Blockung, Schülerwahlen) | fehlt | C (eigene Phase, eng mit Kurswahlen P4) |

### 2.3 Vertretungsplanung
| Übliche Funktion | SchulOS | Prio |
|---|---|---|
| Vertretung/Entfall/Raumänderung je Stunde | ✅ | – |
| **Abwesenheiten von Lehrkräften** (krank, Fortbildung, Klassenfahrt; ganztägig/stundenweise) → alle betroffenen Stunden erscheinen automatisch als **offen** | fehlt – heute je Stunde von Hand | **A** |
| **Abwesenheit von Klassen** (Exkursion, Praktikum, Prüfung) → Stunden entfallen, Lehrkräfte werden **frei** (Freisetzung) und können vertreten | fehlt | **A** |
| **Raumsperrung** (Renovierung, Prüfung) → betroffene Stunden brauchen Ausweichraum | fehlt | **A** |
| **Vertretungsvorschläge** mit Begründung: frei, unterrichtet die Klasse, hat das Fach, Hohl- statt Randstunde, wenig Vertretungen bisher, nicht schon 2× heute | nur „frei / hat Unterricht“ | **A** |
| Verlegung („Stunde tauschen“ statt Entfall), Mitbetreuung, Zusammenlegung | ✅ SP2-07 (Verlegung am selben Tag) | – |
| **Vertretungsstatistik / Mehrarbeit** je Lehrkraft (Monat, Schuljahr), Entfall je Klasse | fehlt | **A** (Grundzähler), B (Abrechnung) |
| Pausenaufsichten inkl. Vertretung offener Aufsichten | fehlt | **A** |
| Bereitschaften (Präsenz-/Vertretungsreserve) | ✅ SP2-07 (je Wochentag und Stunde, oben in den Vorschlägen) | – |
| Vertretungstexte, „Aufgaben für die Klasse“ | Hinweis-Feld ✅ | – |
| **Vertretung mit anderem Fach** („Mathe statt Sport“, wenn eine freie Lehrkraft die Klasse kennt) – Formularfeld „Fach“, Vorschlag „kann eigenes Fach geben“ (+10, seit SP-15 nur, wenn keine Lehrkraft mit dem ausgefallenen Fach frei ist), Anzeige in allen Plänen/Vertretungsplan/Druck/Monitor/Gong, Klassenbuch mit tatsächlichem Fach, Zähler „davon mit eigenem Fach“, Klausur-Hinweis | ✅ SP-12 | – |

### 2.4 Veröffentlichung
| Übliche Funktion | SchulOS | Prio |
|---|---|---|
| Web-Ansicht für alle | ✅ Stundenplan, Vertretungsplan, Tagesleiste, Gong | – |
| **Info-Monitor** (Bildschirm im Foyer/Lehrerzimmer) | fehlt | **A (Pflicht)** – siehe §4 |
| Druck/PDF der Pläne (Klasse, Lehrkraft, Raum, Vertretungsplan) | fehlt | **A** |
| Kalender-Abo (ICS) des persönlichen Stundenplans | fehlt (Kalender hat ICS) | B |
| Import aus fremder Stundenplan-Software / SchILD | entschieden: kein Import aus fremder Stundenplan-Software; SchILD-CSV für Schüler:innen ✅ | C (GPU-Import als Umstiegshilfe) |

---

### 2.5 Umsetzungsentscheidungen (Phase 2b)
- **Unterrichtsverteilung (P2b-08):** Lehraufträge je Schuljahr mit Gruppe(n), Lehrkraft(en), Wochenstunden, Doppelstunden-Wunsch, Raumwunsch (seit SP2-01: genau eine Gruppe, höchstens zwei Lehrkräfte; Kopplungen über Bänder). „Verplant“ zählt die Stunden des Plans am Stichtag (A-/B-Woche halb); jede Stunde geht an höchstens einen Auftrag.
- **Deputate (P2b-09):** Pflichtstunden-Vorgabe je Schulform (vereinfacht NRW), eigene Pflichtstunden je Lehrkraft, Ermäßigungen/Anrechnungen nur mit Gründen aus einer festen Liste ohne Gesundheitsbezug. Saldo = Lehraufträge − (Pflicht − Ermäßigungen).
- **Kopplungen (P2b-10):** keine Mehrfach-Spalten je Stunde, sondern Zeilen mit gemeinsamer `coupling_id`. Jede Zeile bleibt 1 Gruppe × 1 Lehrkraft × 1 Raum, damit Klassenbuch, Vertretung, Monitor und Verteilung unverändert je Zeile arbeiten. Innerhalb einer Kopplung sind geteilte Klasse, eine Lehrkraft für mehrere Gruppen (gleicher Raum) und Teamteaching erlaubt. Vertretung/Entfall/Raumänderung gilt für alle Teile derselben Lehrkraft; Lehrkraft- und Raumpläne fassen diese Teile zu einer Stunde zusammen; im Klassenbuch können Thema/Hausaufgabe in die gekoppelten Gruppen übernommen werden, Fehlzeiten führt jede Gruppe selbst. Grenze: Bei geteilten Klassen sieht jede Schülerin beide Teile (keine Zuordnung zur Teilgruppe) – kommt mit Kurswahlen. Der Solver (P2b-22) setzt eine Kopplung als Block.

## 3. Raumplanung (gleichrangig)

| Funktion | Inhalt | Prio |
|---|---|---|
| **Raumstammdaten** | Raumart (Klassenraum, NW, IF, KU, MU, Sport, Werkraum, Mensa …), Kapazität, Gebäude/Etage, Ausstattung (Beamer, digitale Tafel, Lehrerrechner, Waschbecken …), barrierefrei, aktiv | **A** |
| **Stammräume** je Klasse | Klassenraum der Klasse; Vorgabe beim Setzen | **A** |
| **Raumwünsche** je Fach | Bio → NW-Raum, Sport → Halle; beim Setzen und in der Diagnose geprüft | **A** |
| **Raumsuche** | „Welche Räume sind Mo 3. Std frei – mind. 28 Plätze, mit Beamer?“ (Stundenplan + Vertretung + Buchung) | **A** |
| **Raumvorschläge** bei Raumänderung/Raumsperrung, nach Passung sortiert (Art, Größe, Nähe) | **A** |
| **Raumbelegung** Woche/Tag als Raster aller Räume eines Gebäudes, Auslastung in % | **A** |
| Raumsperrungen | Zeitraum, Grund → Vertretungsbedarf | **A** |
| Gebäude/Standorte | mehrere Standorte, Wegezeiten (Lehrkraft wechselt Gebäude in der Pause) | B |
| Raumoptimierung (automatisch) | Fachräume bestmöglich verteilen | C |

Buchungen (P2-11) und Raumänderungen (P2-05) bleiben und nutzen dieselbe Belegungsfunktion.

---

## 4. Statusmonitor (Pflicht)

**Ziel:** ein Bildschirm im Foyer bzw. Lehrerzimmer zeigt den Vertretungsplan, läuft unbeaufsichtigt
und braucht kein Login.

| Thema | Lösung |
|---|---|
| Zugang | Die Verwaltung legt **Monitore** an (Name, Ort, Profil). Jeder bekommt eine geheime Adresse `/monitor/<token>`; der Token ist widerrufbar und wird beim Erneuern ungültig. Kein Benutzerkonto, kein Login am Gerät |
| Profile | **Foyer** (Schüler:innen): Klasse, Stunde, Fach, Art, Raum, Hinweis – Lehrkräfte nur als Kürzel · **Lehrerzimmer**: zusätzlich vertretene und vertretende Lehrkraft, offene Pausenaufsichten, Abwesenheiten (ohne Gründe) |
| Inhalt | heute + nächster Schultag, nach Klassen; automatisches Seitenblättern, wenn es nicht passt; Uhr, Datum, A/B-Woche, Schullogo; Laufband mit News, die als „auf dem Monitor zeigen“ markiert sind; „Heute: Elternsprechtag ab 15 Uhr“ aus dem Schulkalender |
| Technik | eigene Vollbild-Seite ohne App-Rahmen, große Schrift, Hell/Dunkel, Aktualisierung jede Minute, robust gegen Netzaussetzer (letzten Stand weiter zeigen + Hinweis) |
| Datenschutz | nur Kürzel und Klassen, **nie Schüler:innen-Namen**; Lehrerzimmer-Profil nur für Räume ohne Schülerzugang; Zugriffe pro Monitor im Audit-Log (letzter Abruf); Löschklasse für Monitor-Stammdaten |
| Später | Kiosk-Hinweise für Raspberry Pi/Smart-TV (Browser im Vollbild), mehrere Seiten (Vertretungsplan, Termine, Mensaplan), Monitor-Status in der Verwaltung („zuletzt gesehen vor 2 Min.“) |

---

## 5. Schulformen weiterführender Schulen

SchulOS ist heute stillschweigend „Gesamtschule NRW“. Künftig wird die Schule einmal eingerichtet
(im Installer, änderbar in der Verwaltung):

| Einstellung | Wirkung |
|---|---|
| **Bundesland** | Feiertage (berechnet), Ferien (Datensatz je Land/Jahr, von der Verwaltung prüf-/ergänzbar), **Löschfristen-Profil** (NRW = VO-DV I; andere Länder: Profil mit Hinweis „durch DSB prüfen“), Begriffe |
| **Schulform** | Vorlagen für Jahrgänge, Gruppenarten, Stundentafel und Zeitraster – alles nur Vorbelegung, frei änderbar |

**Vorgesehene Schulformen**

| Schulform | Jahrgänge | Besonderheiten für SchulOS |
|---|---|---|
| Gymnasium | 5–10 (G9) bzw. 5–9 (G8) + Oberstufe | Oberstufe als Kurssystem (GK/LK), Stufenleitung statt Klassenleitung in der Oberstufe |
| Realschule | 5–10 | Wahlpflichtkurse ab 7 |
| Hauptschule | 5–10 | Klassenlehrerprinzip, 10A/10B |
| Gesamtschule | 5–10 + Oberstufe | **Fachleistungsdifferenzierung (E-/G-Kurse)** klassenübergreifend, WP-Kurse |
| Sekundarschule / Gemeinschaftsschule / Oberschule / Stadtteilschule / Integrierte Sekundarschule | 5–10 (teils mit Oberstufe) | wie Gesamtschule, Landesbegriffe |
| Förderschule (Sek I) | 5–10 | kleine Lerngruppen, Doppelbesetzung (Teamteaching) häufig |
| Berufskolleg / berufsbildende Schule | Bildungsgänge statt Jahrgänge | Teilzeit-/Blockunterricht, Ausbildungsbetriebe, Lernfelder – **eigene, größere Ausbaustufe (C)** |

**Was dafür im Kern nötig ist (A):**
1. **Jahrgangsstufen als Stammdaten** statt fest 5–13: Name/Kürzel (z. B. „EF“, „Q1“, „11“, „E1“), Reihenfolge, Stufenart (Sek I / Oberstufe).
2. **Gruppenarten erweitern**: Klasse, Kurs mit **Niveau** (E/G, GK/LK, A/B/C), Wahlpflichtkurs, Förderkurs, AG – plus **Leitungsbezeichnung** je Art (Klassenleitung, Stufenleitung, Tutor:in).
3. **Stundentafel- und Zeitraster-Vorlagen** je Schulform/Land als Daten (nicht Code); Demo-Seed nutzt dieselben Vorlagen.
4. **Begriffe zentral** (z. B. „Klassenarbeit“ vs. „Klausur“ in der Oberstufe, „Klassenbuch“ vs. „Kursbuch“).
5. Ferien/Feiertage je Land (gehört auch zur Stundenplanung, §2.1).

---

## 6. Vorschlag: Phase 2b vor Track B

Begründung: Stammdaten, Schulform und Ferien braucht auch die leere Produktivinstanz aus dem
Installer – Track B setzt darauf auf. Reihenfolge so, dass jeder Block für sich nutzbar ist.

| Block | Aufgaben (Vorschlag) |
|---|---|
| **S1 Fundament** | Schulprofil (Bundesland, Schulform) · Jahrgangsstufen + Gruppenarten/Niveaus · Stammdaten-UI: Fächer, Räume (Art, Kapazität, Ausstattung, Gebäude), Zeitraster, Schuljahre/Halbjahre · Ferien + Feiertage (Pläne berücksichtigen sie) · Vorlagen je Schulform (Stundentafel, Zeitraster) |
| **S2 Planungsgrundlagen** | Unterrichtsverteilung (Klasse × Fach × Stunden × Lehrkraft(en)) · Deputate/Ermäßigungen + Konten · Kopplungen (mehrere Lehrkräfte/Räume/Gruppen je Stunde) · Stammräume + Raumwünsche je Fach |
| **S3 Planen** | Setzhilfe aus der Unterrichtsverteilung (Freiraster für Lehrkraft/Klasse/Raum) · Diagnose · Periode kopieren (Halbjahreswechsel) · Druck/PDF der Pläne |
| **S4 Raumplanung** | Raumsuche mit Filtern · Belegungsraster aller Räume + Auslastung · Raumsperrungen · Raumvorschläge |
| **S5 Vertretung Pro** | Abwesenheiten Lehrkräfte/Klassen → offene Stunden + Freisetzungen · Vertretungsvorschläge mit Begründung · Pausenaufsichten · Vertretungsstatistik |
| **S6 Statusmonitor** | Monitore mit Token, Profile Foyer/Lehrerzimmer, Seitenblättern, Laufband, Kiosk-tauglich |
| **S7 Abschluss** | Demo-Seed auf neue Strukturen (Gesamtschule + zweites Profil, z. B. Gymnasium, als Test), E2E-Szenario, **GATE 2b** |

**Bewusst später (B/C):** Oberstufen-Blockung,
Verlegungen/Zusammenlegungen, Bereitschaften, Mehrarbeits-Abrechnung, Gebäude-Wegezeiten,
Epochenunterricht, Berufskolleg, GPU-Import (Austauschformat verbreiteter Stundenplan-Software).
