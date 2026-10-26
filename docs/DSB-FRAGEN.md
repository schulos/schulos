# DSB-Checkliste für die Schule (DS-11, DS-13)

Arbeitsliste für die bzw. den **Datenschutzbeauftragte(n) der Schule**, vor dem Start mit echten Daten durchzugehen.
Grundsatz: Die Schule ist Verantwortliche nach Art. 4 Nr. 7 DSGVO und entscheidet; SchulOS liefert sichere Vorgaben und
Werkzeuge, ohne Gewähr (AGPL-3.0 §§ 15–16). Alle Rechtsaussagen hier sind Planungsannahmen – zu prüfen.

So ist jedes Thema aufgebaut:

- **Kurzfassung** (Tabelle): was SchulOS tut, welche Vorgabe gilt, was die Schule entscheiden bzw. dokumentieren muss, wo das in
  SchulOS einzustellen ist. Die Tabellen werden aus `src/core/privacy/checkliste.ts` erzeugt (`npx tsx scripts/dsb-checkliste.ts`) –
  dieselbe Liste steht als abhakbare Punkte unter **Verwaltung → Datenschutz → Einrichtung** (DS-12, Status „Vorgabe übernommen /
  geändert / mit DSB geklärt“ + Bemerkung, Nachweis als Druck/JSON). `checkliste.test.ts` schlägt an, wenn Doku und Oberfläche
  auseinanderlaufen.
- **Hintergrund und Fragen**: Kontext, konkrete Frage, Vorschlag von SchulOS und Stand der Umsetzung. Antworten der DSB hier
  eintragen (Datum, wer) bzw. in der Einrichtung als Bemerkung festhalten.

Die Nummern bleiben stabil (Verweise wie „DSB-FRAGEN §8“ im Code und in der Doku); neue Themen kommen hinten dazu.

---

## 0. Verantwortung und Datenschutzbeauftragte:r

<!-- dsb:verantwortung -->
| Punkt | |
|---|---|
| Was SchulOS tut | Erzeugt Datenschutzhinweise und VVT als Vorlage aus den eingeschalteten Modulen; nennt die Schule als Verantwortliche. |
| Vorgabe | Ohne Angaben der Schule bleiben Verantwortliche Stelle, DSB und Betrieb leer und die Einrichtung offen. |
| Die Schule entscheidet / dokumentiert | Bestätigt, dass sie Verantwortliche nach Art. 4 Nr. 7 DSGVO ist, trägt DSB (Name/Kontakt), Betreiber und Aufsichtsbehörde ein; klärt Auftragsverarbeitung, wenn der Schulträger oder ein Dienstleister betreibt. |
| In SchulOS | Verwaltung → Datenschutz → Hinweise und VVT |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: DS-12, DS-14)

- **Kontext:** SchulOS ist ein Lern-/Demoprojekt ohne Gewähr; Betrieb in eigener Verantwortung der Schule (DS-14). Die
  Datenschutz-Einrichtung (DS-12) bleibt offen, bis die Schule ihre Rolle bestätigt und die DSB benannt hat.
- **Frage:** Wer betreibt den Server (Schule, Schulträger, Dienstleister), und braucht es einen Auftragsverarbeitungsvertrag?
- **Vorschlag:** Betrieb durch die Schule bzw. den Schulträger; mit Dienstleister AV-Vertrag nach Art. 28 DSGVO (DATENSCHUTZ.md §7).

## 1. Krankmeldungen als Gesundheitsdaten (Art. 9)

<!-- dsb:krankmeldungen -->
| Punkt | |
|---|---|
| Was SchulOS tut | Speichert bei Abwesenheiten nur „krank“ oder „sonstiger Grund“, nie eine Diagnose; kein Freitext mit Gesundheitsbezug, kein Attest-Upload. Den Grund sehen nur Klassenleitung, Personen mit „Alle Abwesenheiten bearbeiten“ (z. B. Schulleitung), alle verknüpften Eltern minderjähriger Kinder bzw. die eigenständige Person selbst und – nur bei der Aufnahme – das Sekretariat bei Telefonmeldungen; Admin-Konten (technische Betreuung) sehen Zeitraum und Stand, aber keinen Grund (DS-20); Fachlehrkräfte nur „entschuldigt“/„nicht entschuldigt“. Hinweis nach Art. 13 am Melde- und Beurlaubungsformular. |
| Vorgabe | Mindestangabe „krank“/„sonstiger Grund“; die digitale Meldung gilt als schriftliche Entschuldigung (DS-16): eigener Teil „Entschuldigungen“ im Archivexport (5 Jahre), im System bis zur Übergabe des Exports, der die Meldung enthält (Löschvorschau: „zurückgehalten“), sonst Löschung zum Schuljahresende (LK-SJ). |
| Die Schule entscheidet / dokumentiert | Bestätigt die Lesart § 120 Abs. 1, § 122 Abs. 1 Satz 2, § 43 Abs. 2 SchulG NRW + VO-DV I Anlage 1 Ziff. 19.1 als Grundlage nach Art. 9 Abs. 2 lit. g DSGVO und dokumentiert sie im VVT; legt fest, ob die Meldung über SchulOS als schriftliche Entschuldigung gilt (sonst „nein“: Eltern entschuldigen zusätzlich auf Papier); vergibt „Alle Abwesenheiten bearbeiten“ sparsam (Admin-Konten sehen die Gründe nicht – dafür das Recht ausdrücklich vergeben). |
| Einstellungen | „Digitale Meldung gilt als schriftliche Entschuldigung“ (Vorgabe: ja – Archiv „Entschuldigungen“, 5 Jahre) |
| In SchulOS | Verwaltung → Rechte & Module → Abwesenheiten |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: B-05)

- **Kontext:** Das Modul Abwesenheiten speichert „krank“ bzw. „sonstiger Grund“ – bewusst ohne Diagnose, Freitext mit
  Gesundheitsbezug ist ausgeschlossen (`CLAUDE.md`). Schon „krank“ ist aber ein Gesundheitsdatum nach Art. 9 Abs. 1 DSGVO.
- **Frage:** Reicht § 120 Abs. 1 i. V. m. § 43 Abs. 2 SchulG NRW als „spezifische Regelung“ nach Art. 9 Abs. 2 lit. g DSGVO für
  Krankmeldungen (nur „krank“/„sonstiger Grund“, keine Diagnose)?
- **Unser Vorschlag:** Ja, weil die Schule Fehlzeiten und Entschuldigungen ohnehin führen muss und wir nur die Mindestangabe
  speichern. Sonst: Krankmeldung nur als „entschuldigt/unentschuldigt“ ohne Grund.
- **Vorprüfung (12.10.2026, Wortlaute in `docs/B05-KRANKMELDUNG.md`):** Die Grundlage trägt – § 122 Abs. 1 Satz 2 SchulG NRW
  erklärt § 120 selbst zur Regelung nach Art. 9 Abs. 2 lit. g, und VO-DV I Anlage 1 Abschn. A Nr. II Ziff. 19.1 lässt
  „Schulversäumnis: Beginn, Ende, Grund“ automatisiert zu. Offen für die DSB: (1) Gilt die Meldung über ein Elternkonto als
  „schriftlich“ (§ 43 Abs. 2)? (2) Entschuldigungen 5 Jahre aufbewahren (BASS 12-51 Nr. 5 Nr. 3) – Archivexport (DS-16) oder
  Papierweg? (3) Lese-Protokoll vs. § 2 Abs. 1 Satz 3 VO-DV I / § 15 Nr. 2 DSG NRW? (4) Lesart bestätigen und ins VVT eintragen.

## 2. VO-DV I und ihre Anlagen

<!-- dsb:vo-dv -->
| Punkt | |
|---|---|
| Was SchulOS tut | Ordnet jede Tabelle mit Personenbezug einem Zweck und einer Löschklasse zu; Module lassen sich einzeln abschalten. |
| Vorgabe | Alle Module der Demo-Auswahl eingeschaltet; Datenfelder nach Datensparsamkeit. |
| Die Schule entscheidet / dokumentiert | Gleicht Datenfelder und Module mit den Anlagen der VO-DV I ab und schaltet nicht Abgedecktes ab bzw. holt Einwilligungen ein. |
| In SchulOS | Verwaltung → Rechte & Module |
<!-- /dsb -->

**Hintergrund und Fragen**

- **Kontext:** Die VO-DV I hat nur die Anlagen 1–3 (Wortlaut geprüft 12.10.2026, `B05-KRANKMELDUNG.md`); eine eigene Anlage zu
  digitalen Systemen gibt es nicht – für Plattformen gelten § 120 Abs. 5 SchulG NRW und § 2 VO-DV I (DS-17). Fehlzeiten und
  Beurlaubungen sind in Anlage 1 Abschn. A Nr. II Ziff. 18/19.1 ausdrücklich zugelassen.
