# SchulOS – Konzept für den Produktivbetrieb (DSGVO, Löschkonzept)

> Stand: 2026-10-03 · Status: **Konzept, von der Projektleitung noch nicht bestätigt** · Bezug: NRW-Schulrecht.
> Das ist kein Rechtsgutachten. Vor einem echten Einsatz prüfen das die oder der
> Datenschutzbeauftragte der Schule (beim Schulamt bestellt) und die Schulleitung.
> Verantwortliche nach DSGVO ist die Schule, die SchulOS betreibt; SchulOS liefert Vorgaben und Vorlagen ohne Gewähr
> (AGPL-3.0, §§ 15–16). Datenschutzhinweise und VVT sind als „Vorlage – von der Schule zu prüfen und anzupassen“ gekennzeichnet (DS-14).

---

## 1. Die ehrliche Ausgangslage

SchulOS ist als Lernprojekt gestartet. Für den Produktivbetrieb fehlt **kein einzelnes
Feature**, sondern drei Dinge auf einmal:

1. **Technik:** Löschfristen, Auskunft, Protokollierung, Härtung. Das lässt sich bauen
   (siehe §4 bis §6), und der modulare Aufbau hilft dabei sehr.
2. **Organisation:** Die Schule ist die Verantwortliche. Sie braucht ein Verzeichnis der
   Verarbeitungstätigkeiten, eine Datenschutz-Folgenabschätzung, eine Dienstanweisung und
   eine Nutzungsordnung. SchulOS kann die Vorlagen liefern und große Teile davon **aus den
   Modul-Manifesten erzeugen**.
3. **Betrieb und Verantwortung:** Wer spielt nachts Sicherheitsupdates ein, wer haftet, wer
   übernimmt, wenn der eine Entwickler ausfällt? Das ist das eigentliche Hindernis. In NRW
   gibt es mit LOGINEO NRW außerdem eine kostenlose Landeslösung, an der sich jede
   Alternative messen lassen muss.

**Folgerung:** SchulOS wird in Stufen betriebsreif, nicht auf einen Schlag.

| Stufe | Einsatz | Voraussetzungen |
|---|---|---|
| **0 – Demo** (heute) | nur fiktive Daten | – |
| **1 – Pilot** | eine Klasse, AG oder Fachschaft mit echten, aber wenigen Personen; Schule weiß Bescheid | Datenschutz-Kern (§4), Härtung (§6), Backup, VVT-/DSFA-Entwurf, schriftliche Freigabe der Schulleitung |
| **2 – Schulbetrieb** | ganze Schule | zusätzlich: Pentest bzw. externes Review, Betriebshandbuch, Auftragsverarbeitungsvertrag mit dem Betreiber, vereinbarte Update-/Reaktionszeiten, zweite Person mit Betriebswissen, Beteiligung des Lehrerrats bzw. Personalrats |

---

## 2. Rechtsrahmen (NRW, Kurzfassung)

| Thema | Regel | Konsequenz für SchulOS |
|---|---|---|
| Rechtsgrundlage | § 120 Abs. 5 und § 121 Abs. 1 SchulG NRW: Verarbeitung, soweit für die Aufgaben der Schule **erforderlich** | Keine Einwilligung für den Kernbetrieb nötig (wäre im Schulverhältnis auch nicht freiwillig). Dafür gilt strenge **Erforderlichkeit**: nur Felder anlegen, die eine Aufgabe wirklich braucht |
| Zugelassene Daten | VO-DV I (Schüler:innen, Eltern) und VO-DV II (Lehrkräfte) zählen abschließend auf, welche Daten verarbeitet werden dürfen | Jedes Datenfeld muss sich einer Kategorie der Verordnung zuordnen lassen. Freitextfelder sind dabei das größte Risiko |
| Einwilligung | nur für Ausnahmen, z. B. Fotos/Video (§ 120 Abs. 6 SchulG) | Profilbilder nur freiwillig und nur mit Einwilligung; standardmäßig Initialen |
| Aufbewahrung | § 9 VO-DV I: Klassen- und Kursbücher **10 Jahre**, übrige Daten **5 Jahre**, Daten auf privaten Endgeräten **1 Jahr**. Die Frist beginnt mit Ablauf des Kalenderjahres, in dem die Akte abgeschlossen wurde. Danach dem Archiv anbieten oder löschen | Siehe Löschkonzept §3. Wichtig: Die Fristen sind **Höchstfristen** für Akten. Kommunikationsdaten (Chat, Gong) sind keine Akten und werden viel früher gelöscht |
| Private Endgeräte | § 2 VO-DV I: Verarbeitung auf Privatgeräten nur mit schriftlicher Genehmigung der Schulleitung | Lehrkräfte nutzen SchulOS im Browser. Downloads bleiben möglich, aber Exporte sensibler Daten (Klassenbuch, Fehlzeiten) werden protokolliert und sind abschaltbar |
| DSGVO | Art. 5 (Grundsätze), 13/14 (Informationspflicht), 15–21 (Betroffenenrechte), 25 (Privacy by Design), 28 (Auftragsverarbeitung), 30 (VVT), 32 (TOMs), 33/34 (Datenpanne), 35 (DSFA) | §4–§7 |
| Gesundheitsdaten | Art. 9 DSGVO: besondere Kategorie | **Betrifft Phase 2 direkt:** Abwesenheiten speichern nur „krank“ bzw. „sonstiger Grund“, nie eine Diagnose. Den Grund sehen nur die Personen der Sichtbarkeitsliste in §5 („Krankmeldungen und Beurlaubungen“) |

**Rechtsgrundlage in SchulOS (geprüft 2026-10-04, nur NRW):** Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO
i. V. m. § 120 Abs. 1 und 5, § 121 Abs. 1, § 8 Abs. 2 SchulG NRW sowie VO-DV I/II. § 120 Abs. 5 und
§ 121 Abs. 1 Satz 2 erlauben ausdrücklich „Lehr- und Lernsysteme und Arbeits- und
Kommunikationsplattformen“ (§ 8 Abs. 2) und verpflichten Schüler:innen bzw. Lehrkräfte zur Nutzung.
**§ 122 Abs. 1 Satz 2 SchulG NRW** stellt ausdrücklich klar, dass § 120 und § 121 auf Art. 6 Abs. 1 lit. e, Abs. 3 und
**Art. 9 Abs. 2 lit. g** DSGVO beruhen (DS-17, Vorprüfung `B05-KRANKMELDUNG.md`). Krankmeldungen damit zusätzlich nach
Art. 9 Abs. 2 lit. g DSGVO i. V. m. § 120 Abs. 1, § 122 Abs. 1 Satz 2 und § 43 Abs. 2 SchulG NRW sowie VO-DV I Anlage 1
Abschn. A Nr. II Ziff. 19.1 („Schulversäumnis: Beginn, Ende, Grund“ – ohne Sperrvermerk; gesperrt sind nur Atteste und
medizinische Gutachten, die SchulOS nicht annimmt), Klassenbuch Anlage 2 I Nr. 1, Schülerakte Anlage 2 II Nr. 1.
Beurlaubung: § 43 **Abs. 4** SchulG NRW, VO-DV I Anlage 1 Abschn. A Nr. II Ziff. 18. Bestätigung der Lesart und
Eintrag ins VVT durch die DSB offen (DSB-FRAGEN §1). **Andere Bundesländer: nicht
geprüft** – SchulOS warnt in Datenschutzhinweisen und VVT, solange das Bundesland nicht NRW ist.
Quellen: SchulG NRW (BASS 10-41 Nr. 1, Stand 21.07.2026), VO-DV I (BASS 10-44 Nr. 2.1).

Eine eigene **Anlage zu digitalen Systemen gibt es in der VO-DV I nicht** (nur Anlagen 1–3, Wortlaut geprüft
12.10.2026); für Lern- und Kommunikationsplattformen gelten § 120 Abs. 5 SchulG NRW und § 2 VO-DV I.
**Vor dem Pilot gegen die aktuelle BASS-Fassung prüfen:** Datenfelder je Modul gegen Anlage 1/2 der VO-DV I und die
Dienstanweisung für die automatisierte Verarbeitung (BASS 10-41 Nr. 4).

---

## 3. Löschkonzept (Baustein SchulOS, Gliederung nach DIN 66398)

> Das Löschkonzept gehört der **Schule** und umfasst auch SchILD-NRW, Papierakten, E-Mail und
> private Geräte. Dieser Abschnitt ist der Teil für SchulOS. Er lässt sich später aus den
> Modul-Manifesten erzeugen (DS-07) und in das Gesamtkonzept der Schule übernehmen.

### 3.1 Geltungsbereich und Verantwortung

- **Erfasst:** alle personenbezogenen Daten im SchulOS-Hauptsystem (Datenbank und Dateispeicher),
  in den Backups auf dem Backupserver samt Offsite-Kopie und in Exporten, die SchulOS erzeugt.
- **Nicht erfasst:** SchILD-NRW, Papierakten, E-Mail-Postfächer und private Geräte. Die regelt
  das Gesamtkonzept der Schule.
- **Abgrenzung:** SchulOS ist **nicht das führende Verwaltungssystem**. Schülerstammblatt (20 Jahre),
  Zeugnisse (50 Jahre) und Abschlüsse bleiben in SchILD. SchulOS hält nur, was der Schulalltag
  braucht, und löscht früh.
- **Verantwortlich:** die Schulleitung (Gesamtverantwortung). Technisch setzt der Betreiber um,
  also Schule oder Schulträger. Die oder der Datenschutzbeauftragte berät und gibt frei.

### 3.2 Rechtsgrundlagen und Lesart der Fristen

- Art. 5 Abs. 1 e, Art. 5 Abs. 2, Art. 17, Art. 30 Abs. 1 f DSGVO; § 9 VO-DV I und II; § 9 Abs. 3 VO-DV I
  (erst dem Archiv anbieten, dann vernichten).
- **Lesart:** Für **Akten** (in SchulOS nur das Klassenbuch samt Fehlzeiten) ist § 9 eine
  **Aufbewahrungspflicht**. Für **alle anderen Daten** gilt die Erforderlichkeit: Sie werden
  gelöscht, sobald der Zweck entfällt. Die 5 Jahre aus § 9 Abs. 1 sind dafür nur die
  äußerste Grenze und werden in SchulOS nie erreicht.
- **Ausnahme Entschuldigungen** (DS-17, `B05-KRANKMELDUNG.md` §4): Nach BASS 12-51 Nr. 5 Nr. 3 gehören schriftliche
  Entschuldigungen zur Schülerakte und sind „übrige Daten“ nach § 9 Abs. 1 Nr. 4 VO-DV I – **5 Jahre**. Ersetzt die digitale
  Meldung die schriftliche Entschuldigung, gilt das auch für sie. Umsetzung (**DS-16**): Moduleinstellung „Digitale Meldung gilt
  als schriftliche Entschuldigung“ (Vorgabe ja) → die Meldungen der Klasse gehen als eigener Teil „Entschuldigungen“
  (`entschuldigungen.json/.html`, nicht in der Klassenbuch-Ansicht) in den Archivexport, mit eigenem frühesten
  Vernichtungsdatum (31.12. des Abschlussjahres + 5 Jahre, frühestens nach Ende der Schulpflicht); jede Meldung merkt sich den
  Export, der sie enthält (G4D-S01), und bleibt im System, bis **genau dieser** Export als übergeben bestätigt ist – danach
  greift LK-SJ. Ohne Übergabe gibt es keine Höchstfrist (Aufbewahrungspflicht, Art. 17 Abs. 3 lit. b DSGVO); die
  Löschvorschau zählt solche Meldungen als „zurückgehalten“ mit dem Hinweis auf den fehlenden Archivexport. Mit „nein“ bittet SchulOS die Eltern im
  Meldeformular, zusätzlich schriftlich zu entschuldigen, und löscht wie bisher zum Schuljahresende.
