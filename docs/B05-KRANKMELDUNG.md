# B-05: Rechtliche Vorprüfung „Digitale Krankmeldungen“ (NRW)

*Stand 12.10.2026 – Arbeitsgrundlage für die Projektleitung und die/den DSB der Schule, **keine Rechtsberatung**. Wortlaute abgerufen am
12.10.2026 von recht.nrw.de und bass.schule.nrw. Umsetzung der Folgerungen: BACKLOG DS-16…DS-19; Restfragen für die DSB in
`DSB-FRAGEN.md`.*

## Kurzfazit

1. **„krank“ ist ein Gesundheitsdatum** (Art. 4 Nr. 15, Art. 9 Abs. 1 DSGVO) – auch ohne Diagnose. Sehr sicher.
2. **Die Rechtsgrundlage trägt:** Das SchulG NRW erklärt in **§ 122 Abs. 1 Satz 2** selbst, dass § 120 auf **Art. 9 Abs. 2
   lit. g** DSGVO beruht, und die **VO-DV I Anlage 1 Abschn. A Nr. II Ziff. 19.1** nennt „Schulversäumnis: Beginn, Ende,
   **Grund**“ ohne Sperrvermerk gegen automatisierte Verarbeitung. Sicherheit hoch (~80 %).
3. **Eigentliches Problem ist die Löschfrist:** Ein Runderlass (BASS 12-51 Nr. 5) ordnet schriftliche Entschuldigungen der
   Schülerakte zu – „Die Aufbewahrungsfrist beträgt fünf Jahre.“ SchulOS löscht die Meldung zum Schuljahresende (LK-SJ); ins
   Archiv geht nur „entschuldigt“ aus dem Klassenbuch.
4. **Offen ist die Form:** § 43 Abs. 2 verlangt die „schriftliche“ Mitteilung des Grundes; ob eine Meldung über ein angemeldetes
   Elternkonto das erfüllt, regelt keine NRW-Vorschrift ausdrücklich → Festlegung der Schule.
5. **Eine „Anlage zu digitalen Systemen“ gibt es in der VO-DV I nicht** (nur Anlagen 1–3). Für Plattformen gelten § 120 Abs. 5
   SchulG und § 2 VO-DV I.

## Begründung

### 1. Gesundheitsdatum

Art. 4 Nr. 15 DSGVO: Daten, „aus denen Informationen über deren Gesundheitszustand hervorgehen“; ErwG 35 zählt Informationen über
Krankheiten dazu. Der EuGH legt Art. 9 weit aus: C-101/01 *Lindqvist* (Hinweis auf Krankschreibung = Gesundheitsdatum), C-184/20
*OT* (auch mittelbar ableitbare Daten), C-252/21 *Meta*, C-21/23 *Lindenapotheke* (schon Bestelldaten rezeptfreier Apothekenware).
„Sonstiger Grund“ allein ist kein Gesundheitsdatum, steht aber im selben Datensatz – die ganze Tabelle `absence_reports` wie
Art.-9-Daten schützen (tut SchulOS bereits).

### 2. Rechtsgrundlage (Art. 6 + Art. 9 Abs. 2, EuGH C-667/21)

- **§ 120 Abs. 1 SchulG NRW** (BASS 1-1, zuletzt geändert 21.07.2026): „Schulen … dürfen personenbezogene Daten der Schülerinnen
  und Schüler … sowie der Eltern verarbeiten, soweit dies zur Erfüllung der ihnen durch Rechtsvorschrift übertragenen Aufgaben
  erforderlich ist. Die gespeicherten personenbezogenen Daten dürfen in der Schule nur den Personen zugänglich gemacht werden, die
  sie für die Erfüllung ihrer Aufgaben benötigen.“
- **§ 122 Abs. 1 Satz 2 SchulG NRW** (entscheidend): „§ 120 und § 121 sowie die nachfolgenden Absätze 2 bis 4 beruhen auf
  Artikel 6 Absatz 1 Satz 1 Buchstabe e, Absatz 3 und Artikel 9 Absatz 2 Buchstabe g der genannten Verordnung.“
  → DATENSCHUTZ.md §1 („§ 122 ist nur Verordnungsermächtigung“) ist zu korrigieren.
- **Aufgabe, § 43 Abs. 2 SchulG:** „Ist eine Schülerin oder ein Schüler durch Krankheit oder aus anderen nicht vorhersehbaren
  Gründen verhindert, die Schule zu besuchen, so benachrichtigen die Eltern unverzüglich die Schule und teilen schriftlich den
  Grund für das Schulversäumnis mit. …“