- **Frage:** Decken die Anlagen die Datenfelder und Verarbeitungszwecke von SchulOS ab (Kontakt-/Stammdaten, Klassenbuch,
  Messenger, Foren, Kursraum, Dateien, Umfragen)? Welche Felder oder Module sind nicht zugelassen oder brauchen eine Einwilligung?
- **Unser Vorschlag:** Die Anlagen gemeinsam durchgehen und das Ergebnis in das Verzeichnis der Verarbeitungstätigkeiten
  (Generator DS-07) und in `retention` der Manifeste übernehmen; nicht Abgedecktes standardmäßig ausschalten.

## 3. Schulanmeldung

<!-- dsb:anmeldung -->
| Punkt | |
|---|---|
| Was SchulOS tut | Öffentliches Formular mit E-Mail-Bestätigung; erhebt nur, was Termin und Gespräch brauchen; Auskunft ohne Konto per Vorgangsnummer. |
| Vorgabe | Unbestätigte Anträge 48 h, abgelehnte/Warteliste Verfahrensabschluss + 60 Tage (je Verfahren 31–365), zurückgezogene/übernommene 90 Tage. |
| Die Schule entscheidet / dokumentiert | Entscheidet über Felder (Empfehlung, Anschrift), Fristen je Verfahren, Information von Elternteil 2, Identitätsprüfung bei Auskunft und Impressum. |
| In SchulOS | Verwaltung → Schulanmeldung |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Phase 4c)

Gemeinsamer Kontext: öffentliches Formular mit E-Mail-Bestätigung, Erhebung von Daten von Eltern, deren Kind noch nicht
Schüler:in ist (Erforderlichkeit für das Aufnahmeverfahren, § 46 SchulG). Leitlinie ist Datensparsamkeit (`docs/PHASE4.md`).

### 3a. Grundschulempfehlung (Q-31)
- **Kontext:** Wird in V1 nicht online abgefragt; die Gesamtschule braucht sie für die Heterogenität der Klassen.
- **Frage:** Darf sie später als freiwillige Auswahl („Hauptschule/Realschule/Gymnasium/eingeschränkt“) online erhoben werden?
- **Unser Vorschlag:** Nein online; Zeugnis und Empfehlung nur im persönlichen Gespräch zeigen lassen. Als Verfahrensoption
  vorbereiten, aber nur mit Votum.

### 3b. Löschfrist abgelehnter und Wartelisten-Anträge (Q-36)
- **Kontext:** Aktuell Verfahrensabschluss + 60 Tage (Widerspruchsfrist 1 Monat + Puffer), einstellbar bis 1 Jahr.
- **Frage:** Ist die Frist angemessen? Gilt für Wartelisten etwas anderes?
- **Unser Vorschlag:** 60 Tage; Warteliste bis zum Verfahrensabschluss des Schuljahres, danach ebenfalls 60 Tage.
- **Ergänzung (P4-42), weitere Fristen:** unbestätigte Anträge werden 48 h nach Eingang vollständig gelöscht; zurückgezogene
  90 Tage nach der Rücknahme, übernommene 90 Tage nach der Übernahme (die Daten leben dann im Konto). Sind 90 Tage für
  zurückgezogene Anträge zu lang (Vorschlag: so lassen – Rückfragen „war die Anmeldung angekommen?“)? Gilt für die interne
  Notiz zur Entscheidung dieselbe Frist?

### 3c. Elterndaten vor der Aufnahme
- **Kontext:** Vor der Aufnahme gibt es kein Schulverhältnis; erhoben werden Name Elternteil 1 (Pflicht), Elternteil 2
  (optional), E-Mail, Telefon, Hinweise für das Gespräch (max. 300 Zeichen, „keine Gesundheitsdaten“). Nicht online: Religion,
  Förderbedarf, Staatsangehörigkeit/Herkunftssprache, Masernnachweis, Sorgerecht.
- **Frage:** Ist die Erhebung dieser Felder als Vorbereitung des Aufnahmeverfahrens gedeckt? Genügt der Datenschutzhinweis
  (Art. 13) mit Pflicht-Checkbox, oder ist eine Einwilligung nötig? Muss Elternteil 2 informiert werden?
- **Unser Vorschlag:** Erforderlichkeit nach § 46 SchulG plus Art. 13-Hinweis; Elternteil 2 nur auf Angabe der Eltern.
- **Ergänzung 2026-10-11 (Q5-23, umgesetzt):** Das Formular fragt optional auch die E-Mail-Adresse von Elternteil 2 ab – nur
  zusammen mit dessen Namen und einem Pflicht-Haken „Der zweite Elternteil weiß von dieser Angabe und kennt die
  Datenschutzhinweise“. Während des Verfahrens geht keine Mail an diese Adresse (Bestätigungs-, Termin- und Entscheidungsmails
  nur an Elternteil 1, der den Antrag per Link bestätigt). Bei der Übernahme bekommt Elternteil 2 ein eigenes Elternkonto
  **ohne** die Adresse (Platzhalter – GATE-031: sie ist nie von Elternteil 2 bestätigt, ein Tippfehler darf weder ein fremdes
  Konto verknüpfen noch die Adresse für die echte Inhaberin blockieren); ein Konto bzw. ein anderer Antrag mit derselben
  Adresse wird nur als Vorschlag zum Ankreuzen gezeigt. Die Adresse liegt im Antrag (gleiche Löschfrist), steht im VVT und
  optional im CSV-Export (nicht vorausgewählt). Die Auskunft findet Anträge auch per Adresse von Elternteil 2, gibt dann
  aber nur dessen eigene Angaben, Vorgangsnummer, Verfahren und Stand heraus (keine Daten von Elternteil 1 und Kind).
  **Zusatzfrage:** Genügt der Haken als Information von Elternteil 2 (Art. 14 Abs. 5 lit. a bzw. Information durch Elternteil 1),
  oder soll SchulOS Elternteil 2 nach der Bestätigung selbst eine kurze Info-Mail schicken?

### 3d. Anschrift
- **Kontext:** Die Anschrift wird für das Schulweg-Kriterium und den Bescheid erhoben.
- **Frage:** Ist die Anschrift online beim ersten Kontakt erforderlich, oder reicht sie erst im Gespräch bzw. beim Bescheid?
- **Unser Vorschlag:** Erst im Gespräch erfassen, wenn die Schule kein Entfernungskriterium anwendet; sonst online als Pflicht.

### 3e. Auskunft ohne Konto (P4-42)
- **Stand 2026-10-11:** Projektleitung hat JSON als Auskunftsformat (neben dem Anmeldebogen-Druck) bestätigt; die Frage an die/den DSB bleibt bestehen.
- **Kontext:** Anträge über das öffentliche Formular hängen an keinem Konto. Das Sekretariat sucht per Vorgangsnummer oder
  E-Mail-Adresse und gibt den Antrag als JSON heraus (alle Angaben, Termin, Unterlagen-Häkchen, Entscheidung, Verlauf;
  Handlungen der Schule ohne Namen von Beschäftigten).
- **Frage:** Wie prüft die Schule die Identität? Reicht die Antwort an die im Antrag hinterlegte E-Mail-Adresse (bzw. Abholung
  persönlich mit Ausweis)? Ist JSON als „gängiges elektronisches Format“ (Art. 15 Abs. 3) zumutbar, oder braucht es zusätzlich
  eine lesbare Fassung (PDF/Druck)?
- **Unser Vorschlag:** Antwort nur an die hinterlegte Adresse oder persönlich; JSON plus Anmeldebogen-Druck als lesbare Fassung.

### 3f. Interne Notizen in der Auskunft
- **Kontext:** Das Sekretariat kann interne Notizen zum Antrag schreiben („Zeugnis im Original gesehen“), die Schulleitung eine
  Notiz zur Entscheidung. Beides ist für Eltern sonst nicht sichtbar.
- **Frage:** Gehören diese Notizen in die Auskunft (wir: ja, Art. 15 erfasst alle Daten zur Person), oder gibt es Ausnahmen
  (z. B. laufendes Widerspruchsverfahren)?
- **Unser Vorschlag:** Immer mit ausgeben; im Notizfeld steht der Hinweis „keine Gesundheitsdaten, Eltern können Auskunft verlangen“.

### 3g. Öffentliche Seiten und Außenzugang (P4-40)
- **Kontext:** Für die Anmeldung sind wenige Seiten aus dem Internet erreichbar (`SCHULOS_PUBLIC_ACCESS=oeffentliche-seiten`),
  alles andere bleibt im Schulnetz. Die IP-Adresse wird nur gekürzt und gehasht für Rate-Limits verwendet (Zähler im Zeitfenster,
  dann gelöscht); Caddy schreibt kein Zugriffsprotokoll; kein Captcha eines Drittanbieters, keine externen Schriften.
- **Frage:** Reicht der Datenschutzhinweis (Art. 13) auf der Anmeldeseite für diese technische Verarbeitung? Muss das Impressum
  (§ 5 DDG) bestimmte Pflichtfelder haben, die SchulOS prüfen soll (heute ein Freitextfeld, Frage P4-33)?