- **Beginn der Aktenfristen** (§ 9 VO-DV I): mit **Ablauf des Kalenderjahres**, in dem die Akte
  abgeschlossen wurde, **frühestens** mit Ablauf des Kalenderjahres, in dem die Schulpflicht der
  betroffenen Person endet. Für Schulfristen nutzt SchulOS das **Schuljahresende (31.07.)**.

### 3.3 Löschklassen

Jede Datenart wird genau einer Löschklasse zugeordnet. Im Code sind die Klassen zentral
definiert, und die Module verweisen im Manifest darauf (P2-00).

| Klasse | Startzeitpunkt | Regelfrist | einstellbar bis |
|---|---|---|---|
| **LK-SESSION** | Ablauf der Sitzung | sofort | – |
| **LK-90** | Erstellung | 90 Tage | 1 Jahr |
| **LK-KONTO** | Kontoende (Abgang/Ausscheiden, bei Eltern: Kontoende des letzten Kindes) | Sperre sofort, Löschung nach 90 Tagen | 1 Jahr |
| **LK-1J** | Erstellung | 1 Jahr | 2 Jahre |
| **LK-ENDE-1J** | Ende des Objekts (Ablaufdatum, Archivierung der Gruppe) | 1 Jahr | 2 Jahre |
| **LK-TERMIN** | Terminende | 2 Jahre | 3 Jahre |
| **LK-SJ** | Ende des Schuljahres, in dem das Objekt entstand | zum Schuljahresende | 1 Jahr |
| **LK-SJ-1J** | Ende des Schuljahres, in dem das Objekt entstand | Schuljahresende + 1 Jahr | Schuljahresende + 2 Jahre |
| **LK-AKTE** | Abschluss des Schuljahres | Archivexport, danach im Live-System wie LK-SJ-1J | – (die 10 Jahre laufen im Archiv, §3.6) |
| **LK-BACKUP** | Erstellung der Sicherung | gestaffelt 14 täglich / 4 wöchentlich / 3 monatlich | mit Warnung länger |

Die Fristen sind Vorschläge. Die Verwaltung kann sie je Schule ändern, aber nur bis zur Grenze
der Spalte „einstellbar bis“ – umgesetzt je Datenart als Moduleinstellung (DS-15, Liste in §3.9).

### 3.4 Datenarten und Zuordnung