- **VO-DV I** (Fassung ab 01.08.2022): § 1 Abs. 2 (zugelassene Daten in den Anlagen, Sperren gekennzeichnet); **Anlage 1
  Abschn. A Nr. II** „18. Beurlaubung: Beginn, Ende, Grund“, „19. Schulversäumnis: 19.1 Beginn, Ende, Grund; 19.2 Benachrichtigung
  zur Schulpflichtüberwachung …“ – ohne Sperrvermerk; Sperrvermerk `**`: „Medizinische Gutachten und Atteste … dürfen nicht
  automatisiert verarbeitet werden.“ Anlage 2 I Nr. 1 (Klassenbuch: „Vermerk über Schulversäumnisse, Verspätungen“), II Nr. 1
  (Schülerakte).
- **Erhebliches öffentliches Interesse:** Schulpflichtüberwachung, RdErl. BASS 12-51 Nr. 5 Nr. 3 („lückenlose und zeitnahe
  Feststellung und Dokumentation von Fehlzeiten“).
- **Angemessene und spezifische Maßnahmen:** § 120 Abs. 1 Satz 2 SchulG (Zugriff), VO-DV I § 1 Abs. 3, § 2 Abs. 1, § 9, Sperre
  für Atteste; im Übrigen **§ 15 DSG NRW** (u. a. Nr. 2 Nachprüfbarkeit, Nr. 4 Zugangsbeschränkung, Nr. 6 Verschlüsselung, Nr. 8
  regelmäßige Überprüfung).
- **BDSG gilt nicht** (§ 1 Abs. 1 Satz 1 Nr. 2 BDSG; Schulen sind öffentliche Stellen nach § 5 Abs. 1 Satz 2 DSG NRW).
- Lit. h (Gesundheitsversorgung), lit. b (Arbeitsrecht) und Einwilligung passen nicht (Meldepflicht der Eltern).

### 3. Form („schriftlich“)

§ 43 Abs. 2 SchulG und RdErl. BASS 12-52 Nr. 1 Nr. 2.2 („… von den Eltern schriftlich zu entschuldigen“). Eine Regel zur
elektronischen Form wurde nicht gefunden. Einschätzung: Eine Meldung über ein persönliches, angemeldetes Elternkonto mit
Zeitstempel und Protokoll erfüllt den Nachweiszweck eher besser als ein Zettel – ausdrücklich geregelt ist es nicht (Sicherheit
mittel). Manche Schulen werten Online-Meldungen nur als Benachrichtigung und verlangen Papier.

### 4. Löschfrist – der Konflikt

- **§ 9 Abs. 1 VO-DV I:** Nr. 3 Klassenbuch/Kursbuch 10 Jahre, Nr. 4 „alle übrigen Daten 5 Jahre“; Fristbeginn mit Ablauf des
  Kalenderjahres des Abschlusses, „jedoch nicht vor Ablauf des Kalenderjahres, in dem die Schulpflicht endet“.
- **BASS 12-51 Nr. 5 Nr. 3:** „Dies gilt auch für schriftliche Entschuldigungen und vorgelegte Atteste als Teil der Schülerakte
  (Schülerbegleitmappe). Schriftliche Entschuldigungen und Atteste sind übrige Daten im Sinne von § 9 Absatz 1 Nummer 4 VO-DV I.
  Die Aufbewahrungsfrist beträgt fünf Jahre.“
- SchulOS (DATENSCHUTZ.md §3.2) löscht bei Zweckwegfall – für Entschuldigungen widerspricht das dem Erlass, **sobald die digitale
  Meldung die schriftliche Entschuldigung ersetzt**. `src/modules/klassenbuch/archiv.ts` exportiert nur „entsch./unentsch.“.

## Nicht im Wortlaut geprüft

EuGH-Urteile (sinngemäß, Randnummern vor Weitergabe prüfen); DSGVO-Texte nicht neu abgerufen (Standardwortlaut); § 15 und § 5
DSG NRW über lexmea.de statt recht.nrw.de; Art. 8 LV NRW und § 3a VwVfG NRW nicht gelesen; Fußnote 2 zu Anlage 1 Ziff. 13 fehlt
im PDF; keine behördliche Handreichung (MSB/LDI) speziell zu Krankmeldungen per App gefunden.

## Folgerungen für SchulOS

**Bereits erfüllt:** nur „krank“/„sonstiges“, kein Freitext, Hinweis „keine Diagnose“; kein Attest-Upload (passt zur Sperre);
Grund sehen nur Klassenleitung, `abwesenheiten.manage`, meldende Eltern, Admins – Fachlehrkräfte nur entschuldigt/unentschuldigt;
Meldungen, Entscheidungen und Eltern-Einsicht protokolliert; keine automatische Meldung an Behörden.