- **Unser Vorschlag:** Ja, ein Absatz „Technik der öffentlichen Seiten“ in den Datenschutzhinweisen der Schule (Freitext);
  Impressum als Freitext mit Hinweis auf die Pflichtangaben.
- **Stand 2026-10-11 (Q5-22):** Das Impressum besteht jetzt aus einzelnen Feldern (Name, Rechtsform, Anschrift, Vertretung,
  E-Mail, Telefon als Pflicht; Schulträger, Aufsichtsbehörde, Register, USt-IdNr., weitere Angaben optional). Ohne vollständige
  Pflichtfelder lässt sich keine Schulanmeldung veröffentlichen. Ob die Felder für die Schule genügen, prüft die Schule.

## 4. Hausmeister-Fotos und Beschäftigte des Schulträgers

<!-- dsb:schultraeger -->
| Punkt | |
|---|---|
| Was SchulOS tut | Mängelfotos nur von Sachen (Hinweis), EXIF entfernt, nur für Zuständige sichtbar; Rolle Personal ohne Schülerverzeichnis. |
| Vorgabe | Fotos gehen mit der Meldung (1 Jahr nach Abschluss). |
| Die Schule entscheidet / dokumentiert | Regelt mit dem Schulträger die Verantwortung für dessen Beschäftigte (ggf. Vereinbarung), bevor Konten angelegt werden. |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Q-24)

- **Kontext:** Mängelmeldungen (4b) mit bis zu 3 Fotos je 5 MB, Metadaten (EXIF) werden entfernt, „nur Sachen, keine
  Personen“. Die Rolle `personal` umfasst Hausmeisterei und IT des Schulträgers – also Beschäftigte des Schulträgers, nicht des
  Landes.
- **Frage:** Reicht das Hinweis- und Löschkonzept gegen versehentlich abgebildete Personen? Wer ist für diese Beschäftigten
  verantwortlich und braucht es eine Vereinbarung mit dem Schulträger?
- **Unser Vorschlag:** Hinweis am Upload, Fotos nur für Zuständige sichtbar, Löschfrist mit Abschluss der Meldung; Regelung mit
  dem Schulträger vor Einrichtung der Konten.

## 5. Web-Push

<!-- dsb:web-push -->
| Punkt | |
|---|---|
| Was SchulOS tut | Kein Push über Dienste der Browserhersteller; Benachrichtigungen nur im Gong bzw. per Mail über den eigenen SMTP-Weg. |
| Vorgabe | Kein Push. |
| Die Schule entscheidet / dokumentiert | Entscheidet nur, falls Push später kommt: opt-in je Gerät, Nachricht ohne Namen und Inhalt. |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Q-50)

- **Kontext:** Push-Benachrichtigungen laufen über die Push-Dienste der Browserhersteller (Metadaten an Dritte,
  Nutzlast verschlüsselt) und widersprechen dem Grundsatz „keine Drittanbieter zur Laufzeit“ (DATENSCHUTZ §5). Die
  installierbare App (PWA) kommt in 4e ohne Push.
- **Frage:** Ist Push nur mit Einwilligung (opt-in je Gerät) und ohne Inhalte in der Nachricht vertretbar?
- **Unser Vorschlag:** Vorerst kein Push. Falls später: opt-in, Nachricht nur „Neue Nachricht in SchulOS“ ohne Namen oder
  Inhalt, Abschalten jederzeit.

## 6. Anonymität auf Datenbankebene

<!-- dsb:anonymitaet -->
| Punkt | |
|---|---|
| Was SchulOS tut | Anonyme Umfragen sind gegenüber allen Nutzenden anonym (Ergebnisse ab 5, in Fünferschritten); direkter Datenbankzugriff könnte Teilnahme und Antwort verknüpfen. |
| Vorgabe | Datenbankzugriff nur über die Wartungsrolle (TOM). |
| Die Schule entscheidet / dokumentiert | Beschränkt und protokolliert den Datenbankzugriff im Betrieb und legt die Grenze im Hinweis der Umfrage offen. |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: DATENSCHUTZ §5, „Grenze“)

- **Kontext:** Anonyme Umfragen sind für alle Nutzenden der Plattform (auch Admin-Oberfläche, Exporte, Auskunft) anonym.
  Wer direkt auf die Datenbank zugreift (Superuser, Betrieb), könnte Teilnahme und Antwort über Systemspalten derselben
  Transaktion verknüpfen.
- **Frage:** Genügt „anonym gegenüber der Plattform, Zugriff auf die Datenbank technisch-organisatorisch beschränkt“, oder muss
  die Verknüpfung auch dort ausgeschlossen sein?
- **Unser Vorschlag:** Genügt, wenn der Datenbankzugriff in den TOM (§6) beschränkt und protokolliert ist und die Umfrage dies
  im Hinweis offenlegt; sonst Teilnahme und Antwort in getrennten Transaktionen mit entkoppelten Zeitpunkten.

## 7. Barrierefreiheitserklärung

<!-- dsb:barrierefreiheit -->
| Punkt | |
|---|---|
| Was SchulOS tut | Liefert eine Vorlage mit dem Prüfergebnis (Block 4e). |
| Vorgabe | Noch keine Erklärung veröffentlicht. |
| Die Schule entscheidet / dokumentiert | Ergänzt Kontakt und Schlichtungsstelle und veröffentlicht die Erklärung, falls sie als öffentliche Stelle dazu verpflichtet ist. |
<!-- /dsb -->

**Hintergrund und Fragen**

- **Kontext:** Erklärung und Prüfung folgen in 4e (Q-51).
- **Frage:** Besteht für eine Schule als öffentliche Stelle die Pflicht zur Erklärung, und welche Mindestangaben braucht sie?
- **Unser Vorschlag:** Vorlage mit Prüfergebnis aus 4e bereitstellen, die Schule ergänzt Kontakt und Schlichtungsstelle.

## 8. Schulsozialarbeit: Beratungsgeheimnis und Träger

<!-- dsb:beratung -->
| Punkt | |
|---|---|
| Was SchulOS tut | Rolle Beratung ohne Fallakte; Chats mit Schüler:innen/Eltern nur zur Terminabsprache, nur von deren Seite begonnen, kürzere Löschfrist. |
| Vorgabe | Chat mit der Schulsozialarbeit aus; eingeschaltet Löschung 90 Tage nach der letzten Nachricht. |
| Die Schule entscheidet / dokumentiert | Holt das DSB-Votum ein (Beratungsgeheimnis, Träger, Verantwortlichkeit), schaltet erst danach ein und legt die Frist fest. |
| Einstellungen | „Chats mit der Schulsozialarbeit (Rolle Beratung)“ (Vorgabe: aus – nur Kontaktangaben im Adressbuch); „Chats mit der Schulsozialarbeit aufbewahren“ (Vorgabe: 90 Tage (Vorgabe)) |
| In SchulOS | Verwaltung → Rechte & Module → Messenger |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Block 4f, F-05)

- **Kontext:** Für die Schulsozialarbeit ist eine eigene Rolle `beratung` vorgesehen (Q5-17, `docs/FEINSCHLIFF.md` §9): für Schüler:innen
  und Eltern ansprechbar, Direktchat nur auf Initiative der Schüler:innen/Eltern, nur Terminabsprache, keine Fallakte in SchulOS.
  Beschäftigt ist die Schulsozialarbeit häufig beim Schulträger oder einem freien Träger, nicht beim Land.
- **Frage:** (a) Berührt ein Chat „Terminabsprache“ das Beratungsgeheimnis (§ 203 StGB, SGB VIII/X) – genügt ein Hinweis „keine
  Beratungsinhalte im Chat“? (b) Welche Löschfrist ist angemessen (Vorschlag 90 Tage statt der Frist für Lehrkräfte-Chats)? (c) Braucht
  es mit dem Träger eine Vereinbarung (Auftragsverarbeitung oder gemeinsame Verantwortung), und wer ist Verantwortlicher für die Chats?
- **Unser Vorschlag:** Hinweis im Chat, kürzere Löschfrist als eigener `retention`-Scope, Chat-Funktion der Rolle erst nach Votum; bis dahin
  Rolle ohne Chat-Funktion. Alle Rechtsaussagen sind Planungsannahmen – zu prüfen.
- **Stand (Q5-17, 2026-10-11):** Rolle gebaut; die Chat-Funktion ist die Moduleinstellung „Chats mit der Schulsozialarbeit“ im Messenger
  (Vorgabe **aus**). Eingeschaltet: nur Schüler:innen/Eltern beginnen, fester Hinweis „nur Terminabsprache“, Löschung 90 Tage nach der
  letzten Nachricht (Teilmenge „Direktchat mit der Schulsozialarbeit“). Nach dem Votum: Frist ggf. anpassen, dann einschalten.

## 9. Beurlaubung vorab