| Datenart | Klasse | Begründung |
|---|---|---|
| Konto Schüler:in, Eltern, Lehrkraft/Personal (Stammdaten im Konto, Gruppenmitgliedschaften) | LK-KONTO | 90 Tage Karenz für Rückfragen und den Eigenexport; Elternkonten haben ohne Kind keinen Zweck |
| Persönliche Dateien | LK-KONTO | gehören zum Konto |
| Sitzungen (gekürzte IP, Browser, letzte Aktivität – P4-71) | LK-SESSION | Datenminimierung |
| Code-Listen für die Zwei-Faktor-Anmeldung (nur HMAC unbenutzter Codes, erzeugt von/am – SEC-02) | mit dem Konto (`follows users`); neue Liste bzw. Zurücksetzen ersetzt/löscht | Datenminimierung |
| Sicherheitsschlüssel/Passkeys (öffentlicher Schlüssel, Kennung, Name, angelegt/zuletzt benutzt – SEC-03) | mit dem Konto (`follows users`); Entfernen bzw. Zurücksetzen löscht | kein Geheimnis gespeichert, nur der öffentliche Teil |
| Gong (Benachrichtigungen) | LK-90 | reine Hinweise |
| Messenger-Nachrichten, Lesestatus | LK-1J | Kommunikation, keine Akte; Schule kann für Schüler:innen-Direktchats verkürzen |
| Audit-Log | LK-1J, danach pseudonymisiert statt gelöscht | Nachweis der Rechtmäßigkeit, keine Verhaltenskontrolle |
| News | LK-ENDE-1J | – |
| Gruppenordner | LK-ENDE-1J (ab Archivierung der Gruppe) | Material vorher ins Folgejahr kopierbar |
| Kalendertermine | LK-TERMIN | Jahresplanung des Folgejahres (einstellbar 1–3 Jahre, DS-15) |
| Kalender-Abo-Links *(Q5-15)* | LK-1J ab „zuletzt genutzt“ | Link nur als Hash, Widerruf/Kontolöschung sofort; Abrufe werden nicht protokolliert. Die Termine gehen an die Kalender-App (ggf. deren Anbieter) – Entscheidung der Person, Hinweis auf der Seite und in DSB-FRAGEN §14 |
| Aufgaben, Abgaben, Feedback | LK-SJ-1J | Bewertung bleibt im Folgejahr nachvollziehbar; Noten stehen in SchILD |
| Elternbriefe + Rückmeldungen *(P2)* | LK-SJ-1J | Nachweis „Brief erhalten“ |
| Abwesenheitsmeldungen *(P2)* | LK-SJ – mit Einstellung „gilt als schriftliche Entschuldigung“ (Vorgabe) erst nach Übergabe des Archivexports, der die Meldung enthält (DS-16, G4D-S01); bis dahin „zurückgehalten“ in der Löschvorschau | Gesundheitsdaten (Art. 9) so kurz wie möglich; das Ergebnis „entschuldigt“ steht im Klassenbuch; als Entschuldigung Teil der Schülerakte (Archivexport „Entschuldigungen“, 5 Jahre) |
| Klassenbuch, Fehlzeiten *(P2)* | LK-AKTE | Aktenpflicht 10 Jahre (§ 9 VO-DV I), erfüllt über den Archivexport |
| Stundenplan, Vertretungen (inkl. abweichendem Fach der Vertretung, SP-12 – kein eigener Personenbezug, folgt der Vertretung), Unterrichtsverteilung mit Bändern (SP2-01 – Band: Name und Stunden, kein Personenbezug; SP2-02 – Band-Stunden sind Kopplungen im Plan, keine neuen Daten), Buchungen, Klausurplan *(P2)* | LK-SJ-1J | Planungsdaten mit Personenbezug (Lehrkraft) |
| Solver-Läufe (Planvorschlag, Parameter, Kennzahlen, Protokoll, Rücknahme-Daten) *(P2b, SP-06, SP-09, SP-13, SP-14)* | LK-90 ab Anlage; dazu Nachtjob: fehlgeschlagen/abgebrochen ohne Ergebnis nach 7 Tagen weg, je Schuljahr nur die neuesten 20 fertigen Läufe mit Vorschlag; **Rücknahme-Daten** (`undo`) nur bis zum Stichtag der Übernahme – der Nachtjob leert sie ab dem Stichtag, das Zurücknehmen sofort | Planung: Entwürfe ohne Außenwirkung, nur mit `stundenplan.manage`; Protokoll und Kennzahlen enthalten dieselben Kürzel/Gruppen wie der Vorschlag, keine weiteren Datenarten; „Gestartet von“/„Übernommen von“ = Konto der Planung; Herkunft `solver_run_id` an übernommenen Stunden fällt mit dem Lauf weg, die Stunden bleiben. Rücknahme-Daten (SP-09): IDs und früheres Ende beendeter Stunden sowie die bei der Übernahme entfernten Stunden (Gruppe, Fach, Lehrkraft-ID, Raum, Zeit – dieselben Angaben wie im Stundenplan) sowie die bei der Übernahme entfallenen Vertretungen (SP-13: Stunde, Datum, Art, vertretende Lehrkraft-ID, Raum, Fach, Hinweis, eingetragen von – dieselben Angaben wie im Vertretungsplan); sie dienen nur dem „Übernahme zurücknehmen“ bis zum Stichtag, das die Vertretungen wiederherstellt, sofern ihre Stunde an dem Tag wieder gilt. **Auskunft (SP-10):** die planende Person erhält zu ihren Läufen nur die Handlung (Zeilen-ID, `created_by`/`applied_by`, Zeitpunkte) – Vorschlag, Parameter, Kennzahlen, Protokoll und Rücknahme-Daten sind Entwürfe ohne Außenwirkung und enthalten Dritte (Lehrkräfte) nur als Kürzel/ID; was daraus in den Plan übernommen wurde, steht in der Auskunft der betroffenen Lehrkraft als Stunde (mit Herkunft `solver_run_id`). Eine Vertretung mit abweichendem Fach (SP-12) steht vollständig (inkl. Fach) in der Auskunft der vertretenden Lehrkraft. **Kontolöschung (SP-14):** Lehrkraft-IDs im JSON von Parametern, Vorschlag, Rücknahme-Daten und Protokoll haben keinen Fremdschlüssel; die Kontolöschung (auf Antrag und im Löschlauf) ersetzt sie durch den Platzhalter „gelöschte Lehrkraft“, ebenso Kürzel bzw. Name der Lehrkraft in Texten des Laufs (Kostenposten, Gründe „nicht gesetzt“, Vorprüfung, Protokoll – als ganzes Wort, DS-21). **Seit R2-P1 (2026-10-26) feldgenau:** Lehrkraft-Felder (`teacherId(s)`, `substituteId`, `createdBy`, `id` von Befunden …) werden nur als ganze Kennung ersetzt, Texte (Bezeichnung, Grund, Kostenposten, Protokoll, Hinweis) zusätzlich nach Kürzel/Name; strukturelle Kennungen (Fach, Raum, Gruppe, Stunde, Einheit, Lehrauftrag, Kopplung, Zeit) bleiben immer unverändert – auch wenn ein Kürzel gleich lautet (Lehrkraft „MU“ = Fach „MU“ = Raum „MU“). Der Platzhalter selbst wird bei einer weiteren Löschung nicht angetastet. Läufe, die vor R2-P1 eine solche Kollision bereinigt haben, können ein Fach/einen Raum „gelöschte Lehrkraft“ enthalten; die Übernahme eines solchen Laufs kann an Fremdschlüsseln scheitern, das Zurücknehmen solche Stunden verwerfen – keine automatische Reparatur; betroffene Läufe neu rechnen |
| Planversionen *(SP3-01)*: Versionen (`timetable_plan_versions`: Nummer, Name ohne Personen, Status, Stichtag, angelegt/geprüft/freigegeben/veröffentlicht/verworfen von und am, Rücknahme-Daten; *SP3-04:* Änderungsliste an Schüler:innen/Eltern bis zum Versand – Zeilen je Klasse/Kurs mit Kürzeln, geplanter/tatsächlicher Versand) · Entwurfsstunden (`timetable_draft_lessons`: Gruppe, Fach, Lehrkraft, Raum, Zeit, Herkunft) | Versionen LK-SJ-1J ab Schuljahr, Entwurfsstunden mit ihrer Version; Nachtjob: offene Entwürfe abgelaufener Schuljahre verworfen, Rücknahme-Daten ab dem Stichtag geleert | Entwurf ohne Außenwirkung: nur `stundenplan.manage` sieht ihn, kein Plan, Vertretungsplan, Monitor, Druck oder Export liest ihn (Grep-Test); in der Auskunft erscheinen Lehrkräfte darin nicht (wie Solver-Vorschläge), Planende nur als Handelnde; Kontolöschung leert die Lehrkraft. *SP3-04:* Rücknahme-Daten nur bis zum Stichtag (Nachtjob), die Änderungsliste wird nach dem Versand geleert; die Kontolöschung ersetzt Lehrkraft-Kennungen und Kürzel in beiden (DS-21). Die Änderungsliste (Gong) nennt nur Fach, Klasse/Kurs, Zeit, Raum und Kürzel – keine Kommentare, keine Entwürfe |
| Prüfung und Freigabe *(SP3-03)*: Kommentare (`timetable_plan_comments`: Text ≤ 500 Zeichen ohne Gesundheitsangaben, Bezug Version/Lehrkraft/Klasse/Stunde, verfasst und erledigt von/am, „aus der Lehrkräfte-Vorschau“) · Schalter „Lehrkräfte-Vorschau“ an der Version | mit ihrer Version (LK-SJ-1J ab Schuljahr) | Kommentare sehen die Planung (`stundenplan.manage`) und die Prüfung (`stundenplan.review`, Schulleitung, erst ab „in Prüfung“); eine Lehrkraft sieht nur eigene Kommentare und in der Vorschau „Mein Plan ab …“ (Vorgabe aus, nur in Prüfung/freigegeben) nur ihre eigenen Stunden; nie Schüler:innen, Eltern, Monitor, Gong, Druck oder Export (Grep-Test). Auskunft: eigene Kommentare mit Text; Prüfnotizen über eine Lehrkraft nicht (Entwurf ohne Außenwirkung, wie die Entwurfsstunden). Kontolöschung leert Verfasser:in, Bezug und „erledigt von“, der Text bleibt bis zur Löschung der Version |
| Sofort-Korrekturen *(SP3-05)*: Protokoll (`timetable_plan_changes`: Art der Änderung, Stichtag, Stunde vorher/nachher mit Kennungen von Gruppe, Fach, Lehrkraft, Raum, optionale Begründung ohne Personen, geändert von/am, geplanter/tatsächlicher Versand der Änderungsliste) | LK-SJ-1J ab Anlage | nur die Planung (`stundenplan.manage`) sieht das Protokoll; Lehrkräfte bekommen ihre Änderungen als Gong (Fach, Klasse/Kurs, Zeit, Raum, Kürzel), Schüler:innen/Eltern die Zeilen ihrer Klassen/Kurse zur Vortags-Uhrzeit – nie die Begründung. Auskunft: eigene Korrekturen als Handelnde:r. Kontolöschung ersetzt die Lehrkraft in Vorher/Nachher durch „gelöschte Lehrkraft“ (DS-21-Muster), „geändert von“ wird leer |
| Fachbedarf *(SP2-12)*: Lehrfächer je Lehrkraft · bekannte Abgänge/Zugänge (Datum, Stunden, ohne Begründung) | Lehrfächer LK-KONTO; Abgänge/Zugänge LK-ENDE-1J ab Datum (mit dem Konto sofort) | Pflege und Details nur `stundenplan.manage`; „Fachbedarf einsehen“ nur Summen je Fach ohne Namen; Klassenzahlen der Prognose ohne Personenbezug |
| Abwesenheiten von Lehrkräften – auch selbst gemeldet, mit Antrag/Genehmigung (P4-74) – und Vertretungsmaterial je Stunde (Text, Datei – Q5-12; VT-01: auch ohne Abwesenheit) | LK-SJ-1J ab Ende der Abwesenheit; Material LK-SJ-1J ab Datum (VT-01, F-10-12; mit einer Abwesenheit zusätzlich mit ihr gelöscht) | Grund nur „krank“ ohne Ergänzung, nie im Gong; Material sieht nur die Lehrkraft der Stunde, die Vertretung, die Planung und (mit Häkchen) die Gruppe |
| Vertretung „mehr Infos“ (VT-01): Grund-Kategorie, interner Hinweis, „nur Betreuung“, geändert von/am, Kenntnisnahme an `timetable_substitutions`; Historie `timetable_substitution_changes` (vorher/nachher); Tagesmitteilungen `timetable_day_notes` | LK-SJ-1J ab Datum (alle drei) | Kategorie öffentlich, aber grob (fehlende Lehrkraft immer „Lehrkraft abwesend“); interner Hinweis, Kenntnisnahme und Historie nur Planung (Vertretungslehrkraft: eigener Hinweis/Kenntnisnahme); Kontolöschung ersetzt die Lehrkraft in der Historie |
| Sendewarteschlange der Vertretungsnachricht (VT-04) `timetable_notification_queue`: Empfänger:in, Vertretungstag, Zielgruppe, geplante/tatsächliche Sendezeit | LK-90 ab Anlage (wie der Gong selbst); bei Kontolöschung mitgelöscht (Fremdschlüssel) | kein Inhalt (die Nachricht entsteht beim Senden aus dem Vertretungsplan und steht nur im Gong); Eltern stehen nicht darin; „geplant für …“ sieht nur `stundenplan.substitute`, und zwar nur als Zahl je Tag und Zielgruppe |
| Umfragen, Antworten, Teilnahme *(P3)* | LK-ENDE-1J (ab Ende der Umfrage) | anonym: Antworten ohne Personenbezug, nur tagesgenau, Teilnahme getrennt; Ergebnisse erst ab 5 Antworten |
| Foren: Themen, Beiträge, Abos *(P3)* | LK-ENDE-1J (ab letzter Antwort) | ausgeblendete Beiträge bleiben bis dahin als Nachweis, Text nur für die Moderation |
| Foren-Meldungen *(P3)* | LK-90 | Moderationsvorgang, danach ohne Zweck |
| Pinnwände, Karten, Mitglieder *(P3)* | LK-ENDE-1J (ab letzter Änderung) | Gruppen-Pinnwände gehen mit der Gruppe; Monitor zeigt nur mit Zustimmung der Leitung, ohne Namen |
| Texte *(P3b)* | LK-ENDE-1J (ab letzter Änderung) | ein gemeinsames Dokument je Text (Yjs-Stand), ohne Zuordnung einzelner Änderungen zu Personen; Texte einer Gruppe gehen mit der Gruppe; Live-Updates nur an Mitglieder, die den Text offen haben |
| Tafeln *(P3b)* | wie Gruppenordner (keine eigene Tabelle) | eine Tafel ist eine Datei „*.excalidraw“ im Gruppenordner (`file_nodes`) und folgt dessen Löschregel; keine Zuordnung einzelner Elemente zu Personen (Ersteller:in nur der Datei, wie bei jedem Upload); Live-Updates nur an Mitglieder, die die Tafel offen haben; Bilder werden nicht übernommen; gelöschte Elemente: Inhalt (Text, Punkte, Verweise) ist sofort weg, nur ein inhaltsloser Grabstein für den Abgleich bleibt ≤ 1 Tag (Serverzeit) |
| Kursraum *(P3)* | – (speichert nichts) | zeigt nur Daten der anderen Module |
| Mängel-/Störungsmeldungen, Verlauf, Fotos *(P4, Gebäude & Technik)* | LK-ENDE-1J (ab Abschluss: erledigt/abgelehnt) | offene Meldungen bleiben; Fotos nur von Sachen, Metadaten (EXIF/GPS) entfernt; Zuständigkeit je Kategorie über Gruppen (ohne Personenbezug) |
| Wartungstermine, Räume *(P4, Gebäude & Technik)* | LK-ENDE-1J (ab Terminende) | Personenbezug nur „angelegt von“; Raumsperren und Schulkalender-Eintrag fallen mit dem Absagen weg |
| Anlagen/Geräte, Prüfarten *(P4, Gebäude & Technik)* | – (ohne Personenbezug, `NO_PERSONAL_DATA`) | wer erfasst hat, steht nur im Audit-Log (Pseudonymisierung B-06) |
| Prüfnachweise: Protokoll-PDF und Bemerkung *(G4-01)* | LK-1J ab Prüfdatum **und** zwei spätere erledigte Prüfungen derselben Art am selben Ziel („bis zur übernächsten Prüfung“, Vorgabe) – als Moduleinstellung auch drei bzw. fünf (Q5-26), DSB-FRAGEN §11 | Reale Protokolle (DGUV V3, Feuerlöscher) tragen Name/Unterschrift der prüfenden Person, die Bemerkung kann Namen enthalten. Der Löschlauf **leert** nur `report_key`/`report_size`/`note` (Modus „leeren“), Termin, Ergebnis und Firma bleiben als Nachweis; die PDF-Datei räumt danach der Dateispeicher-Lauf ab. Nie Teil einer Auskunft (kein Konto) |
| Anmeldeverfahren *(P4, Schulanmeldung)* | LK-ENDE-1J (ab Verfahrensabschluss) | Personenbezug nur „angelegt von“ |
| Anträge der Schulanmeldung, Verlauf *(P4)* | LK-90 ab `retention_from` (Statusmaschine) | unbestätigt: eigener Job löscht nach 48 h; zurückgezogen: ab Rücknahme; abgelehnt/Warteliste: Verfahrensabschluss + Löschfrist (Vorgabe 60 Tage, Q-36); übernommen: ab Übernahme (die Daten leben dann im Konto); offene/aufgenommene ohne Fristbeginn. Online nur, was Termin und Gespräch brauchen (keine Noten, kein Förderbedarf, keine Religion, keine Uploads). Auskunft ohne Konto per Vorgangsnummer/E-Mail (DS-04) |
| Elternsprechtag: Sprechtage, Termine *(P4, 4d)* | LK-SJ (Sprechtag ab Datum, Termine ab Gesprächsbeginn) | Verfügbarkeiten und Gesprächswünsche gehen mit dem Sprechtag; eine Absage löscht den Termin sofort; keine Gesprächsinhalte, keine Notizen |
| Kurswahlen: Wahlverfahren, Angebote, Wahlen (bei Mehrfachwahl je Platz eine Zeile, P4-67) *(P4, 4d)* | Verfahren LK-ENDE-1J (ab Wahlende), Wahlen LK-SJ-1J (ab Abgabe) | Angebote und Wahlen gehen mit dem Verfahren; das Ergebnis lebt danach als Gruppenmitgliedschaft weiter. Seed des Loses im Verfahren und im Protokoll (Nachvollziehbarkeit) |
| Sitzpläne *(P5-01, mit 4d)* | LK-SJ (ab letzter Änderung) | Plätze gehen mit dem Plan; nur Name, Initialen und Platz – Fotos nur als Profilbild mit Einwilligung (abschaltbar), Druck ohne Fotos |
| Notenbuch: Bücher, Lehrkräfte, Spalten, Teilnoten mit Kurzkommentar, Halbjahreswerte *(P5-10, Block 5a)* | LK-SJ-1J (ab Ende des Schuljahres des Buchs) | Arbeitsnotenbuch der Fachlehrkraft (Anlage 2 II Nr. 4 VO-DV I); alles geht mit dem Buch. Amtliche Zeugnisnoten stehen in der Schulverwaltungssoftware – die Halbjahresliste geht nur als Export dorthin (Frist der Liste klärt die DSB, DSB-FRAGEN §15). Keine Beobachtungsnotizen, Kommentar höchstens 200 Zeichen ohne Gesundheitsbezug |
| Notenbuch: Bestätigung des Datenschutzhinweises *(P5-17)* | mit dem Konto (`follows users`) | je Konto nur Fassung und Zeitpunkt der Bestätigung – Nachweis, dass die Person vor der ersten Nutzung informiert wurde; eine neue Fassung verlangt eine neue Bestätigung |
| Notenbuch: Offline-Geräte (Server-Schlüsselanteil) *(P5-20, GATE-5a)* | LK-SESSION ab `expires_at`: spätestens 7 Tage nach dem Einschalten (nächtlicher Lauf `notenbuch-offline-frist` und Löschlauf), früher bei echtem Abmelden, Ausschalten oder Rechteentzug | je Dienstgerät und Person nur eine zufällige Gerätekennung, Konto, zuletzt genutzte Sitzung, Grund (Zertifikat/Schulnetz), der Server-Anteil des Cache-Schlüssels und der letzte Abgleich – keine Noten; der Anteil steht nie in einer Auskunft (`EXPORT_OMIT`). Ohne die Zeile ist der verschlüsselte Zwischenspeicher im Browser unlesbar. Die Neuanmeldung nach der 15-Minuten-Sperre lässt ihn stehen (Q-5A-28). Ist das Gerät nicht mehr berechtigt, wird der Anteil nur noch zum Übertragen geliefert (Frist = jetzt, gelöscht spätestens in der Nacht). Der Browser-Cache (eine Datenbank je Konto) enthält nur die noch nicht übertragenen Teilnoten und offenen Konflikte, AES-GCM-verschlüsselt, Geräteanteil nicht exportierbar; auf Privatgeräten von außen wird er nie angelegt |
| Schulbücherei: Titel, Exemplare *(BU-01, `docs/BUECHEREI.md`)* | – (ohne Personenbezug, `NO_PERSONAL_DATA`) | Bestand mit bibliografischen Angaben, Exemplarnummer, Signatur, Standort, Zustand und Aussonderung (Datum, Grund ohne Namen); wer erfasst hat, steht nur im Audit-Log. Ausleihen siehe nächste Zeile |
| Schulbücherei: Ausleihen *(BU-02)* | offen: mit dem Konto (`LK-KONTO`; Kontolöschung leert die Person); Rückgabe **ohne** Befund: sofort gelöscht; Rückgabe **mit** Befund: bis zur Erledigung, dann LK-SJ-1J | kein Ausleihverlauf je Person – es bleiben nur Zähler je Monat und Medienart (`buecherei_stats`, `NO_PERSONAL_DATA`); Ausleihe/Rückgabe nicht im Audit-Log, nur Befunde. Die Theke (auch Schüler-Helfer:innen) sieht nur Name, Klasse und offene Ausleihen; Befunde nur die Verwaltung (`buecherei.materials`). Befund beschreibt die Sache, ohne Namen. Leihfristen sind Moduleinstellungen, keine Löschfristen (DSB-FRAGEN §18) |
| Schulbücherei: Vormerkungen *(BU-03)* | LK-90 ab Vormerkung; vorher gelöscht bei Ausleihe an die Person, Ablauf der Abholfrist (Vorgabe 1 Woche) oder Löschen durch die Person; Kaskade mit dem Konto | nur für ganz ausgeliehene Titel; andere (auch die Theke) sehen nur die Zahl der Vormerkungen bzw. „liegt für eine andere Person bereit“, nie Namen. Der Gong beim Bereitlegen nennt keinen Titel. „Meine Ausleihen“ zeigt nur offene Ausleihen und Vormerkungen (kein Verlauf); Eltern sehen die ihrer Kinder lesend (minderjährig bzw. mit Einwilligung „Eltern informieren“). Auskunft und Eigenexport („Bücherei.txt“) enthalten offene Ausleihen, Befunde und Vormerkungen mit Titel |
| Schulbücherei: Erinnerung und Mahnungen *(BU-04)* | an der offenen Ausleihe (Mahnstufe, Tag der letzten Mahnung, erinnerte Fälligkeit): Rückgabe ohne Befund löscht sie mit der Ausleihe, Rückgabe mit Befund leert sie, Verlängern setzt sie zurück; Benachrichtigungen nach deren Löschklasse, Mails nach Versand geleert (Mail-Warteschlange) | täglicher Lauf `buecherei-mahnungen`: Erinnerung vor Fristende (Vorgabe 2 Tage, abschaltbar), Mahnstufen 1–3 nur an Schultagen im eingestellten Abstand; ab Stufe 2 auch die Eltern Minderjähriger (nur „handelt für“, nie bei Eigenständigen); Mail optional (Vorgabe aus, nur bestätigte Adressen). Benachrichtigungen und Mails nennen **keinen Titel**, nur „Meine Ausleihen“ nach der Anmeldung. Mahnungen werden nur gezählt (`buecherei_stats.dunnings`, ohne Person), nicht im Audit-Log. Mahnliste fürs Büchereiteam (`buecherei.desk`): Name, Klasse, Titel, fällig seit – Mahnstufen nur Erwachsenen im Team, Schüler-Helfer:innen nicht. Die Theke selbst zeigt keine Mahnstufen; die Person, ihre Eltern (lesend) und die Auskunft schon |
| Schulbücherei: Etiketten und Statistik *(BU-05)* | kein Personenbezug (Bestand) | je Exemplar nur Zahl der Ausleihen und Monat der letzten Ausleihe, ohne Person, dazu „Etikett gedruckt am“; die Statistik (Bestand/Büchereiteam mit `buecherei.stock`) zeigt Ausleihen, Verlängerungen und Mahnungen je Monat und Medienart, Bestand je Medienart, nie ausgeliehene Titel und Aussonderungsvorschläge – keine Auswertung je Person oder Klasse (das Datenmodell gibt sie nicht her). Etiketten tragen Signatur, Titel und Exemplarnummer, keine Personendaten |
| Schulbücherei: ISBN-Abfrage *(BU-06)* | kein Personenbezug; Zwischenspeicher nur im Arbeitsspeicher (Treffer 24 h, „nichts gefunden“ 1 h) | **ab Werk aus**, einschalten nur mit `verwaltung.privacy`; dann schickt der Server beim Nachschlagen nur die ISBN an öffentliche Bibliothekskataloge (Deutsche Nationalbibliothek, Verbundkatalog des Hochschulbibliothekszentrums NRW, je Quelle abschaltbar; Open Library – Empfänger außerhalb der EU – ab Werk aus, nur bewusst zuschaltbar), ohne Cookies, Namen oder Angaben zur Schule; die Kataloge sehen die Adresse des Schulservers. Im VVT als Empfänger genannt; die Oberfläche weist vor dem Nachschlagen auf den externen Dienst hin. Dubletten im eigenen Bestand werden erkannt, ohne nach außen zu fragen. Keine Cover von außen (nur eigene Fotos, Entscheidung 10) |
| Schulbücherei: Ausweis-Code *(BU-07)* | LK-KONTO (geht mit dem Konto) | zufälliger Code ohne Namen oder Kontonummer; Ersatz bei Verlust löscht den alten Code; der gedruckte Ausweis trägt Name und Klasse. Anlegen/Ersetzen/Drucken nur das Büchereiteam an der Theke (`buecherei.desk`), Ersatz im Audit-Log |
| Schulbücherei: Ersatzforderungen *(BU-12, Stufe 2)* | offen: mit dem Konto (`LK-KONTO`, Kontolöschung leert die Person); bezahlt/erlassen: LK-SJ-1J ab Abschluss | `buecherei_compensations` (Person, Gegenstand, Grund – Sache ohne Namen –, Betrag, Status, Brief gedruckt am); keine Zahlungsdaten. Nur `buecherei.materials` mit eingeschalteter Schulbuchausleihe; Abschluss erledigt den zugehörigen Befund (beide dann LK-SJ-1J). Brief an die Eltern Minderjähriger („handelt für“), sonst an die Person – Browserdruck, ohne Bankverbindung. Person und Eltern sehen offene Forderungen lesend; Auskunft/Eigenexport („Ersatzforderungen.txt“); Anlegen, Ändern, Status und Brief im Audit-Log |
| Schulbücherei: Schulbuchausgabe *(BU-11, Stufe 2)* | offen: mit dem Konto (`LK-KONTO`, Kontolöschung leert die Person), gilt nur für das Schuljahr der Ausgabe; Rücknahme **ohne** Befund: sofort gelöscht; **mit** Befund: bis zur Erledigung, dann LK-SJ-1J | `buecherei_material_issues` (Exemplar, Person, Schuljahr, ausgegeben, zurück bis Schuljahresende, Mahnstufe). Ausgabe klassen-/kursweise und Rücknahme per Scan nur `buecherei.materials` und nur mit eingeschalteter Schulbuchausleihe; Zustand bei der Rücknahme steht am Exemplar (ohne Person), Befund beschreibt die Sache. Nicht Zurückgegebenes bleibt über das Schuljahresende als offener Posten und wird an Schultagen gemahnt (Stufen 1–3, Eltern Minderjähriger ab Stufe 1, ohne Titel, Mail optional). Audit-Log nur mit Inventarnummer, ohne Person. Person und Eltern (lesend) sehen offene Schulbücher unter „Meine Ausleihen“; Auskunft/Eigenexport („Schulbücher.txt“). Querschnittstest `loeschregel-stufe2.test.ts` |
| Schulbücherei: Sicht der Klassenleitung *(BU-16)* | – (keine eigene Speicherung; liest offene Schulbuch-Ausgaben und Ersatzforderungen aus den Zeilen oben) | Reiter „Meine Klasse“: die Klassenleitung (Lehrkraft als Leitung einer aktiven Klasse, kein eigenes Recht) sieht je Schüler:in ihrer Klasse nur den Namen und die **Zahl** offener Schulbücher (nur mit Schulbuchausleihe) und offener Ersatzforderungen – keine Titel, Inventarnummern, Gründe, Beträge oder Fälligkeiten, keine Ausleihen der Bücherei (Stufe 1). Kein Export, kein Druck, keine Benachrichtigung. Querschnittstest `klasse.test.ts` „keine Titel“; DSB-FRAGEN §18 |
| Schulbücherei: Lernmittel und Bücherlisten *(BU-10, Stufe 2)* | – (ohne Personenbezug, `NO_PERSONAL_DATA`) | nur mit eingeschalteter Schulbuchausleihe (`buecherei.lernmittel`, ab Werk aus): Lernmittel je Jahrgang/Fach/Kurs mit Preis, Exemplare mit Inventarnummer, Zustand (Vermerk zur Sache, keine Namen) und Aussonderung, Hinweistext und Freigabe der Bücherliste je Jahrgang; Pflege nur `buecherei.materials`, im Audit-Log. Wem ein Schulbuch gehört, steht seit BU-11 in einer eigenen Zuordnung nur im laufenden Schuljahr (Zeile darüber; Löschregel `docs/BUECHEREI.md` „Stufe 2 – Festlegungen“) |
| Rate-Limit-Zähler *(P4)* | LK-SESSION (ab Fensterbeginn) | IP nur gekürzt und gehasht (IPv6 /64), E-Mail nur gehasht – keine Rückrechnung, nur für das Zeitfenster |
| Mail-Warteschlange *(P4)* | LK-90 (ab Eingang) | Text nach dem Versand geleert, nur Empfänger/Zweck/Zeitpunkt für Rückfragen |
| Löschprotokoll | 5 Jahre (enthält keine Personendaten, nur Anzahlen) | Rechenschaft |