**Ändern (BACKLOG):**
- **DS-16** Entschuldigungen archivieren: `absence_reports` (Zeitraum, Grund, meldende Person, Zeitpunkt, Entscheidung) als eigener
  Teil „Entschuldigungen“ in den Archivexport mit 5-Jahres-Frist (Beginn frühestens Ende der Schulpflicht); im laufenden System
  weiter kurz löschen. Schalter „Digitale Meldung gilt als schriftliche Entschuldigung: ja/nein“.
- **DS-17** Rechtsgrundlagen korrigieren: Manifest-`legalBasis` + DATENSCHUTZ.md §1/§3 (§ 122 Abs. 1 Satz 2; Anlage 1 Abschn. A
  Nr. II Ziff. 18/19.1, Anlage 2 I Nr. 1, II Nr. 1; Beurlaubung = § 43 **Abs. 4**, nicht Abs. 3; keine „Anlage zu digitalen
  Systemen“ – § 120 Abs. 5 SchulG, § 2 VO-DV I).
- **DS-18** Eltern-Hinweis nach Art. 13 im Meldeformular (Rechtsgrundlage, Aufbewahrung, wer den Grund sieht, „Atteste nicht über
  Messenger/Dateien schicken“) und Sichtbarkeitsliste in DATENSCHUTZ.md/DSB-FRAGEN vollständig.
- **DS-19** Volljährige (§ 123 Abs. 2 SchulG): Selbstmeldung in `reportAbsence`, `parentView` filtert Volljährige – zusammen mit
  Q5-05.

**Entscheidet die Schule/DSB:** digitale Meldung = „schriftlich“? (davon hängt DS-16 ab); Beurlaubung bis 2 Tage durch die
Klassenleitung nur mit Übertragung durch die Schulleitung (§ 43 Abs. 4, BASS 12-52 Nr. 1 Nr. 5.1); darf `admin` Gründe sehen;
Verschlüsselung der gespeicherten Daten im Betrieb aktiv (§ 15 Nr. 6 DSG NRW)?

## Restfragen nur für die DSB

1. Gilt die Meldung über ein Elternkonto als „schriftlich“ (§ 43 Abs. 2 SchulG, BASS 12-52 Nr. 1 Nr. 2.2)?
2. Archivexport der Entschuldigungen mit 5 Jahren (Beginn frühestens Ende der Schulpflicht) – oder Papierweg mit kurzer Löschung?
3. Lese-Protokoll der Eltern-Einsicht vs. § 2 Abs. 1 Satz 3 VO-DV I („Protokolldaten nur … soweit zum Betrieb technisch
   erforderlich“) und § 15 Nr. 2 DSG NRW?
4. Bestätigung der Lesart „§ 122 Abs. 1 Satz 2 + § 120 Abs. 1 + Anlage 1 Ziff. 19.1 = Grundlage nach Art. 9 Abs. 2 lit. g“ und
   Eintrag ins VVT?

## Quellen (abgerufen 12.10.2026)

- SchulG NRW (BASS 1-1): https://bass.schul-welt.de/6043.htm
- VO-DV I ab 01.08.2022: https://recht.nrw.de/lrgv/rechtsverordnung/01082022-verordnung-ueber-die-zur-verarbeitung-zugelassenen-daten-von/
  · Anlage 1: https://recht.nrw.de/system/files/BA/10526-47195-sgv_223_20070614_1_anlage1.pdf
  · Anlage 2: https://recht.nrw.de/system/files/BA/10526-46574-sgv_223_20070614_1_anlage2.pdf
  · Anlage 3: https://recht.nrw.de/system/files/BA/10526-46575-sgv_223_20070614_1_anlage3.pdf
  · BASS 10-44 Nr. 2.1: https://bass.schule.nrw/pdf/101.pdf
- RdErl. „Teilnahme am Unterricht …“ BASS 12-52 Nr. 1: https://bass.schule.nrw/15402.htm
- RdErl. „Überwachung der Schulpflicht“ BASS 12-51 Nr. 5: https://bass.schule.nrw/6958.htm · Änderung: https://bass.schule.nrw/19365.htm
- DSG NRW § 15: https://lexmea.de/de/gesetz/dsg-nrw/15 · § 5: https://lexmea.de/de/gesetz/dsg-nrw/5
- BDSG § 1: https://www.gesetze-im-internet.de/bdsg_2018/__1.html
- Hintergrund: https://datenschutz-schule.info/2022/09/12/entschuldigungen-aufbewahrungspflicht/ ·
  https://www.taylorwessing.com/de/insights-and-events/insights/2024/10/ecj-lindenapotheke