<!-- dsb:beurlaubung -->
| Punkt | |
|---|---|
| Was SchulOS tut | Antrag durch Eltern ohne Freitext und ohne Art.-9-Gründe; Entscheidung nach Schultagen durch Klassenleitung bzw. Schulleitung; ersetzt keine Unterschrift. |
| Vorgabe | Klassenleitung bis 2 Schultage, Aufbewahrung Schuljahresende + 1 Jahr. |
| Die Schule entscheidet / dokumentiert | Prüft Zuständigkeit und Formerfordernis nach § 43 SchulG NRW, stellt die Grenze passend ein und vergibt das Recht „Beurlaubungen über der Grenze entscheiden“ (z. B. an die Gruppe Schulleitung) – sonst entscheiden darüber nur Admin-Konten. |
| Einstellungen | „Beurlaubung: Klassenleitung entscheidet bis“ (Vorgabe: 2 Schultage) |
| In SchulOS | Verwaltung → Rechte & Module → Abwesenheiten |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Block 4f, F-08)

- **Kontext:** Eltern (bzw. volljährige Schüler:innen) beantragen Beurlaubung in SchulOS (Q5-16); Klassenleitung entscheidet bis 2 Tage,
  Schulleitung darüber. Gründe ohne Art.-9-Bezug (familiär, Wettkampf/Veranstaltung, sonstiges – keine Religion als Auswahl).
- **Frage:** Ist die Zuständigkeit nach Dauer (§ 43 SchulG NRW und die dazu ergangenen Bestimmungen) so richtig? Genügt ein digitaler Antrag
  ohne Unterschrift (Formerfordernis)? Wie lange darf der Vorgang aufbewahrt werden?
- **Unser Vorschlag:** Wie gebaut (zu prüfen); Zuständigkeitsgrenze als Einstellung, damit eine abweichende Rechtslage ohne Code-Änderung
  einstellbar ist; Aufbewahrung wie Fehlzeiten.
- **Stand (Q5-16, 2026-10-12):** gebaut, Rechtslage weiter **zu prüfen**. Antrag unter Abwesenheiten → „Beurlaubung vorab“ (Eltern
  minderjähriger Kinder; eigenständige (volljährige) Schüler:innen selbst, Q5-05), nur vorab, höchstens 31 Tage am Stück; Gründe als Auswahl ohne Freitext
  (familiärer Anlass, Wettkampf/Veranstaltung, sonstiger Grund). Die Zuständigkeit richtet sich nach den **Schultagen** im Zeitraum
  (ohne Wochenenden, Feiertage, Ferien): Klassenleitung bis 2 (Moduleinstellung: immer Schulleitung/1/2/3/5), darüber die Schulleitung
  (Recht „Beurlaubungen über der Grenze entscheiden“). Genehmigt → Fehlstunden im Zeitraum entschuldigt, Klassenbuch zeigt „beurlaubt“.
  Aufbewahrung: Löschklasse **LK-SJ-1J** (Schuljahresende + 1 Jahr) als Nachweis für Rückfragen zur Schulpflicht – Zusatzfrage: reicht
  das bzw. ist es zu lang? Der digitale Antrag ersetzt **keine Unterschrift**; verlangt die Schule eine, bleibt es beim Papierweg.

## 10. Information der Eltern über Fehlzeiten

<!-- dsb:fehlzeiten-eltern -->
| Punkt | |
|---|---|
| Was SchulOS tut | Eltern minderjähriger Kinder sehen Fehlzeiten (Einsicht protokolliert); Gong erst nach „nicht entschuldigt“ durch die Klassenleitung; keine Meldung an Behörden. |
| Vorgabe | Hinweis an die Klassenleitung ab 5 unentschuldigten Tagen im Halbjahr. |
| Die Schule entscheidet / dokumentiert | Klärt, ob die Information Pflicht oder zulässig ist (§ 43, § 123 SchulG NRW), und stellt die Schwelle ein. |
| Einstellungen | „Hinweis an die Klassenleitung bei unentschuldigten Fehltagen“ (Vorgabe: ab 5 Tagen) |
| In SchulOS | Verwaltung → Rechte & Module → Abwesenheiten |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Block 4f, F-03; auch Volljährigkeit)

- **Kontext:** Eltern minderjähriger Kinder sollen per Gong erfahren, wenn die Klassenleitung Fehlzeiten als „nicht entschuldigt“
  entschieden hat (Q5-13); bei volljährigen Schüler:innen (Q5-05) geht die Information an die Person selbst, Eltern nur mit Einwilligung.
- **Frage:** Ist die Information der Eltern über Fehlzeiten nach § 43 SchulG NRW und VO-DV I Pflicht oder zulässig? Gilt für volljährige
  Schüler:innen § 123 SchulG NRW (Information der Eltern) wie angenommen?
- **Unser Vorschlag:** Information erst nach der Entscheidung der Klassenleitung, keine automatische Meldung an Schulleitung/Behörde;
  Eltern volljähriger Schüler:innen nur mit Einwilligung der Person.
- **Stand (Q5-13, 2026-10-12):** gebaut wie vorgeschlagen. Schüler:in und Eltern sehen die Fehlzeiten unter „Abwesenheiten“
  (Einsicht der Eltern protokolliert); Gong an die Eltern erst nach „nicht entschuldigt“ durch die Klassenleitung; Hinweis an die
  Klassenleitung ab 5 unentschuldigten Tagen im Halbjahr (einstellbar). **Seit Q5-05 (2026-10-13):** Kennzeichen „eigenständig
  (volljährig)“ am Konto (setzt die Verwaltung) – die Person bekommt den Gong selbst, ihre Eltern sehen Fehlzeiten nur mit ihrer
  Einwilligung („Eltern informieren“, jederzeit widerrufbar, ohne Gründe der Krankmeldungen). Rechtsgrundlage weiter **zu prüfen**.

## 11. Aufbewahrung der Prüfprotokolle

<!-- dsb:pruefprotokolle -->
| Punkt | |
|---|---|
| Was SchulOS tut | Leert Protokoll-PDF und Bemerkung älterer Prüfungen; Termin, Ergebnis und Firma bleiben als Nachweis. |
| Vorgabe | Letzte 2 Protokolle, frühestens ein Jahr nach der Prüfung. |
| Die Schule entscheidet / dokumentiert | Klärt mit dem Schulträger die Nachweispflicht und wählt 2, 3 oder 5 Protokolle. |
| Einstellungen | „Prüfprotokolle aufbewahren“ (Vorgabe: letzte 2 Protokolle (bis zur übernächsten Prüfung)) |
| In SchulOS | Verwaltung → Rechte & Module → Gebäude & Technik |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Gebäude & Technik, G4-01)

- **Kontext:** Bei Prüfungen (DGUV V3 an ortsveränderlichen Geräten, Feuerlöscher, Spielgeräte …) lädt die Hausmeisterei das Protokoll der
  prüfenden Firma als PDF hoch und kann eine Bemerkung schreiben. Reale Protokolle tragen Name und Unterschrift der prüfenden Person, die
  Bemerkung kann Namen enthalten. Termin, Ergebnis und Firma der Prüfung haben keinen Personenbezug und bleiben als Nachweis gegenüber dem
  Schulträger bzw. der Unfallkasse.
- **Frage:** Wie lange dürfen bzw. müssen Protokoll und Bemerkung aufbewahrt werden? Gibt es eine Nachweispflicht des Schulträgers (z. B.
  aus DGUV-Vorschriften oder Betriebssicherheitsverordnung), die länger reicht als „bis zur übernächsten Prüfung“? Liegt die Aufbewahrung
  überhaupt bei der Schule oder beim Schulträger?
- **Unser Vorschlag (umgesetzt als Vorgabe):** Protokoll-PDF und Bemerkung werden geleert, sobald zwei spätere Prüfungen derselben Art am
  selben Ziel erledigt sind und die Prüfung mindestens ein Jahr zurückliegt; so liegen immer die beiden letzten Protokolle vor. Der Rest der
  Prüfung bleibt ohne Personenbezug. Seit Q5-26 wählt die Schule die Frist als Moduleinstellung selbst (Verwaltung → Rechte & Module →
  „Prüfprotokolle aufbewahren“): **letzte 2 Protokolle** (Vorgabe, bis zur übernächsten Prüfung), **letzte 3** oder **letzte 5** – jeweils
  frühestens ein Jahr nach der Prüfung; eine längere Nachweispflicht des Schulträgers ist so ohne Codeänderung abbildbar. Die Änderung steht
  im Audit-Log; der Löschlauf liest den jeweils aktuellen Wert.
- **Zusatzfrage:** Reichen die Stufen 2/3/5 (z. B. bei Prüffristen von einem Jahr: Protokolle der letzten zwei, drei bzw. fünf Jahre), oder
  braucht es eine Stufe in Jahren statt in Protokollen?

## 12. Löschfristen und Löschlauf