### 3.5 Löschregeln je Speicherort

| Ort | Regel |
|---|---|
| Datenbank | nächtlicher **Löschlauf**, hartes Löschen (kein Soft-Delete) |
| Dateispeicher | wird im selben Lauf mit den zugehörigen Datensätzen gelöscht. Was „zugehörig“ ist, steht ausdrücklich in `STORAGE_KEY_COLUMNS` (`src/core/privacy/dateispeicher.ts`, mit Abdeckungstest) – Dateien ohne Verweis, älter als 1 h, gehen |
| Backups | verschwinden mit LK-BACKUP: Gelöschtes ist nach spätestens ≈ 3 Monaten aus allen Sicherungen raus. Das steht so in den Datenschutzhinweisen. Ein Restore spielt nur den Löschlauf neu, der beim nächsten Lauf alles Überfällige wieder entfernt |
| Exporte (Auskunft, Archivexport, Zugangsdaten-CSV, Schulanmeldung: CSV-Exporte und Auskunft je Antrag als JSON) | werden nur zum Download erzeugt und nicht auf dem Server aufbewahrt. Wer exportiert, steht im Audit-Log (ZIP-Exporte nur über einen Knopf/POST, damit kein eingebettetes Bild einen Export und Audit-Eintrag auslöst). Für die Kopie ist ab dann die exportierende Stelle verantwortlich |
| Endgeräte: PWA-Cache (P4-73) | der Service Worker legt **nur** statische Programmdateien ab (`/_next/static/…` mit Inhalts-Hash, SchulOS-Symbol) – keine Seiten, keine API-/RSC-Antworten, nichts mit `no-store`/`private`, nichts unter dem Notenbuch (Q-5A-8). Abmelden und jede Anmeldeseite leeren die Caches; eine neue Version räumt alte weg. Ohne Verbindung erscheint nur ein fester Hinweis ohne Inhalte |
| Offsite-Kopie | gleiche Aufbewahrung wie der Backupserver (restic forget/prune auf beiden Zielen). Mit unveränderlicher Kopie (SEC-11: Schnappschüsse beim Anbieter) bleibt ein Stand zusätzlich so lange, wie die Schnappschüsse gehalten werden (Vorgabe-Empfehlung 14 Tage) – die längste Aufbewahrung verlängert sich entsprechend; in den Datenschutzhinweisen nennen |

