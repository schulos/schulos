# SchulOS – Stunden- und Raumplanung, Statusmonitor, Schulformen

> Stand: 2026-10-03 · Status: **bestätigt** – Phase 2b vor Track B, echter Solver in 2b, alle weiterführenden
> Schulformen ohne Berufskolleg, alle 16 Länder (NRW ausgearbeitet). Aufgaben: `BACKLOG.md` P2b-01 … P2b-25
> Anlass: Vorgabe der Projektleitung nach Phase 2 – das Stundenplanmodul soll verbreiteter Stundenplan-Software nahekommen, Raumplanung
> gehört gleichrangig dazu, ein Statusmonitor für den Vertretungsplan ist Pflicht, und SchulOS soll für
> viele weiterführende Schulformen taugen.

---

## 1. Was heute da ist (Ende Phase 2)

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
| Verlegung („Stunde tauschen“ statt Entfall), Mitbetreuung, Zusammenlegung | fehlt | B |
| **Vertretungsstatistik / Mehrarbeit** je Lehrkraft (Monat, Schuljahr), Entfall je Klasse | fehlt | **A** (Grundzähler), B (Abrechnung) |
| Pausenaufsichten inkl. Vertretung offener Aufsichten | fehlt | **A** |
| Bereitschaften (Präsenz-/Vertretungsreserve) | fehlt | B |
| Vertretungstexte, „Aufgaben für die Klasse“ | Hinweis-Feld ✅ | – |

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
- **Unterrichtsverteilung (P2b-08):** Lehraufträge je Schuljahr mit Gruppe(n), Lehrkraft(en), Wochenstunden, Doppelstunden-Wunsch, Raumwunsch. „Verplant“ zählt die Stunden des Plans am Stichtag (A-/B-Woche halb); jede Stunde geht an höchstens einen Auftrag.
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