<!-- dsb:loeschfristen -->
| Punkt | |
|---|---|
| Was SchulOS tut | Löscht nachts nach den Löschklassen, mit Vorschau, Löschprotokoll und Löschsperren; einstellbare Fristen nur innerhalb fester Grenzen (DATENSCHUTZ.md §3.9). |
| Vorgabe | Regelfristen der Löschklassen (Konten 90 Tage nach Abgang, Chats 1 Jahr, Termine 2 Jahre). |
| Die Schule entscheidet / dokumentiert | Prüft die Fristen, ändert sie bei Bedarf (Recht „Datenschutz“), kontrolliert jährlich Löschprotokoll, Sperren und Archivexporte. |
| Einstellungen | „Konten nach dem Abgang löschen“ (Vorgabe: 90 Tage (Vorgabe)); „Chatnachrichten aufbewahren“ (Vorgabe: 1 Jahr (Vorgabe)); „Termine aufbewahren“ (Vorgabe: 2 Jahre (Vorgabe)) |
| In SchulOS | Verwaltung → Datenschutz (Löschkonzept, Löschlauf) |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: DS-15)

- **Kontext:** Jede Datenart hat eine Löschklasse (DATENSCHUTZ.md §3). Seit DS-15 kann die Schule einzelne Fristen innerhalb fester
  Grenzen ändern (Liste fest/einstellbar mit Begründung: DATENSCHUTZ.md §3.9); Änderungen stehen im Audit-Log und im Nachweis der
  Einrichtung.
- **Frage:** Passen die Regelfristen zum Löschkonzept der Schule (inkl. SchILD, Papierakten)? Sollen Chats kürzer als ein Jahr
  aufbewahrt werden?
- **Vorschlag:** Regelfristen übernehmen; Löschlauf-Vorschau vor dem ersten Lauf mit der DSB ansehen.

## 13. Kommunikation unter Schüler:innen und Information der Eltern

<!-- dsb:sichtbarkeit -->
| Punkt | |
|---|---|
| Was SchulOS tut | Schaltet Direktchats unter Schüler:innen, die Eltern-Info zu Vertretungen und Hausaufgaben je Jahrgang und die Veröffentlichung des Vertretungsplans (Profilbilder im Sitzplan: §16). |
| Vorgabe | Direktchats nur in der eigenen Klasse, Eltern-Info Vertretung bis Jahrgang 10, Hausaufgaben für Eltern aus, Vertretungsplan sofort. |
| Die Schule entscheidet / dokumentiert | Entscheidet je Schalter nach pädagogischem Konzept und Erforderlichkeit und dokumentiert die Wahl. |
| Einstellungen | „Direktchats unter Schüler:innen“ (Vorgabe: nur innerhalb der eigenen Klasse); „Eltern über Vertretungen und Entfall informieren“ (Vorgabe: bis Jahrgang 10); „Vertretungsplan veröffentlichen“ (Vorgabe: sofort); „Hausaufgaben für Eltern sichtbar“ (Vorgabe: aus) |
| In SchulOS | Verwaltung → Rechte & Module |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: Q5-14, Q5-11, I-60)

- **Kontext:** Moduleinstellungen regeln, wer mit wem chatten darf und welche Informationen Eltern bekommen; die Vorgaben sind die
  vorsichtigere Variante.
- **Frage:** Sind Direktchats unter Schüler:innen innerhalb der Klasse erforderlich? Bis zu welchem Jahrgang ist die Information der
  Eltern über Vertretungen und Hausaufgaben erforderlich?
- **Vorschlag:** Vorgaben übernehmen; Abweichungen im pädagogischen Konzept begründen.

## 14. Außenzugang und Kalender-Abo

<!-- dsb:aussenzugang -->
| Punkt | |
|---|---|
| Was SchulOS tut | Von außen per Vorgabe nichts erreichbar; öffentliche Seiten nur per Allowlist; Personal nur mit Gerätezertifikat; IP-Adressen nur gekürzt und gehasht für Rate-Limits. Kalender-Abo per widerrufbarem Link (nur lesend, eigene sichtbare Kalender) im Schulnetz, von außen nur im Modus „alles“ und nach denselben Regeln wie eine Anmeldung. |
| Vorgabe | Außenzugang „keiner“; Verwaltung/Admin von außen gesperrt; unbenutzte Abo-Links nach einem Jahr gelöscht. |
| Die Schule entscheidet / dokumentiert | Entscheidet mit dem Schulträger über Außenzugang und Gerätezertifikate, ergänzt die Datenschutzhinweise um die Technik der öffentlichen Seiten und weist in der Nutzungsordnung darauf hin, dass Abo-Links Termine an die Kalender-App der Person weitergeben. |
| In SchulOS | Verwaltung → System |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: P4-40, P4-40b, Q5-15)

- **Kontext:** siehe §3g (öffentliche Seiten) und SICHERHEIT.md S27/S28/S35. Kalender-Abo (Q5-15, S39): Jede Person kann für einen
  ihrer sichtbaren Kalender einen geheimen Link anlegen (höchstens 5, widerrufbar); Kalender-Apps rufen ihn ohne Anmeldung ab. Der Link
  enthält nichts über die Person, gespeichert wird nur sein Hash; Abrufe werden nicht protokolliert (nur „zuletzt genutzt“, stundengenau).
  Synchronisiert die App über einen Cloud-Dienst (z. B. Abo im Kalender eines großen Anbieters), holt dessen Server die Termine ab –
  das geht nur, wenn SchulOS von außen erreichbar ist (Modus „alles“).
- **Frage:** Ist ein Zugang von außen für Eltern/Schüler:innen (Modus „alles“) mit 2FA bzw. Passkey vertretbar? Dürfen Lehrkräfte
  persönliche bzw. Gruppentermine per Abo an Kalender-Apps (ggf. Cloud-Anbieter) geben, oder nur den Schulkalender?
- **Vorschlag:** Vorgabe „keiner“ bzw. „öffentliche Seiten“, Personal nur mit Gerätezertifikat; Abo-Links nur im Schulnetz, Hinweis in
  der Nutzungsordnung, keine Freigabe von Abo-Links in der Allowlist ohne Votum (QUESTIONS Q-15-1).

## 15. Notenbuch der Lehrkraft

<!-- dsb:notenbuch -->
| Punkt | |
|---|---|
| Was SchulOS tut | Arbeitsnotenbuch der Fachlehrkraft (Anlage 2 II Nr. 4 VO-DV I): Teilnoten, Gewichtung, Vorschlag der Halbjahresnote, Kurzkommentar je Note (höchstens 200 Zeichen, keine Beobachtungsnotizen). Teilnoten sehen nur die Fachlehrkräfte des Lehrauftrags (Mitlehrkräfte gleichberechtigt, Vertretung nur per Übertragung); Klassenleitung und Schulleitung sehen nur Halbjahreswerte, jeder Abruf steht im Audit-Log; Verwaltung und Admin-Konten sehen keine Noten. Zwei-Faktor-Anmeldung ist für das Modul Pflicht. Offline-Eingabe nur auf Dienstgeräten: Teilnoten landen ohne Verbindung in einem verschlüsselten Zwischenspeicher des Browsers (Schlüssel nur zusammen mit einem Anteil des Servers, weg bei Abmeldung, Sitzungsablauf, Rechteentzug, spätestens nach 7 Tagen), Abgleich mit Konfliktanzeige – auf Privatgeräten von außen nie. Keine Zeugnisse, Zeugnisbemerkungen oder Benachrichtigungen nach § 50 SchulG – amtlich bleibt die Schulverwaltungssoftware. |
| Vorgabe | Modul ausgeschaltet; Notenbücher werden ein Jahr nach Ende ihres Schuljahres gelöscht (LK-SJ-1J); Noten für Schüler:innen und Eltern nicht sichtbar (einschaltbar: nur Halbjahresnoten nach dem Abschluss oder zusätzlich Teilnoten, nie Kommentare; Eltern bis zu einem Jahrgang der Sek I, bei eigenständigen Schüler:innen nur mit deren Einwilligung); Zwei-Faktor-Pflicht fest an; Offline-Eingabe nur auf Geräten mit Gerätezertifikat der Schule (einschaltbar: zusätzlich im Schulnetz mit Bestätigung je Gerät, dass es ein Dienstgerät ist; oder ganz aus). |
| Die Schule entscheidet / dokumentiert | Nimmt das Notenbuch ins VVT auf (Schulleitung, § 2 Abs. 2 VO-DV II) und lässt es vor Echtdaten durch die DSB prüfen (DA ADV Nr. 3); regelt den Zugriff vom Privatgerät (Genehmigung nach § 2 Abs. 2 VO-DV I bzw. Dienstgerät), die Aufbewahrung der Halbjahresliste und die Übertragung bei Ausfall einer Lehrkraft; vergibt „Halbjahreswerte einsehen“, „Übertragen“ und „Exportieren“ sparsam (z. B. an die Gruppe Schulleitung), legt fest, wer den Notenbuch-Teil der Auskunft erteilt (Recht „Notenbuch: Auskunft erteilen“, nie Admin-Konten), wählt die Rundung des Vorschlags auf der Grenze x,5 und ergänzt die Nutzungsordnung. |
| Einstellungen | „Noten für Schüler:innen sichtbar“ (Vorgabe: aus); „Noten für Eltern sichtbar“ (Vorgabe: aus); „Offline-Eingabe auf Dienstgeräten“ (Vorgabe: nur Geräte mit Gerätezertifikat der Schule); „Rundung des Halbjahresvorschlags auf der Grenze (x,5)“ (Vorgabe: zugunsten der Schüler:in (2,5 → 2)) |
| Baustein Nutzungsordnung | Notenbuch in SchulOS: Lehrkräfte führen Teilnoten nur im Notenbuch von SchulOS und nur für die eigenen Lerngruppen. Der Zugriff erfolgt auf dienstlichen Geräten; ein privates Gerät nur mit schriftlicher Genehmigung der Schulleitung nach § 2 Abs. 2 VO-DV I. Kopien außerhalb von SchulOS (Bildschirmfotos, Exporte in private Cloud-Speicher oder Apps ohne Vertrag mit der Schule) sind nicht erlaubt. Kommentare bleiben kurz und sachlich, ohne Angaben zu Gesundheit, Familie oder Verhalten. Das Gerät wird beim Verlassen gesperrt, nach der Arbeit wird abgemeldet. Die Zwei-Faktor-Anmeldung ist für das Notenbuch Pflicht. Die Offline-Eingabe wird nur auf Dienstgeräten der Schule eingeschaltet, nie auf privaten Geräten; nach der Arbeit ohne Verbindung wird der Abgleich abgewartet und Konflikte werden aufgelöst. Notenbücher sind Daten der Schule und werden bei Abgang oder längerem Ausfall von der Schulleitung übertragen. |
| In SchulOS | Verwaltung → Rechte & Module → Notenbuch |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: P5-00, `PHASE5-NOTENBUCH.md` §1–§4, F5-03…F5-15)