### 3.6 Archivanbietung (§ 9 Abs. 3 VO-DV I)

1. Am Schuljahresende schließt der Schuljahreswechsel-Assistent jedes Klassenbuch ab und erzeugt
   den **Archivexport** (PDF/A zum Lesen + JSON maschinenlesbar). Die Metadaten enthalten:
   - Schuljahr und Klasse
   - Abschlussdatum
   - **frühestes Vernichtungsdatum** = 31.12. des Abschlussjahres + 10 Jahre, frühestens aber
     31.12. des Jahres, in dem die Schulpflicht der letzten betroffenen Person endet,
     + 10 Jahre (SchulOS rechnet das vor, die Schule prüft)
   - den Vermerk **„nach Fristablauf dem zuständigen Archiv anzubieten“**
2. Die Schule verwahrt den Export für 10 Jahre (Aufgabe der Schule bzw. des Schulträgers, nicht
   von SchulOS). Nach Fristablauf bietet sie ihn dem Archiv an, in der Regel dem Kommunal- oder
   Kreisarchiv des Schulträgers. Übernimmt das Archiv ihn nicht, wird er vernichtet.
3. Im Live-System löscht der Löschlauf das Klassenbuch erst, wenn der Archivexport als
   **„übergeben“ bestätigt** ist **und** die Frist LK-SJ-1J abgelaufen ist. Fehlt die Bestätigung,
   zeigt die Verwaltung eine Warnung, und der Löschlauf lässt das Klassenbuch stehen.

### 3.7 Umsetzung in SchulOS

1. **Löschklassen im Manifest** (P2-00). Jede Tabelle mit Personenbezug wird deklariert, mit
   Zweck, Datenkategorien, Löschklasse und der Spalte, aus der sich der Startzeitpunkt ergibt.
   Ein Test schlägt fehl, wenn eine Tabelle mit Personenbezug nicht deklariert ist.
   ```ts
   retention: [{
     table: "chat_messages", purpose: "Schulkommunikation",
     categories: ["Nachrichteninhalt", "Absender", "Zeitpunkt"],
     class: "LK-1J", start: "created_at",
   }],
   ```
2. **Löschlauf** jede Nacht. Vor dem ersten Lauf und nach jeder Friständerung gibt es eine
   **Vorschau** („heute Nacht würden 1 204 Nachrichten und 38 Konten gelöscht“).
3. **Löschprotokoll** mit Anzahlen je Datenart und Lauf, ohne Inhalte.
4. **Löschsperre (Legal Hold):** Die Schulleitung kann Personen oder Gruppen begründet und
   befristet ausnehmen, etwa bei einem Rechtsstreit oder Widerspruchsverfahren. Jede Sperre wird
   im Audit-Log vermerkt.
5. **Löschung auf Antrag (Art. 17):** Die Verwaltung löscht eine Person vorzeitig. Ausgenommen
   sind Daten unter Aktenpflicht (Art. 17 Abs. 3 b). Was ausgenommen wurde und warum, zeigt
   SchulOS an.
   Löschung auf Antrag und Löschlauf löschen Konten über **dieselbe** Funktion (`deleteAccounts`, DS-21): in einer
   Transaktion Audit-Log der Person sofort pseudonymisieren, Verweise ohne Fremdschlüssel (`SOFT_REFS`, z. B. Zeitwünsche)
   löschen, Solver-Läufe bereinigen (Kennung, Kürzel – nur Lehrkraft-Felder und Texte, nie Fach/Raum/Gruppe/Stunde, R2-P1), dann das Konto mit allen Kaskaden. Querschnittstest
   `src/core/privacy/loeschlauf-konto.test.ts`.
6. **Schuljahreswechsel-Assistent:** Versetzung, Abgänger markieren, Gruppen archivieren,
   Archivexport, Vorschau des Löschlaufs.
7. **Ausgemusterte Datenträger** (alte Server- oder Backup-Platten) werden nach DIN 66399
   vernichtet bzw. sicher überschrieben. `schulosctl` bekommt dafür einen Befehl mit Protokoll
   (Track B).

### 3.8 Kontrolle und Pflege

- **Jährlich beim Schuljahreswechsel:** Die Schulleitung prüft das Löschprotokoll, offene
  Löschsperren und nicht übergebene Archivexporte. Der Assistent erzwingt diesen Schritt.
- **Bei jedem neuen Modul:** Seine Datenarten kommen über das Manifest automatisch in diesen
  Baustein. Die erzeugte Übersicht geht an die oder den Datenschutzbeauftragten.
- **Bei Rechtsänderungen** (VO-DV I/II, Dienstanweisung) werden die Löschklassen angepasst und
  im Changelog vermerkt.

### 3.9 Feste und einstellbare Vorgaben (DS-15, Stand 2026-10-12)

Grundsatz (Projektleitung 2026-10-11): Die Schule entscheidet als Verantwortliche, SchulOS liefert sichere Vorgaben. Einstellbar ist,
was eine Schule berechtigt anders regeln kann; die Grenzen sind fest im Manifest und werden getestet (`retention.test.ts`,
`src/core/privacy/fristen.test.ts`: Vorgabe = Regelfrist, Optionen zwischen 30 Tagen und „einstellbar bis“). Löschfristen
ändert nur, wer zusätzlich das Recht „Datenschutz“ (`verwaltung.privacy`) hat; jede Änderung steht im Audit-Log
(`verwaltung.module.setting`) und erscheint in der Datenschutz-Einrichtung (DS-12), in Löschkonzept, Datenschutzhinweisen und VVT.

**Einstellbar (Verwaltung → Rechte & Module):**

| Einstellung | Wirkt auf | Vorgabe | Optionen | Begründung der Grenzen |
|---|---|---|---|---|
| Konten nach dem Abgang löschen (`verwaltung.account_grace`) | LK-KONTO (Karenz) | 90 Tage | 30 / 90 / 180 / 365 Tage | unter 30 Tagen kein Eigenexport/Rückfragen; über 1 Jahr Grenze der Klasse |
| Chatnachrichten aufbewahren (`messenger.keep_days`) | Nachrichten, Direktchats (LK-1J) | 1 Jahr | 90 / 180 / 365 Tage | Kommunikation ist keine Akte – länger als 1 Jahr nicht (strenger als die Klasse) |
| Chats mit der Schulsozialarbeit aufbewahren (`messenger.counseling_keep_days`) | Teilmenge Direktchat Beratung (LK-90) | 90 Tage | 30 / 60 / 90 Tage | DSB-FRAGEN §8b; nie länger als die Vorgabe |
| Termine aufbewahren (`kalender.keep_days`) | Kalendertermine (LK-TERMIN) | 2 Jahre | 1 / 2 / 3 Jahre | Jahresplanung; 3 Jahre = Grenze der Klasse |
| Prüfprotokolle aufbewahren (`gebaeude.report_keep`, Q5-26) | Protokoll-PDF + Bemerkung | letzte 2 | 2 / 3 / 5, mind. 1 Jahr | Nachweispflicht des Schulträgers (DSB-FRAGEN §11) |
| Löschfrist abgelehnter Anträge (je Anmeldeverfahren, Q-36) | Anträge abgelehnt/Warteliste | 60 Tage | 31–365 Tage | Widerspruchsfrist 1 Monat + Puffer |
| Direktchats unter Schüler:innen, Chats mit der Schulsozialarbeit, Eltern-Info Vertretung/Hausaufgaben, Hinweis ab n unentschuldigten Tagen, Zuständigkeit Beurlaubung (Q5-14…Q5-16) | Funktionen mit Personenbezug | jeweils die vorsichtigere Variante | siehe Rechte & Module | DSB-FRAGEN §8–§10 |
| Außenzugang: Zertifikatspflicht Personal, Verwaltung/Admin von außen (P4-40b) | Zugang von außen | an bzw. gesperrt | Verwaltung → System | SICHERHEIT S27/S28 |

**Bewusst fest (mit Begründung):**

| Vorgabe | Wert | Warum fest |
|---|---|---|
| LK-SESSION (Sitzungen, Einmalcodes, Anmeldesperre, Rate-Limit-Zähler) | bis Ablauf | Sicherheitsfunktion, kein Zweck darüber hinaus |
| Audit-Log | 1 Jahr, danach pseudonymisiert | Rechenschaft (Art. 5 Abs. 2); kürzer schwächt den Nachweis, länger wäre Verhaltenskontrolle (Mitbestimmung) |
| Gong (Benachrichtigungen), Mail-Warteschlange, Foren-Meldungen | 90 Tage (Mailtext sofort nach Versand geleert) | reine Hinweise bzw. Vorgänge; kürzer bringt keinen Gewinn |
| Schuljahresfristen LK-SJ, LK-SJ-1J (Abwesenheitsmeldungen, Aufgaben, Elternbriefe, Planung, Beurlaubungen) | Schuljahresende (+ 1 Jahr) | an das Schuljahr gebunden; Abweichung erst nach DSB-Votum (DSB-FRAGEN §1, §9) |
| LK-AKTE (Klassenbuch, Fehlzeiten) | Archivexport, 10 Jahre im Archiv | Rechtsfrist § 9 VO-DV I |
| LK-ENDE-1J (News, Gruppenordner, Foren, Pinnwände, Texte, Umfragen, Gebäude-Meldungen) | 1 Jahr nach Ende | einheitlich und kurz; Bedarf für eine Einstellung bisher nicht erkennbar (bei Bedarf wie DS-15 nachrüsten) |
| Schulanmeldung: unbestätigte Anträge, Terminblockade | 48 h, 2 h (`CONFIRM_HOURS`, `UNCONFIRMED_HOLD_MINUTES`) | Missbrauchsschutz des öffentlichen Formulars (SICHERHEIT S31/S32) |
| Schulanmeldung: zurückgezogen / übernommen | 90 Tage | DSB-FRAGEN §3b (Vorschlag „so lassen“) |
| Anonyme Umfragen: Ergebnisse ab 5, in Fünferschritten (`MIN_ANONYMOUS`) | 5 | technische Anonymität (§5) – keine Schulentscheidung |
| Lesezugriffe im Audit-Log zusammengefasst (`READ_DEDUP_MINUTES`) | 30 min | Protokollqualität, kein Personenbezug darüber hinaus |
| Löschprotokoll | 5 Jahre, nur Anzahlen | Rechenschaft |
| Backups (LK-BACKUP) | 14 / 4 / 3 | Einstellung am Backupserver (B-21…B-28), nicht in SchulOS |

---

## 4. Datenschutz-Kern (Funktionen, die gebaut werden müssen)

| ID-Vorschlag | Funktion | DSGVO |
|---|---|---|
| DS-01 | Löschklassen zentral + `retention` im Modul-Manifest (§3.7) plus Test „jede Tabelle mit Personenbezug ist deklariert“ | Art. 5 Abs. 1 e, Art. 25 |
| DS-02 | Löschlauf mit Vorschau, Löschprotokoll und Löschsperre | Art. 17 |
| DS-03 | Konto-Lebenszyklus: aktiv → gesperrt (Abgang) → gelöscht, inkl. Elternkonten | Art. 5 Abs. 1 e |
| DS-04 | **Auskunft auf Knopfdruck:** Export aller Daten einer Person als ZIP (JSON + Dateien), ausgelöst durch die Verwaltung. Jedes Modul liefert seinen Teil über eine Manifest-Funktion `exportForUser()`. Daten Dritter bleiben draußen (SEC-05): Wo die Person nur gehandelt hat (eingewilligt, entschieden, protokolliert – `*_by`, `actor_id`), steht nur die Handlung mit Zeitpunkt in `<tabelle>.handlungen.json`; Dateien nur, wenn es eigene sind (z. B. kein Foto eines Kindes in der Auskunft der Verwaltungskraft, die es hochgeladen hat). **Schulanmeldung ohne Konto (P4-42):** Anträge hängen an keinem Benutzer – das Sekretariat (`anmeldung.manage`) bzw. `verwaltung.privacy` sucht unter Verwaltung → Schulanmeldung → Auskunft per Vorgangsnummer oder E-Mail-Adresse (genau, keine Teilsuche) und lädt den Antrag als JSON (Angaben, Termin, Unterlagen-Häkchen, Entscheidung, Verlauf ohne Namen von Beschäftigten, ohne Token-Hashes); Suche und Auskunft stehen ohne Personendaten im Audit-Log. Identität prüft die Schule (Antwort an die hinterlegte Adresse bzw. persönlich, DSB-FRAGEN §3e) | Art. 15, Art. 20, Art. 15 Abs. 4 |
| DS-05 | Eigenexport für Schüler:innen vor dem Abgang („Meine Dateien und Abgaben herunterladen“) | Art. 20 |
| DS-06 | Datenschutzhinweise als Seite in SchulOS, erzeugt aus den Manifesten (Zwecke, Fristen, Empfänger), ergänzt um Freitext der Schule | Art. 13/14 |
| DS-07 | **VVT-Generator:** Verzeichnis der Verarbeitungstätigkeiten je aktivem Modul als druckbares Dokument; Grundlage für die DSFA | Art. 30, Art. 35 |
| DS-08 | Audit-Log mit Frist und Pseudonymisierung; Lesezugriffe auf sensible Daten (Fehlzeiten, Klassenbuch, Auskunft) werden mitprotokolliert | Art. 5 Abs. 2, Art. 32 |
| DS-09 | Profilbilder nur mit Einwilligung (Schalter plus Einwilligungsnachweis), sonst Initialen | § 120 Abs. 6 SchulG |
| DS-10 | Schuljahreswechsel-Assistent inkl. Archivexport (siehe §3.6, §3.7) | – |
| DS-12 | **Datenschutz-Einrichtung durch die Schule** (Verwaltung → Datenschutz → Einrichtung): Bestätigung „Verantwortliche nach Art. 4 Nr. 7, DSB benannt“, je Thema der DSB-Checkliste (DS-13, `src/core/privacy/checkliste.ts`) Status „Vorgabe übernommen / geändert / mit DSB geklärt“ + Bemerkung samt aktueller Moduleinstellungen und aller Löschfristen; wird eine Einstellung nach der Prüfung geändert, ist der Punkt wieder offen. Solange etwas offen ist, Hinweis auf Heute für alle mit `verwaltung.privacy`. Nachweis „Datenschutz-Konfiguration Stand …“ als Druck/PDF und JSON; Änderungen und Abrufe im Audit-Log (`datenschutz.einrichtung.*`), gespeichert ohne Personenbezug in `app_settings` | Art. 5 Abs. 2, Art. 24, Art. 30 |

**Wann bauen?** DS-01 sollte **vor Phase 2** kommen. Dann deklarieren die neuen Module
(Klassenbuch, Abwesenheiten, Elternbriefe) ihre Fristen von Anfang an, statt nachträglich. Das
kostet jetzt etwa eine Aufgabe und spart später einen Umbau. Die anderen Punkte können nach
Phase 2 als eigener Block folgen.

---

## 5. Privacy by Design: Regeln für alle künftigen Module

- **Kein Feld ohne Zweck.** Neue Spalten mit Personenbezug brauchen einen Eintrag in `retention`.
- **Freitext vermeiden,** wo eine Auswahl reicht. Das gilt besonders bei Abwesenheiten
  („krank“ statt „Magen-Darm“) und Klassenbuch-Bemerkungen. Beurlaubungen (Q5-16) haben nur die Gründe „familiärer Anlass“,
  „Wettkampf/Veranstaltung“, „sonstiger Grund“ – keine Religion, keine Gesundheit, kein Freitext.
- **Sichtbarkeit über die zentrale Rechte-Engine,** nie modul-lokal. Gilt schon heute.
- **Krankmeldungen und Beurlaubungen – wer den Grund sieht** (DS-18, vollständig): Klassenleitung; Personen mit dem Recht
  „Alle Abwesenheiten bearbeiten“ (`abwesenheiten.manage`, z. B. Schulleitung); bei Beurlaubungen über der Grenze die Schulleitung
  (`abwesenheiten.leave_decide`); **alle** verknüpften Eltern minderjähriger Kinder (auch Meldungen des anderen Elternteils) bzw.
  die eigenständige (volljährige) Person selbst – deren Eltern nie, auch nicht mit Einwilligung; das Sekretariat nur bei der
  Aufnahme einer Telefonmeldung (`abwesenheiten.phone`, keine Liste). **Admin-Konten** (Rolle `admin`, Recht `*`) sehen seit
  DS-20 nur Zeitraum und Stand einer Krankmeldung, **nicht den Grund** (wie im Notenbuch F5-05); Beurlaubungsgründe weiterhin.
  Fachlehrkräfte sehen im Klassenbuch nur „entschuldigt“/„nicht entschuldigt“. Melde- und Beurlaubungsformular tragen einen
  Hinweis nach Art. 13 DSGVO (Rechtsgrundlage, Aufbewahrung, diese Liste, „Atteste nicht über Messenger oder Dateien schicken“).
- **Eltern sehen nur ihre Kinder,** Schüler:innen nur sich selbst und ihre Gruppen. **Eigenständige (volljährige)**
  Schüler:innen (Kennzeichen am Konto, setzt die Verwaltung, Q5-05) handeln selbst – Elternbriefe, Eltern-Umfragen,
  Abwesenheiten, Beurlaubungen, Profilbild-Einwilligung; ihre Eltern sehen nichts mehr, außer die Person willigt unter „Eltern
  informieren“ selbst ein (dann Information wie bei Minderjährigen, aber ohne Gründe von Krankmeldungen und ohne Handeln;
  jederzeit widerrufbar, protokolliert). Zentrale Stelle: `src/core/school/majority.ts`. Die Rolle **Personal**
  (Hausmeisterei, Schulsozialarbeit, IT des Schulträgers – P4-10) sieht im Adressbuch nur Lehrkräfte, Verwaltung und
  Personal, keine Schüler:innen und Eltern; Fachrechte (z. B. Meldungen bearbeiten) bekommt sie über Gruppen. Ob
  Konten für Beschäftigte des Schulträgers eine AV-Vereinbarung brauchen, klärt DSB-FRAGEN.md. Die Schulsozialarbeit hat
  die eigene Rolle **Beratung** (Q5-17): für Schüler:innen und Eltern im Adressbuch mit Sprechzeiten/Raum sichtbar (pflegt sie selbst unter „Sprechzeiten und Raum“, Q5-25), sieht
  selbst nur Erwachsene der Schule, Mitglieder eigener Gruppen und Personen mit bestehendem Chat; 2FA-Pflicht sofort. Chats
  mit Schüler:innen/Eltern sind eine Moduleinstellung des Messengers (Vorgabe **aus**, erst nach DSB-Votum, DSB-FRAGEN §8),
  beginnen nur von deren Seite, tragen den Hinweis „nur Terminabsprache“ und werden 90 Tage nach der letzten Nachricht
  gelöscht (eigene Teilmenge im Löschkonzept). Keine Fallakte in SchulOS.
- **Keine Drittanbieter zur Laufzeit:** keine CDNs, kein Tracking, keine externen Schriften.
  `next/font` bettet die Schriften schon beim Build ein. Die Next.js-Telemetrie wird im
  Produktivbuild abgeschaltet.
  **Konferenzlinks im Kursraum** (V-01, Moduleinstellung, Vorgabe **aus**): SchulOS speichert nur den Link, ruft den
  Dienst nie selbst auf und gibt die Kursraum-Adresse nicht weiter (`rel="noreferrer"`); der Knopf weist auf den externen
  Dienst hin. Welcher Dienst genutzt wird (und der Vertrag dazu), entscheidet die Schule. Der Link kann ein Raum-Passwort
  enthalten: nur Personen, die den Kursraum öffnen dürfen, sehen ihn; das Protokoll hält nur den Rechnernamen fest.
- **Anonym heißt technisch anonym** (Umfragen, P3): Antworten ohne Benutzerbezug und nur mit dem Tag,
  „hat teilgenommen“ getrennt und ohne Verweis auf die Antwort, Ergebnisse erst ab 5 Antworten und danach nur
  in **Fünferschritten** (sonst verriete die Differenz vorher/nachher jede einzelne neue Antwort) – auch live
  (Schnellumfrage), Freitexte und CSV sortiert statt in Eingangsreihenfolge. Zielgruppen anonymer Umfragen
  lassen sich nach der ersten Antwort nicht mehr ändern, Schnellumfragen gar nicht bearbeiten (Review 2026-10-10).
  **Grenze:** Die Anonymität gilt gegenüber allen Nutzenden der Plattform (auch Admin-Oberfläche, Exporte,
  Auskunft). Wer direkt auf die Datenbank zugreift (Superuser, Betrieb), könnte Teilnahme und Antwort über
  Systemspalten derselben Transaktion verknüpfen – dieser Zugriff ist über die TOM (§6) beschränkt.
- **Öffentliche Anzeige nur mit Zustimmung** (Monitor-Pinnwand, P3): die Leitung gibt frei, gezeigt werden
  nur freigegebene Inhalte ohne Namen. Nur Pinnwände im Modus „Nur Leitung postet“ oder „Alle posten, Leitung
  gibt frei“ – im Modus „Alle posten“ stünden ungeprüfte Karten im Foyer (SEC-05).