- **Kontext:** Das Notenbuch der Lehrkraft ist eine zugelassene Datensammlung der Schule (Anlage 2 II Nr. 4 VO-DV I, Verarbeitung in
  ADV-Anlagen nach § 4 Abs. 5). Zulässig ist die automatisierte Verarbeitung „auf dienstlichen digitalen Geräten und in Netzwerken“
  (§ 2 Abs. 1 VO-DV I); die Ausnahme mit Genehmigungspflicht ist das **private Gerät** (§ 2 Abs. 2). SchulOS speichert auf dem
  Server der Schule (kein Drittanbieter, keine Ende-zu-Ende-Verschlüsselung – sie widerspräche Auskunft, Einsicht und Übertragung).
  Need-to-know nach § 120 Abs. 1 S. 2 SchulG NRW und dem Muster der Anlage 3: Teilnoten nur die Fachlehrkräfte des Lehrauftrags,
  Klassen- und Schulleitung nur Halbjahreswerte (protokolliert), Verwaltung nichts – auch Admin-Konten nicht (kein „alles sehen“).
  Zwei-Faktor-Pflicht fürs Modul, kein Browser-Cache, Export nur per Knopf mit Audit-Eintrag. Offline-Eingabe (P5-20) nur auf
  Dienstgeräten bzw. mit Gerätezertifikat, verschlüsselter Zwischenspeicher, auf Privatgeräten nie. Schüler:innen und Eltern
  bekommen ihre Noten über die Auskunft (§ 120 Abs. 9); eine laufende Anzeige ist eine Einstellung (Vorgabe aus, P5-14).
- **Fragen:**
  1. Braucht der Browserzugriff vom **Privatgerät** ohne lokale Speicherung eine Genehmigung nach § 2 Abs. 2 VO-DV I? (MSB-FAQ: ja –
     SchulOS geht davon aus und zeigt einen Hinweis.)
  2. Muss es neben dem digitalen Notenbuch eine **Papierfassung** geben (§ 4 Abs. 5 VO-DV I)?
  3. Fällt die **Halbjahresliste** (Übergabe an Klassenleitung/Zeugniskonferenz) unter „Liste der schriftlichen Arbeiten und deren
     Ergebnisse“ (Anlage 2 I Nr. 2) mit 5 oder 10 Jahren, oder genügt LK-SJ-1J, weil die amtlichen Noten in der
     Schulverwaltungssoftware stehen?
  4. Sollen Schüler:innen bzw. Eltern Noten laufend in SchulOS sehen (Einstellung, Vorgabe aus)?
  5. Wer bekommt „Halbjahreswerte einsehen“, „Übertragen“ und „Exportieren“ (Vorschlag: Gruppe Schulleitung; Admin nur
     „Übertragen“, ohne Einsicht)?
  6. **Wer erteilt den Notenbuch-Teil der Auskunft** (Art. 15 DSGVO, § 120 Abs. 9 SchulG NRW – Recht `notenbuch.auskunft`)? Die
     Verwaltung erstellt die Auskunft ohne Noten; Teilnoten, Kommentare und Halbjahreswerte kommen nur hinzu, wenn die erzeugende
     Person dieses ausdrückliche Recht hat (nie Admin-Konten; Q-5A-29, Projektleitung 2026-10-14: wie vorgeschlagen). Vorschlag: Schulleitung.
- **Vorschlag:** Server-Speicherung mit den Pflichtmaßnahmen oben; Teilnoten LK-SJ-1J; Halbjahresliste nur als Export an die
  Schulverwaltungssoftware; Hinweis beim ersten Öffnen und Baustein für die Nutzungsordnung (P5-17).

## 16. Sitzplan

<!-- dsb:sitzplan -->
| Punkt | |
|---|---|
| Was SchulOS tut | Sitzpläne je Lerngruppe nur für Lehrkräfte der Gruppe und die Klassenleitung, im Klassenbuch zusätzlich für die Lehrkraft, die die Stunde hält (Vertretung); nur Name, Initialen und Platz, keine Bemerkungen am Platz. Profilbilder nur von Personen mit Einwilligung (DS-09), der Druck enthält nie Fotos. |
| Vorgabe | Löschung zum Ende des Schuljahres der letzten Änderung (LK-SJ); Profilbilder im Sitzplan an (nur mit Einwilligung). |
| Die Schule entscheidet / dokumentiert | Bestätigt die Grundlage (aus Klassenlisten abgeleitete Daten, Anlage 2 II Nr. 3 VO-DV I), entscheidet über Profilbilder im Sitzplan und weist darauf hin, dass Fotositzpläne außerhalb von SchulOS nur mit Einwilligung zulässig sind. |
| Einstellungen | „Profilbilder im Sitzplan“ (Vorgabe: an (nur mit Einwilligung)) |
| In SchulOS | Verwaltung → Rechte & Module → Sitzplan |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: P5-01…P5-04, Q-4D-29…33, F5-09)

- **Kontext:** Name und Platz sind aus Klassenlisten abgeleitete Daten (Anlage 2 II Nr. 3, § 1 Abs. 2 S. 4 VO-DV I), Zweck ist die
  Unterrichtsorganisation. Für einen **Fotositzplan** gibt es keine eigene Rechtsgrundlage – Fotos nur mit Einwilligung (§ 120 Abs. 2
  SchulG NRW). SchulOS zeigt am Platz deshalb nur das einwilligungsbasierte Profilbild (DS-09), abschaltbar, und druckt nie Fotos.
  Sichtbarkeit: Lehrkräfte der Gruppe und Klassenleitung, im Klassenbuch die Lehrkraft der Stunde (Vertretung); niemand sonst, auch
  Admin nicht (SICHERHEIT S42).
- **Frage:** Sollen Profilbilder im Sitzplan erscheinen (Vorgabe an, nur mit Einwilligung)? Ist die Löschung zum Schuljahresende nach
  der letzten Änderung passend?
- **Vorschlag:** Vorgaben übernehmen; in der Nutzungsordnung festhalten, dass eigene Fotositzpläne (Handy, Papier mit Fotos) ohne
  Einwilligung nicht zulässig sind.

## 17. Externe Konferenzdienste im Kursraum

<!-- dsb:konferenz -->
| Punkt | |
|---|---|
| Was SchulOS tut | Leitung, Lehrkräfte der Gruppe und Gruppenverwaltung können je Kursraum einen https-Link auf einen externen Konferenzraum hinterlegen (V-01). SchulOS speichert nur den Link, ruft den Dienst nie selbst auf und gibt die Adresse des Kursraums nicht weiter; der Knopf nennt den Rechnernamen und weist auf den externen Dienst hin. Sichtbar nur für Personen, die den Kursraum öffnen dürfen; das Protokoll enthält nur den Rechnernamen (der Link kann ein Raum-Passwort enthalten). |
| Vorgabe | Konferenzlinks aus; der Link wird mit der Gruppe gelöscht. |
| Die Schule entscheidet / dokumentiert | Wählt den Konferenzdienst (mit Vertrag zur Auftragsverarbeitung, z. B. über den Schulträger), nimmt ihn ins VVT auf und schaltet die Konferenzlinks erst danach ein; weist in der Nutzungsordnung darauf hin, dass nur dieser Dienst verlinkt wird. |
| Einstellungen | „Konferenzlinks im Kursraum“ (Vorgabe: aus) |
| In SchulOS | Verwaltung → Rechte & Module → Kursraum |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: V-01)