- **Auswertungen über Personen** (z. B. Fehlzeiten-Statistik) nur für die Rollen, die sie für
  ihre Aufgabe brauchen. Lehrkräfte-Nutzungsstatistiken gibt es gar nicht, wegen der
  Mitbestimmung bei technischer Leistungs- und Verhaltenskontrolle. Ebenso keine Statistik je Hausmeister:in
  (Gebäude & Technik zählt nur je Kategorie/Gebäude). **Eigene Zahlen nur für die Person selbst** (Block 4f): „Stunden
  ohne Klassenbuch-Eintrag“ (Q5-06) sieht und bekommt (Freitags-Gong) nur die Lehrkraft selbst – es gibt keine Übersicht
  je Lehrkraft für Schulleitung oder Verwaltung; die Klassenleitung sieht wie bisher fehlende Einträge ihrer Klasse.
  „Mein Deputat“ (Q5-09) zeigt einer Lehrkraft nur ihr eigenes Konto und ihre eigenen Vertretungsstunden, ohne Vergleich.
  Tagesregeln je Lehrkraft (SP2-04: höchstens Stunden am Tag, höchstens Anwesenheitstage – z. B. Teilzeit, **ohne Grund**) sind
  Personaldaten wie das Deputat: Pflege nur mit `stundenplan.manage`, die Lehrkraft sieht ihre eigene Regel unter „Mein Deputat“;
  Tabelle `timetable_teacher_day_rules` (LK-SJ-1J ab Schuljahr, Fremdschlüssel auf das Konto – geht mit der Kontolöschung).
  **Fachbedarf (SP2-12):** Lehrfächer je Lehrkraft (`timetable_teacher_subjects`, Stammdatum ohne Schuljahr, LK-KONTO – geht mit dem
  Konto) pflegt und sieht die Planung (`stundenplan.manage`); sie steuern die Vorschläge bei der Zuweisung und zählen bei Vertretungsvorschlägen
  als „unterrichtet das Fach“. Bekannte Abgänge und Zugänge für die Prognose (`timetable_staff_changes`) speichern nur Datum und Stunden –
  **ohne Begründung** (kein Ruhestand, keine Elternzeit o. Ä.); ein Zugang hat keine Person. Abgänge sieht nur die Planung; LK-ENDE-1J ab dem
  Datum, mit dem Konto sofort. Das Leserecht „Fachbedarf einsehen“ (`stundenplan.forecast_view`, in der Demo die Schulleitung) zeigt nur
  Summen je Fach (Bedarf, Versorgung, Zahl der Lehrkräfte, wegfallende/hinzukommende Stunden) – keine Namen, keine Liste der Abgänge; die
  Funktionen bauen diese Fassung ohne Personenfelder (Test `fachbedarf.test.ts`). Bei einem Fach mit nur einer Lehrkraft lässt sich aus den
  Summen auf die Person schließen – das Recht deshalb nur der Schulleitung geben. Klassenzahlen der Prognose (`timetable_forecast_grades`) sind ohne Personenbezug.
  Bereitschaften (SP2-07: Lehrkraft steht zu einer Stunde der Woche als Vertretungsreserve bereit) sind Personaldienst wie der
  Aufsichtsplan: Pflege und Einsicht nur mit `stundenplan.substitute`, keine Anzeige im Vertretungsplan, auf Monitoren oder im Gong;
  Tabelle `timetable_standby` (LK-SJ-1J ab Schuljahr, Fremdschlüssel auf das Konto – geht mit der Kontolöschung). Verlegung und
  Zusammenlegung speichern nur Stunde bzw. Ziel-Stunde an der Vertretung (`timetable_substitutions.target_period/merge_lesson_id`, Löschung wie die Vertretung).
  SP2-16b: `timetable_substitutions.absence_ended_at` (nur Zeitpunkt, kein Grund) markiert Vertretungen nach dem Ende einer verkürzten Abwesenheit
  zur Prüfung – sichtbar nur in der Vertretungsplanung, gelöscht mit der Vertretung; das Protokoll der Verkürzung nennt wie beim Anlegen keinen Grund.
  **Vertretung mit mehr Infos (VT-01, Projektleitung 2026-10-26, F-10-8 … F-10-13):** `timetable_substitutions.reason` ist eine feste,
  grobe Liste (Lehrkraft abwesend, Klassenfahrt, Exkursion, Praktikum, Prüfung, Veranstaltung, Raum gesperrt, organisatorisch, sonstiges)
  und darf öffentlich erscheinen; die Vorgabe kommt aus der Abwesenheit bzw. Raumsperre – bei einer Lehrkraft immer „Lehrkraft abwesend“,
  krank/Fortbildung/dienstlich sind nie unterscheidbar. `internal_note` (≤ 300 Zeichen, Hinweis „keine Gesundheitsangaben“) sehen nur die
  Vertretungsplanung und – ab VT-02 – die Vertretungslehrkraft dieser Stunde; nie Schüler:innen, Eltern, Monitore, Druck oder der Gong
  (Querschnittstest `vertretung-infos.test.ts` inkl. Grep auf alle Leser). `supervision_only` („nur Betreuung“), `updated_by/updated_at` und
  `acknowledged_at` (Kenntnisnahme durch die Vertretungslehrkraft, freiwillig, Moduleinstellung „Kenntnisnahme von Vertretungen“, Vorgabe
  an, ohne Eskalation; leer, sobald Lehrkraft oder Art wechselt) gehen mit der Vertretung. Die Historie `timetable_substitution_changes`
  (Art der Änderung, Vorher/Nachher als JSON mit Kennung der Vertretungslehrkraft, Hinweisen und Kategorie, „geändert von“) schreibt jeder
  Weg, der Vertretungen ändert (Speichern, Aufheben, Stufe 2, Dauervertretung, Solver-Übernahme/-Rücknahme, Löschen einer Stunde); sie ist nur
  für `stundenplan.substitute` lesbar, LK-SJ-1J ab Datum, und die Kontolöschung (Antrag und Löschlauf, `deleteAccounts`) ersetzt die Kennung
  sowie Kürzel/Namen in den Hinweisen durch „gelöschte Lehrkraft“ (Muster DS-21, Test `loeschlauf-konto.test.ts`). Tagesmitteilungen
  (`timetable_day_notes`, ≤ 300 Zeichen, Hinweis „keine Personen nennen“, an alle oder nur Beschäftigte) folgen der Tagesfreigabe und
  werden ein Schuljahr nach dem Datum gelöscht. Material ohne Abwesenheit (`timetable_absence_materials.absence_id` leer) legen die Lehrkraft
  der Stunde, die Vertretungslehrkraft oder die Planung an.
  Die Vertretungsnachricht (Gong) geht seit VT-04 zur eingestellten Zeit raus (Moduleinstellungen je Zielgruppe: Vortags-Uhrzeit, Vorgabe
  18:00; Ruhezeit, Vorgabe 20:00–06:30; Änderungen für heute sofort, außerhalb der Ruhezeit). Bis dahin steht nur „wer, welcher Tag, wann“ in
  der Warteschlange `timetable_notification_queue` (LK-90, ohne Inhalt); der Text wird beim Senden aus dem aktuellen Vertretungsplan gebaut,
  Eltern ohne Notiz wie bisher. Die Vertretungslehrkraft bekommt darin eine Erinnerung an noch nicht bestätigte Vertretungen (keine
  Eskalation, nur bei eingeschalteter Kenntnisnahme). Der Vertretungsplan selbst ist unverändert sofort sichtbar.
  Das Heute-Widget „Offen für dich“ (Q5-07) zeigt nur Zähler und eigene Vorgänge (eigene Kinder, eigene Briefe, eigene
  Klassen; Planungszahlen nur mit `stundenplan.substitute` (SP-02), Backup nur mit `verwaltung.system`) – keine Auswertung je Lehrkraft.
  Zeitwünsche (Q5-10) trägt eine Lehrkraft im Eingabefenster der Planung selbst ein – nur die eigenen, die Person kommt aus der
  Sitzung; die Planung sieht die Wünsche und „abgegeben ja/nein“ (für die Erinnerung vor der Frist), andere Lehrkräfte nichts.
- **Elternsprechtag** (P4-50…P4-54): Eltern sehen bei Lehrkräften nur „frei“/„belegt“, nie andere Familien; gebucht werden
  nur Lehrkräfte, die das Kind unterrichten (Stundenplan, Unterrichtsverteilung, Lerngruppen). Den Plan mit Namen (Schüler:in,
  Klasse, buchende Person) sieht nur die Lehrkraft selbst und wer Sprechtage verwaltet; die Verwaltungsübersicht zeigt je
  Lehrkraft nur Zahlen. Monitor „Sprechtag“, Raumliste und Suche zeigen nur Lehrkräfte und Räume. Volljährige mit dem
  Kennzeichen „eigenständig“ buchen selbst, ihre Eltern sehen Termine nur mit Einwilligung und nur lesend (Q5-05); auch ein
  vorher von den Eltern gebuchter Termin meldet sich danach nur noch bei der Person selbst (Erinnerung, Absage – G4D-S03). Mails
  (Gesprächswunsch, Erinnerung) nur an bestätigte Adressen, ohne Gesprächsanlass.
- **Kurswahlen** (P4-60…P4-65): Familien sehen nur die eigene Wahl und – erst nach der Übernahme in Gruppen – den eigenen
  Kurs, keine Wahlen anderer und keine Nachfrage. Gewählt wird je Verfahren von den Eltern (Minderjährige) oder von der
  Schüler:in (optional mit Eltern-Häkchen); Volljährige mit dem Kennzeichen „eigenständig“ wählen selbst, ihre Eltern sehen
  die Wahl nur mit Einwilligung und nur lesend (Q5-05). Alle Wahlen, Nachfrage und Zuteilung sieht nur, wer Kurswahlen
  verwaltet. Das Leserecht `kurswahl.view` (SP-05, Projektleitung 2026-10-19; Gruppe „Stundenplanung“, um Lehraufträge aus der
  Kurswahl anzulegen) zeigt nur Verfahren, Angebote, Teilnehmerzahlen, Nachfrage und Zugeteilte **je Angebot** und die übernommenen
  Gruppen – keine Wunschlisten, keine Zuteilung oder Begründung einzelner Schüler:innen, keine Übernahme-Vorschau (nennt Namen):
  für Lehraufträge (Gruppe, Fach, Stunden, Lehrkraft) braucht es keine Personenebene (Datensparsamkeit, Art. 5 Abs. 1 lit. c). Die Zuteilung ist deterministisch (Wünsche, Kapazitäten, Mindestgröße, Los mit protokolliertem Seed) und je
  Person begründet; Korrekturen von Hand stehen im Protokoll ohne Namen. Keine Prüfung der Belegungsvorschriften der Oberstufe.
  Erinnerungen an Nichtwähler nur als Gong, ohne Namen anderer.
- **Sitzpläne** (P5-01…P5-04): sehen und ändern nur Lehrkräfte der Lerngruppe und die Klassenleitung; im Klassenbuch-Eintrag zusätzlich, wer die Stunde an dem Tag hält (Vertretung). Schüler:innen, Eltern, Verwaltung und Admin ohne Bezug zur Gruppe sehen nichts (404). Am Platz Initialen, ein Foto nur als Profilbild mit Einwilligung (DS-09) und nur, solange die Moduleinstellung es erlaubt; der Druck enthält nie Fotos. Keine Bemerkungen zu Personen am Platz.
- **Notenbuch** (P5-10…P5-20, `PHASE5-NOTENBUCH.md`): Teilnoten, Kommentare und Notenschlüssel sehen und ändern nur die
  Fachlehrkräfte des Buchs (`notenbuch.own`, Mitlehrkräfte gleichberechtigt); eine Vertretung kommt nur über eine protokollierte
  Übertragung hinein (`notenbuch.transfer`, ohne Einsicht für die übertragende Person). Klassenleitung (automatisch für die eigene
  Klasse) und `notenbuch.term_view` (Schulleitung) sehen **nur Halbjahreswerte**, jeder Abruf steht im Audit-Log
  (`lesen.notenbuch`). Es gibt kein „alle sehen“, und das Admin-Recht `*` greift im Notenbuch **nicht** – Rechte zählen nur, wenn sie
  ausdrücklich vergeben sind; Admin-Konten (Rolle `admin` oder `*`) zählen nur das Übertragen, auch nicht über Gruppen (GATE-5a).
  Zwei-Faktor-Anmeldung ist für das Modul Pflicht (auch für Lehrkräfte, vor SEC-01) – und zwar für die **Sitzung**: das Notenbuch
  öffnet sich nur in einer Sitzung, die mit Code angemeldet wurde; das Einrichten von 2FA beendet alle anderen Sitzungen. Die
  **Auskunft** (Art. 15) enthält Teilnoten, Kommentare und Halbjahreswerte nur, wenn die erzeugende Person zusätzlich das
  ausdrückliche Recht `notenbuch.auskunft` hat (nie Admin-Konten; Lesevermerk im Protokoll) – sonst ohne diesen Teil, mit Hinweis,
  dass ihn eine berechtigte Person erteilt (Q-5A-29). Seiten werden nicht
  zwischengespeichert, Exporte nur per Knopf/POST mit Audit, keine Zeugnisse, Zeugnisbemerkungen oder § 50-Benachrichtigungen.
  Keine Statistik je Lehrkraft; der Notenspiegel einer Arbeit zeigt keine Namen. Startseiten-Widget, Kursraum und Suche verlinken nur
  eigene Bücher, ohne Noten (P5-16). **Vor der ersten Nutzung** (Lehrkräfte, Klassen-/Schulleitung, Rechte-Inhaber:innen) steht ein
  Datenschutzhinweis, der bestätigt werden muss (P5-17, `notenbuch_notice_acks`, je Fassung): Daten der Schule, Sichtbarkeit,
  Dienstgerät bzw. Genehmigung fürs Privatgerät (§ 2 Abs. 2 VO-DV I), keine Kopien außerhalb, keine Gesundheits-/Verhaltensangaben,
  Gerät sperren, 15-Minuten-Sperre, amtlich bleibt die Schulverwaltungssoftware. Bis dahin zeigen Seiten nichts, Actions und Export
  laufen nicht. Der Text für Nutzungsordnung bzw. Dienstanweisung steht als Baustein in der DSB-Checkliste (DSB-FRAGEN §15,
  Verwaltung → Datenschutz → Einrichtung). **Offline-Eingabe nur auf Dienstgeräten** (P5-20, § 2 Abs. 1 VO-DV I): Teilnoten lassen
  sich ohne Verbindung in einem verschlüsselten Zwischenspeicher des Browsers (IndexedDB, AES-GCM) weiterführen – nur, wenn die
  Moduleinstellung es erlaubt (Vorgabe: nur Geräte mit Gerätezertifikat der Schule; „Schulnetz“ zusätzlich mit Bestätigung je Gerät,
  dass es ein Dienstgerät ist) und nie von außen ohne Zertifikat (Privatgerät, § 2 Abs. 2 VO-DV I – dort bleibt nichts im Browser).
  Der Schlüssel entsteht nur aus einem nicht exportierbaren Geräteanteil **und** einem Anteil des Servers je Person und Gerät, der
  mit echtem Abmelden (SchulOS warnt vorher), Ausschalten, Rechteentzug oder spätestens nach 7 Tagen gelöscht wird – die
  15-Minuten-Sperre lässt ihn stehen; der Abgleich überschreibt nichts still (Konflikte je Zelle, bleiben bis zur Auflösung),
  abgeschlossene Halbjahre lehnen ab, jeder Abgleich steht ohne Noten im Audit-Log. An geteilten Dienstgeräten hat jedes Konto
  einen eigenen Zwischenspeicher.