- **Kontext:** Eine eigene Videokonferenz baut SchulOS bewusst nicht (Drittkomponente, eigene Datenschutzprüfung). Viele Schulen
  nutzen einen Dienst des Schulträgers; der Link dorthin liegt heute verstreut in Chat oder Mail. SchulOS verlinkt nur – die
  Verarbeitung im Konferenzdienst selbst liegt außerhalb von SchulOS und braucht eigene Grundlage und Vertrag.
- **Frage:** Reicht es, den Schalter erst nach Auswahl und VVT-Eintrag des Dienstes einzuschalten, oder braucht es eine Liste
  erlaubter Dienste in SchulOS?
- **Vorschlag:** Schalter ab Werk aus, Einschalten durch die Schule nach VVT-Eintrag; eine Freigabeliste erst, wenn Schulen sie
  brauchen.

## 18. Schulbücherei: Ausleihe ohne Leseprofil

<!-- dsb:buecherei -->
| Punkt | |
|---|---|
| Was SchulOS tut | Speichert eine Ausleihe (Person, Exemplar, Fälligkeit) nur, solange sie offen ist: Die Rückgabe ohne Befund löscht sie sofort, es bleiben nur Zähler je Monat und Medienart ohne Person – kein Ausleihverlauf, keine Leseempfehlungen, Ausleihe und Rückgabe nicht im Audit-Log. Die Theke (Büchereiteam, auch Schüler-Helfer:innen) sieht nur Name, Klasse und offene Ausleihen der gewählten Person; Rückgaben mit Befund (Schaden, unvollständig) sieht nur die Verwaltung mit „Schulbuchausleihe“. Büchereiausweise tragen Name, Klasse und einen zufälligen Code (ohne Namen oder Kontonummer); Ersatz bei Verlust macht den alten Code ungültig, der Code geht mit dem Konto. Vormerkungen (Titel ↔ Person) gibt es nur für ganz ausgeliehene Titel; sie verschwinden mit der Ausleihe, mit Ablauf der Abholfrist, auf Wunsch sofort und spätestens nach 90 Tagen – die anderen sehen nur die Zahl der Vormerkungen, nie Namen. „Meine Ausleihen“ zeigt nur Aktuelles (offene Ausleihen und Vormerkungen), Eltern Minderjähriger sehen das ihrer Kinder lesend. Vor Fristende kommt eine Erinnerung, Überfälliges wird an Schultagen in drei Stufen gemahnt – ab der 2. Stufe auch an die Eltern Minderjähriger, auf Wunsch zusätzlich per Mail; Benachrichtigungen und Mails nennen keinen Titel. Die Mahnstufe endet mit der Rückgabe (nur ein Zähler je Monat bleibt); die Mahnliste des Büchereiteams zeigt Schüler-Helfer:innen keine Mahnstufen. Die Statistik zählt nur je Monat, Medienart und Exemplar, ohne Person. Optional schlägt der Bestand Titelangaben per ISBN bei öffentlichen Bibliothekskatalogen nach – übertragen wird nur die ISBN. Die Schulbuchausleihe (Stufe 2, zuschaltbar) pflegt Lernmittel je Jahrgang und Fach mit Inventarnummern und veröffentlichte Bücherlisten für Eltern – ohne Personenbezug; wem ein Schulbuch gehört, hält SchulOS nur im laufenden Schuljahr fest: Ausgabe klassen- oder kursweise per Scan, die Rücknahme ohne Befund löscht die Zuordnung sofort (der Zustand steht am Exemplar ohne Person), nicht zurückgegebene Schulbücher werden nach dem Schuljahresende ohne Titel gemahnt – bei Minderjährigen von Anfang an auch an die Eltern. Für Schaden oder Verlust erfasst die Verwaltung eine Ersatzforderung (Betrag, Grund, offen/bezahlt/erlassen – keine Zahlungsdaten) und druckt einen Brief an die Eltern bzw. die volljährige Person; Schuljahreswechsel und Abgangsdialog zeigen offene Posten nur als Zahl. Die Klassenleitung sieht je Schüler:in ihrer Klasse nur die Zahl offener Schulbücher und Ersatzforderungen – keine Titel, keine Beträge, keine Ausleihen der Bücherei. |
| Vorgabe | Modul ab Werk aus; Leihfrist Buch 4 Wochen, Film/Spiel/Sonstiges 2 Wochen, Gerät 1 Woche, höchstens 2 Verlängerungen (nicht bei Vormerkung); bis 5 Vormerkungen je Person, Abholfrist 1 Woche; Erinnerung 2 Tage vor Fristende, Mahnungen im Abstand von 1 Woche, Mail aus; ISBN-Abfrage aus (eingeschaltet ab Werk nur die beiden deutschen Kataloge, Open Library außerhalb der EU aus); Befunde bis zur Erledigung + Schuljahresende + 1 Jahr (LK-SJ-1J); Schulbuchausleihe aus. |
| Die Schule entscheidet / dokumentiert | Bestätigt die Grundlage (Erfüllung der Aufgabe Schulbücherei, Anlage 1 bzw. 2 VO-DV I – zu prüfen), entscheidet, wer zum Büchereiteam gehört (Schüler-Helfer:innen sehen Namen und offene Ausleihen anderer), weist das Team auf Verschwiegenheit hin und stellt Leihfristen, Verlängerungen, Erinnerung und Mahnungen (auch per Mail) ein. |
| Einstellungen | „Leihfrist Buch“ (Vorgabe: 4 Wochen); „Leihfrist Film“ (Vorgabe: 2 Wochen); „Leihfrist Spiel“ (Vorgabe: 2 Wochen); „Leihfrist Gerät“ (Vorgabe: 1 Woche); „Leihfrist Sonstiges“ (Vorgabe: 2 Wochen); „Verlängerungen je Ausleihe“ (Vorgabe: 2-mal); „Abholfrist bei Vormerkungen“ (Vorgabe: 1 Woche); „Vormerkungen je Person“ (Vorgabe: 5); „Erinnerung vor Fristende“ (Vorgabe: 2 Tage vorher); „Abstand der Mahnungen“ (Vorgabe: 1 Woche); „Mahnungen auch per Mail“ (Vorgabe: aus); „ISBN-Abfrage bei Bibliothekskatalogen“ (Vorgabe: aus); „ISBN-Quelle: Deutsche Nationalbibliothek“ (Vorgabe: an); „ISBN-Quelle: Verbundkatalog des Hochschulbibliothekszentrums NRW“ (Vorgabe: an); „ISBN-Quelle: Open Library“ (Vorgabe: aus); „Schulbuchausleihe (Lernmittel)“ (Vorgabe: aus) |
| Baustein Nutzungsordnung | Büchereiteam: Wer an der Theke der Schulbücherei mithilft, sieht dort Namen, Klasse und offene Ausleihen anderer Schüler:innen und Lehrkräfte. Diese Angaben sind vertraulich und werden nur für die Ausleihe genutzt – nicht weitererzählt, nicht notiert, nicht fotografiert. Wer was liest, ist privat. Schäden werden nur als Sache beschrieben („Wasserschaden“), ohne Namen. |
| In SchulOS | Verwaltung → Rechte & Module → Bücherei |
<!-- /dsb -->

**Hintergrund und Fragen** (Herkunft: BU-02, docs/BUECHEREI.md)

- **Kontext:** Was jemand liest, ist privat. SchulOS hält deshalb nur offene Ausleihen mit Person fest; die Rückgabe ohne Befund
  löscht die Ausleihe sofort, nur anonyme Zähler je Monat und Medienart bleiben (Statistik). Schäden bleiben bis zur Erledigung
  (Grundlage einer Ersatzforderung). Die Theke darf auch von Schüler-Helfer:innen bedient werden (Entscheidung der Projektleitung
  2026-10-17) – sie sehen Namen, Klasse und offene Ausleihen der Person, die vor ihnen steht, aber keinen Verlauf und keine Befunde.
- **Frage:** Reicht die Verschwiegenheitsbelehrung der Schüler-Helfer:innen (Baustein unten), oder sollen sie nur ausleihen dürfen,
  wenn eine Lehrkraft dabei ist? Ist die Aufbewahrung von Befunden bis Schuljahresende + 1 Jahr nach der Erledigung passend?