- **Fotos von Mängeln** (Gebäude & Technik): nur Sachen fotografieren (Hinweis im Formular), höchstens 3 × 5 MB,
  nur JPEG/PNG/WebP, Metadaten werden beim Hochladen entfernt; Alarm-Mails bei „Gefahr“ enthalten keine Namen.
- **Prüfungen und Exporte** (Gebäude & Technik, P4-15…P4-19): Prüfnachweise ohne Personennamen (Firma statt
  Prüfer:in), Alarm-Mails zu überfälligen Prüfungen nur mit Prüfart, Gegenstand, Ort und Termin. CSV-Exporte der
  Meldungen und Prüfungen enthalten weder Namen noch Freitext (Beschreibungen, Bemerkungen), Statistik nur je
  Kategorie und Monat. Die Prüfarten-Vorlage (zwölf Prüfungen, Q-23) ist ausdrücklich „zu prüfen“ – SchulOS
  behauptet keine Rechtsverbindlichkeit der Fristen und Quellen.

---

## 6. Technische und organisatorische Maßnahmen (Art. 32)

| Bereich | Maßnahme | Stand |
|---|---|---|
| Transport | TLS überall (Caddy), HSTS; im Schulnetz eigene CA oder Let's Encrypt (siehe INSTALLATION.md) | ✅ |
| Passwörter | scrypt-Hashes (Better-Auth) | ✅ |
| Passwortregeln | 10–128 Zeichen ohne Zeichenklassen-Zwang; abgelehnt werden bekannte Passwörter (auch Grundwort + Zahlen wie „Passwort2026!“), Tastatur-/Zahlenfolgen, Wiederholungen und der eigene Name – offline, ohne externen Dienst. Startpasswörter der Verwaltung (Anlegen, Import, Zurücksetzen) müssen bei der ersten Anmeldung gewechselt werden, bis dahin keine Rechte; ein Wechsel meldet andere Geräte ab | ✅ |
| Zwei-Faktor | TOTP (Better-Auth-Plugin) mit 10 Wiederherstellungscodes **oder Sicherheitsschlüssel/Passkey** (WebAuthn, SEC-03 – nur als zweiter Faktor, Hinweis-Mail bei jeder Einrichtung), **Pflicht für Admin, Verwaltung, Beratung und alle mit Verwaltungsrechten** (Schulleitung) **oder Planungsrechten** (`stundenplan.manage`/`stundenplan.substitute`, z. B. Gruppe „Stundenplanung“ – Deputate aller Lehrkräfte, Abwesenheiten mit Grund „krank“; SP-02, Projektleitung 2026-10-19) sofort, **für Lehrkräfte, Personal und Eltern ab dem Stichtag der Schule** (SEC-01, vorher Hinweis), **für Schüler:innen bei Anmeldung von außerhalb des Schulnetzes** (Code-Liste vom Sekretariat für Kinder ohne Handy, SEC-02) – ohne Einrichtung keine Rechte; Ersteinrichtung nur im Schulnetz oder mit Freigabe (Eltern auch von außen), Hinweis-Mail an bestätigte Adressen; Zurücksetzen durch das Sekretariat (Recht `verwaltung.zwei_faktor`) beendet alle Sitzungen, Gong an Konto bzw. Eltern; Passwort vergessen per Mail nur mit 2FA (P4-70); Demo-Instanzen erzwingen nicht | ✅ |
| Sitzungen | Übersicht „Angemeldete Geräte“, einzelne Geräte oder überall abmelden; Abmelden nach Inaktivität als Einstellung je Schule (Vorgabe aus, ab 15 min) – P4-71 | ✅ |
| Brute-Force | Sperre nach Fehlversuchen: 5 je Benutzername (auch unbekannte) bzw. 30 je IP-Adresse in 15 min → 15 min gesperrt, als Better-Auth-Hook (Server Actions und HTTP); Kontosperren im Audit-Log (ohne IP), Hinweis in der Verwaltung mit „Sperre aufheben“; Rate-Limit für direkte `/api/auth`-Aufrufe; 2FA-Codes: Plugin-Sperre nach 10 Fehlversuchen. IP-Zählung braucht den Reverse-Proxy (X-Forwarded-For, B-18) | ✅ |
| Sitzungen | Ablauf nach Inaktivität, „überall abmelden“ | teilweise |
| Rechte | zentrale Rechte-Engine, jede Server Action prüft | ✅ |
| Header | CSP mit Nonce je Anfrage (`script-src` nur Nonce + `strict-dynamic`, kein `unsafe-inline`/`eval`; `style-src` erlaubt Inline-Attribute für Fach-/Schulfarben), `frame-ancestors 'self'`, `object-src 'none'`; `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, HSTS; kein `X-Powered-By`; Next-Telemetrie aus (`.env.production`); Sitzungs-Cookies httpOnly + SameSite=Lax, `Secure` bei HTTPS | ✅ |
| Uploads | Typ- und Größenprüfung; optional Virenscan (ClamAV-Container, P4-72: Dateien, Aufgaben, Gebäude-Fotos, Prüfprotokolle; Scan lokal, nach außen nur der Signatur-Download) | ✅ |
| Angriffserkennung | optional CrowdSec (SEC-15, Vorgabe aus): Caddy schreibt dafür ein Zugriffsprotokoll (IP-Adresse, Zeit, Pfad, Browserkennung) – **nur mit `SCHULOS_CROWDSEC=1`, höchstens 48 h** (Drehen alle 24 h, Tokens in Adressen maskiert – G4E-O11), Zweck Abwehr von Angriffen (Art. 6 Abs. 1 lit. e bzw. c i. V. m. Art. 32 DSGVO); Sperren gelten befristet. **Keine Weitergabe an die Community-Liste** (Online-API aus): wer sie einschaltet, übermittelt Adressen auffälliger Absender samt Szenario an den Anbieter (CrowdSec SAS, Frankreich) – nur nach Prüfung durch die bzw. den DSB und Eintrag im VVT | optional |
| Demo-Login | in Produktion nur mit Demo-DB **und** explizitem Schalter | ✅ |
| Speicherung | Datenträgerverschlüsselung (LUKS, TPM2/Passphrase) auf dem Server; beim qcow2-Abbild ohne LUKS (Hinweis in INSTALLATION.md); TPM2 an PCR 7+8+9 bzw. TPM2 + PIN, GRUB-Superuser (SEC-09) | ✅ (ISO) |
| Backups | eigener Backupserver: restic-Verschlüsselung, append-only für das Hauptsystem, Kopplung mit gepinnter CA, Aufbewahrung 14/4/3, wöchentliche Prüfung, monatlicher Test-Restore, Wiederherstellung nur mit Bestätigung im Hauptsystem (B-21…B-28, INSTALLATION.md §4); Offsite-Kopie mit 1:1-Schlüsseln (B-37); Test-Restore mit Wegwerf-Rolle statt Superuser (SEC-06); Arbeitsdateien (Dumps, entpackte Test-Restores) liegen in eigenen Volumes und werden nach spätestens 24 h gelöscht, auch nach einem Absturz (G4E-O18) | ✅ |
| Updates | Sicherheitsupdates des Betriebssystems automatisch, App-Updates mit Rollback (`schulosctl update`, Update-Test N−1 → N in der CI); **signierte Releases** (cosign) mit SBOMs, Offline-Bundle wird vor `docker load` geprüft (SEC-06); Release-Runner trennen: SEC-10 offen | ✅ |
| Abhängigkeiten | `npm audit` und Dependabot in CI, Container-Scan (Trivy), Secret-Scan (gitleaks) in der CI (B-53); Security-Review SEC-04…06 (2026-10-10) | ✅ |
| Datenpanne | Meldeweg im Betriebshandbuch (72 Stunden, Art. 33) | offen |

---

## 7. Organisatorisches Paket für die Schule

SchulOS liefert Vorlagen mit, die die Schule anpasst:

1. **Verzeichnis der Verarbeitungstätigkeiten**, erzeugt aus den aktiven Modulen (DS-07)
2. **DSFA-Entwurf.** Eine Folgenabschätzung ist bei einer Lernplattform mit Daten
   Minderjähriger in großem Umfang sehr wahrscheinlich nötig. Der Entwurf übernimmt Risiken und
   Maßnahmen aus diesem Dokument.
3. **Nutzungsordnung** für Schüler:innen und Eltern sowie **Dienstanweisung** für Lehrkräfte
   (angelehnt an die Muster des Schulministeriums); Bausteine je Thema stehen in der DSB-Checkliste (`baustein`, zuerst
   Notenbuch, P5-17)
4. **Auftragsverarbeitungsvertrag**, wenn nicht die Schule selbst betreibt, sondern der
   Schulträger oder ein Dienstleister. Wenn die Projektleitung eine Instanz betreut und dabei Zugriff auf
   Daten hat, ist auch er Auftragsverarbeiter.
5. **Betriebshandbuch:** Backup und Wiederherstellung, Updates, Datenpanne, Notfallkontakte

---

## 8. Offene Entscheidungen

- Gibt es eine konkrete Zielschule bzw. einen Piloten? Davon hängt ab, wie weit Stufe 2
  getrieben wird.
- Wer wäre Betreiber: die Schule selbst (Server im Schulgebäude), der Schulträger oder die Projektleitung als
  Dienstleister?
- ~~Open Source?~~ **Entschieden (2026-10-03):** Der ganze Stack ist quelloffen (Debian,
  Docker Engine, PostgreSQL 18, Caddy, restic, alle npm-Abhängigkeiten mit OSI-Lizenzen). Das
  Repo bleibt privat, bis das Projekt Form angenommen hat, und wird dann unter **AGPL-3.0**
  veröffentlicht. Vorher: Historie auf Geheimnisse prüfen und Lizenzprüfung in der CI.