- **Ergänzung BU-03:** Vormerkungen verbinden eine Person mit einem Titel, den sie lesen möchte. Sie entstehen nur für ganz
  ausgeliehene Titel, verschwinden mit der Ausleihe, mit Ablauf der Abholfrist oder auf Wunsch und spätestens nach 90 Tagen
  (LK-90); andere sehen nur ihre Zahl. Eltern minderjähriger Schüler:innen sehen offene Ausleihen und Vormerkungen ihrer Kinder
  lesend (Entscheidung der Projektleitung 2026-10-19: ausleihen dürfen alle Rollen außer Eltern und Admin; Befunde nur die
  Verwaltung). **Frage:** Ist die Eltern-Sicht auf Vormerkungen (nicht nur Ausleihen) bei Minderjährigen angemessen?
- **Ergänzung BU-04:** Erinnerung vor Fristende (Vorgabe 2 Tage) und Mahnstufen 1–3 laufen täglich, Mahnungen nur an Schultagen
  (1. am ersten Schultag nach der Fälligkeit, dann im eingestellten Abstand, Vorgabe 1 Woche). Ab der 2. Stufe werden bei
  Minderjährigen die Eltern benachrichtigt (Entscheidung der Projektleitung 2026-10-17; nur Eltern, die für das Kind handeln – bei
  eigenständigen Schüler:innen nicht, auch nicht mit Einwilligung „Eltern informieren“, weil die Mahnung eine Aufforderung ist).
  Benachrichtigungen und optionale Mails nennen keinen Titel (was jemand liest, steht nur nach der Anmeldung in SchulOS); die Mail
  an Eltern nennt den Vornamen des Kindes. Die Mahnstufe steht nur an der offenen Ausleihe und verschwindet mit der Rückgabe
  (Verlängern setzt sie zurück); es bleibt nur ein Zähler je Monat und Medienart. Die Mahnliste des Büchereiteams zeigt Name,
  Klasse, Titel und Überfälligkeit wie die Theke, Mahnstufen nur Erwachsenen im Team. **Fragen:** Ist die Elternbenachrichtigung
  ab der 2. Stufe als Information der Erziehungsberechtigten gedeckt? Sollen Mahnungen per Mail ab Werk aus bleiben (Vorgabe)?
- **Ergänzung BU-05:** Die Statistik zählt nur je Monat und Medienart (Ausleihen, Verlängerungen, Mahnungen) und je Exemplar
  (wie oft ausgeliehen, Monat der letzten Ausleihe) – ohne Person. Daraus entstehen „nie ausgeliehen“ und Aussonderungsvorschläge;
  wer was gelesen hat, lässt sich nicht auswerten. Keine Fragen offen.
- **Ergänzung BU-06:** Optional kann der Bestand Titelangaben per ISBN bei öffentlichen Bibliothekskatalogen nachschlagen
  (Deutsche Nationalbibliothek, Verbundkatalog des Hochschulbibliothekszentrums NRW, Open Library – je Quelle abschaltbar). Ab Werk
  aus; einschalten kann nur, wer „Datenschutz“ verwalten darf. Übertragen wird nur die ISBN, vom Server aus; die Kataloge sehen die
  Adresse des Schulservers. **GATE BU1 (datensparsam vorentschieden):** Open Library sitzt außerhalb der EU und ist deshalb ab
  Werk aus – eingeschaltet fragt SchulOS nur die beiden deutschen Kataloge; Open Library lässt sich einzeln zuschalten (dann als
  letzte Quelle). **Frage:** Reicht die Nennung als Empfänger im VVT, oder darf die Schule Open Library (ISBN und Serveradresse
  in ein Drittland) überhaupt zuschalten – und unter welcher Voraussetzung?
- **Ergänzung BU-10 (Stufe 2, Schulbuchausleihe):** zuschaltbar („Schulbuchausleihe (Lernmittel)“, ab Werk aus). Lernmittel je
  Jahrgang und Fach, Exemplare mit Inventarnummer und Zustand und die Bücherliste für Eltern (Hinweistext, Leihe und „selbst
  kaufen“ mit Preis) enthalten keine Personendaten; Eltern sehen freigegebene Bücherlisten, vorausgewählt der Jahrgang ihrer Kinder.
  Für die Ausgabe (BU-11) ist datensparsam festgelegt: Die Zuordnung Exemplar ↔ Person gilt nur im laufenden Schuljahr, die
  Rücknahme ohne Befund löscht sie sofort, Schäden bleiben bis zur Erledigung der Ersatzforderung + Schuljahresende + 1 Jahr.
  **Fragen:** Ist die Elternbenachrichtigung bei überfälligen Schulbüchern schon ab der 1. Mahnung (Entscheidung der
  Projektleitung, anders als in der Bücherei) für Minderjährige gedeckt? Dürfen nicht zurückgegebene Schulbücher über das
  Schuljahresende hinaus als offener Posten mit Namen stehen bleiben, bis sie zurück oder ersetzt sind (Vorschlag: ja, längstens
  bis zur Kontolöschung)?
- **Ergänzung BU-11 (Ausgabe und Rücknahme):** Die Verwaltung („Schulbuchausleihe“) gibt Schulbücher klassen- oder kursweise
  per Scan aus (Person über Liste oder Büchereiausweis). Die Zuordnung Exemplar ↔ Person trägt das Schuljahr der Ausgabe und ist
  zu dessen Ende fällig; die Rücknahme (nur scannen) löscht sie ohne Befund sofort – der Zustand („gebraucht“, „Einband lose“)
  steht danach nur am Exemplar, ohne Person. Mit Befund bleibt sie bis zur Erledigung, danach Schuljahresende + 1 Jahr.
  Nicht Zurückgegebenes bleibt über das Schuljahresende als offener Posten (vorläufig datensparsam: bis zur Rückgabe bzw.
  Erledigung, spätestens mit dem Konto) und wird an Schultagen in drei Stufen gemahnt – bei Minderjährigen ab der 1. Stufe
  auch die Eltern (Entscheidung 4), ohne Titel, Mail wie in der Bücherei optional. Schüler:innen und Eltern sehen die offenen
  Schulbücher unter „Meine Ausleihen“; Auskunft und Eigenexport („Schulbücher.txt“) enthalten sie. Ausgabe und Rücknahme stehen
  im Audit-Log nur mit der Inventarnummer, ohne Person; Befunde mit Bezug auf die Ausgabe. **Fragen:** wie oben (Elternmahnung ab
  Stufe 1, offener Posten über das Schuljahresende); zusätzlich: Reicht als Rückgabefrist das Schuljahresende (Vorgabe), oder
  braucht die Schule einen eigenen Rückgabetag vor den Sommerferien (dann Mahnung schon in den letzten Schulwochen)?
- **Ergänzung BU-12 (Ersatzforderungen):** Die Verwaltung erfasst für Schaden oder Verlust Betrag und Grund (Status offen,
  bezahlt, erlassen) und druckt einen Brief – an die Eltern Minderjähriger, sonst an die Person. SchulOS speichert keine
  Zahlungsdaten und nennt im Brief keine Bankverbindung. Offene Forderungen bleiben bis zum Abschluss (spätestens mit dem
  Konto), abgeschlossene bis Schuljahresende + 1 Jahr; Person und Eltern sehen offene Forderungen. **Fragen:** Ist die
  Aufbewahrung abgeschlossener Forderungen bis Schuljahresende + 1 Jahr passend (Nachweis gegenüber Schulträger/Kasse)? Muss
  der Brief einen Hinweis auf eine Rechtsgrundlage der Ersatzpflicht (Lernmittelverordnung/Leihvertrag) enthalten?
- **Ergänzung BU-13:** Schuljahreswechsel und Abgangsdialog zeigen offene Bücherei-Posten nur als Zahlen (wer den Wechsel bzw.
  den Abgang bearbeitet, sieht keine Titel). Offene Posten halten weder Abgang noch Kontolöschung auf. Keine neuen Fragen.
- **Ergänzung BU-16 (Klassenleitung, Entscheidung der Projektleitung 2026-10-20):** Die Klassenleitung sieht unter „Meine Klasse“
  je Schüler:in ihrer Klasse Name und Zahl offener Schulbücher (nur mit Schulbuchausleihe) und offener Ersatzforderungen – keine
  Titel, Inventarnummern, Gründe, Beträge oder Fälligkeiten und keine Ausleihen der Bücherei (Stufe 1). Zweck: an die Rückgabe
  erinnern und Eltern ansprechen können, ohne dass die Klassenleitung erfährt, welche Medien jemand hat. Kein eigenes Recht (Prüfung
  über die Klassenleitung), kein Export, kein Druck, kein Audit-Eintrag. **Entschieden (Projektleitung 2026-10-26): ja** – die
  Klassenleitung sieht weiter die Zahl offener Ersatzforderungen je Schüler:in (wie umgesetzt: nur die Zahl, keine Gründe oder
  Beträge), damit sie Eltern auf offene Posten ansprechen kann. Frühere Frage: Ist diese Sicht erforderlich, oder soll sie nur
  offene Schulbücher sehen?
- **Vorschlag:** Vorgaben übernehmen; Büchereiteam schriftlich belehren (Baustein), Befunde wie vorgesehen.
