# Phase 5a – Notenbuch & Sitzplan (Planung)

*Stand 2026-10-12 · Recherche + Plan von Fable (Freigabe Projektleitung). **Projektleitung hat F5-01…F5-16 beantwortet (Runde 4): alles wie vorgeschlagen
außer F5-01 (vor v0.5.0), F5-15 (Offline schon in V1), F5-16 (Fable, wo sinnvoll) – siehe §0.** Kein Rechtsgutachten: Planungsannahmen, die DSB der Schule prüft. Rechtstexte abgerufen am
12.10.2026.*

## 0. Entscheidungen Projektleitung (2026-10-12) – gelten vor dem Rest des Dokuments

- **Reihenfolge (F5-01, F5-02):** Sitzplan P5-01…04 läuft **mit Block 4d**. Notenbuch P5-10…18 + P5-20 als **Block 5a nach 4d und vor
  4e**; Release v0.4.0 nach 4d (inkl. Sitzplan), **v0.5.0 nach 4e enthält 5a**. Was 5a aus 4e braucht, baut 5a modulbezogen selbst:
  2FA-Pflicht nur fürs Notenbuch (F5-07), kurzer Inaktivitätsablauf für Notenbuch-Seiten, `no-store` und PWA-Ausschluss – 4e
  verallgemeinert das später.
- **Offline in V1 (F5-15):** **P5-20 gehört zu V1** – Offline-Eingabe nur auf Dienstgeräten bzw. mit Gerätezertifikat/im Schulnetz,
  Cache in IndexedDB mit WebCrypto (AES-GCM, Schlüssel nur aus der Sitzung), Spülung bei Abmeldung/Ablauf, Sync mit Versionsvektor je
  Zelle und Konfliktanzeige. Auf Privatgeräten kein Offline-Cache (sonst § 2 Abs. 2 VO-DV I mit Löschpflicht). E2EE bleibt verworfen.
- **Modell (F5-16):** Fable, wo es sinnvoll ist – sicher für P5-20 (Offline/Sync/Krypto), ggf. für P5-11 (Rechte-/Sichtbarkeitsmodell);
  Reviews nach Einschätzung mit Opus oder Fable. Rest Opus.
- Alle übrigen Fragen wie vorgeschlagen.

## 1. Kurzfazit

1. **„Nur lokal auf dem Gerät erlaubt“ stimmt nicht – es ist fast umgekehrt.** Automatisierte Verarbeitung von Schülerdaten ist
   zulässig **„auf dienstlichen digitalen Geräten und in Netzwerken“** (§ 2 Abs. 1 VO-DV I); die *Ausnahme* mit Genehmigungspflicht
   ist das **private Gerät** (§ 2 Abs. 2). Lehrer-Apps landen in der Privatgeräte-Ecke, weil sie typischerweise auf privaten Tablets
   laufen und Cloud-Backups bei Drittanbietern ohne AV-Vertrag machen – genau das verbietet der Genehmigungsvordruck.
2. Ein **schuleigener, von Schule oder Schulträger betriebener Server** ist der vorgesehene Normalfall: „Die Daten können auf
   schuleigenen Anlagen verarbeitet werden. Sie können auch z. B. in einem kommunalen Rechenzentrum verarbeitet werden.“ (DA ADV
   Nr. 1). SchulOS ist für ein Notenbuch *besser* aufgestellt als eine App auf dem Privat-iPad.
3. Das **Notenbuch der Lehrkraft ist eine zugelassene Datensammlung der Schule**: Anlage 2 II Nr. 4 VO-DV I „Notenliste
   (Notenbuch der Lehrkraft) mit Einzelnoten oder ggf. Teilleistungsnoten je Fach/Kurs … sowie Aufzeichnungen zum Arbeits- und
   Sozialverhalten“; § 4 Abs. 5 erlaubt die Verarbeitung „in ADV-Anlagen“. Das VVT erstellt die Schulleitung (§ 2 Abs. 2 VO-DV II)
   – SchulOS erzeugt es schon (DS-07).
4. Harte Grenze ist **Need-to-know** (§ 120 Abs. 1 S. 2 SchulG): Teilnoten sieht nur die Fachlehrkraft; Klassen-/Schulleitung nur
   Halbjahres-/zeugnisrelevante Noten (Muster: Anlage 3 Abschnitt I vs. II).
5. **Sitzpläne** (Name + Platz) sind abgeleitete Daten aus Klassenlisten (Anlage 2 II Nr. 3, § 1 Abs. 2 S. 4) – unproblematisch.
   **Fotos** sind nicht erforderlich (Hessen: „keine Rechtsgrundlage“, nur Einwilligung) → nur das einwilligungsbasierte Profilbild
   (DS-09).
6. **Empfehlung: Option A** (Server-Speicherung wie andere Module) mit Pflichtmaßnahmen (2FA fürs Modul, protokollierte
   Lesezugriffe, strenge Sichtbarkeit, kurze Löschfristen, kein Browser-Cache, Export protokolliert). E2E-Verschlüsselung (B)
   widerspricht den Pflichten der Schule (Auskunft, Einsicht, Vertretung) und hat ein ungelöstes Recovery-Problem; Offline-first (C)
   ist ein späterer Komfortbaustein.
7. Schule/DSB entscheiden: Genehmigungspraxis für Lehrkräfte ohne Dienstgerät (Browserzugriff vom Privatgerät ist „Verarbeitung“),
   Sichtbarkeit für Schüler:innen/Eltern, Aufbewahrung, Archivexport der Halbjahresnoten. **Amtliche Zeugnisnoten bleiben in der
   Schulverwaltungssoftware** – SchulOS liefert nur den Export.

## 2. Rechtslage (Zitate)

| Quelle | Stand | URL |
|---|---|---|
| SchulG NRW §§ 120–122 (BASS 1-1) | zuletzt geändert 21.07.2026 | https://bass.schule.nrw/6043.htm |
| VO-DV I (BASS 10-44 Nr. 2.1) | zuletzt geändert 23.03.2022 | https://bass.schule.nrw/101.htm |
| VO-DV II (BASS 10-41 Nr. 6.1) | zuletzt geändert 13.12.2021 | https://bass.schule.nrw/1393.htm |
| DA ADV (BASS 10-41 Nr. 4) | RdErl. 19.01.2018 | https://bass.schule.nrw/17585.htm |
| Genehmigungsvordruck (Anlage DA ADV) | 2018 | https://www.schulministerium.nrw/sites/default/files/documents/DienstanweisungAnlage.pdf |
| Handreichung Medienberatung NRW (private Endgeräte) | 2018 | https://media.frag-den-staat.de/files/foi/679754/handreichung-zur-genehmigung-der-nutzung-privater-endgerate.pdf |
| Landtag NRW Drs. 16/1126 (u. a. TeacherTool) | 15.10.2012 | https://landtag.nrw.de/portal/WWW/dokumentenarchiv/Dokument/MMD16-1126.pdf |
| Begründung Änderung VO-DV II | 10.09.2020 | https://media.frag-den-staat.de/files/foi/679754/rs_s_3193_aenderung_vo_dv_ii_begruendung_anl_4.pdf |
| MSB „Fragen und Antworten zum Datenschutz“ | o. D. | https://www.schulministerium.nrw/fragen-und-antworten-zum-datenschutz |
| Hessen KM „Fotositzplan“ | o. D. | https://kultus.hessen.de/digitalisierung/datenschutz-an-schulen/datenschutz-im-taeglichen-schulbetrieb/fotositzplan |

**SchulG NRW.** § 120 Abs. 1: „… soweit dies zur Erfüllung der ihnen durch Rechtsvorschrift übertragenen Aufgaben erforderlich ist.
Die gespeicherten personenbezogenen Daten dürfen in der Schule nur den Personen zugänglich gemacht werden, die sie für die Erfüllung
ihrer Aufgaben benötigen.“ Abs. 2: „Andere Daten dürfen nur mit Einwilligung der betroffenen Personen erhoben werden …“ (Fotos).
Abs. 5: digitale Lehr-/Lernmittel, Lehr- und Lernsysteme, Arbeits- und Kommunikationsplattformen. Abs. 9: Einsicht/Auskunft nur
Eltern und Schüler:innen. § 121 Abs. 1: Lehrkräftedaten, Nutzungspflicht. § 122 Abs. 1: Grundlage Art. 6 Abs. 1 lit. e, Abs. 3,
Art. 9 Abs. 2 lit. g DSGVO. Einen Satz „Lehrkräfte dürfen auf privaten Endgeräten …“ gibt es im SchulG nicht – das steht in den
Verordnungen.

**VO-DV I.**
- § 1 Abs. 2: zugelassene Daten in den Anlagen; abgeleitete Daten und Auswertungen eingeschlossen.
- **§ 2 Abs. 1:** „Die automatisierte Verarbeitung der personenbezogenen Daten ist zulässig auf dienstlichen digitalen Geräten und
  in Netzwerken, wenn jeweils über die Konfiguration die Vertraulichkeit, Integrität und Verfügbarkeit gemäß Artikel 32 … gewährleistet
  sind. Insbesondere ist sicherzustellen, dass Berechtigte nur Zugang zu personenbezogenen Daten erhalten, die für die jeweilige
  Aufgabenerfüllung erforderlich sind. … Verarbeitung von Protokolldaten nur zulässig, soweit dies zum Betrieb technisch erforderlich
  ist.“
- **§ 2 Abs. 2:** private Geräte nur mit schriftlicher Genehmigung der Schulleitung (inkl. VVT), nur bei Erforderlichkeit und
  nachgewiesenem Zugangsschutz, Daten nach Anlage 3; „Die Genehmigung darf nicht erteilt werden, wenn ein persönliches dienstliches
  digitales Gerät für schulische Zwecke zur Verfügung gestellt wird. Eine bereits erteilte Genehmigung erlischt mit Aushändigung eines
  solchen Gerätes.“ Schule bleibt Verantwortliche.
- § 2 Abs. 3: Auftragsverarbeitung nach Art. 28 (Schulträger als Betreiber → AV-Vertrag).
- **§ 4 Abs. 5:** sonstiger Datenbestand (Anlage 2) – „eine Verarbeitung in ADV-Anlagen ist mit den Einschränkungen des § 1 Abs. 2
  zulässig“; Abs. 6: Einsicht durch Lehrkräfte, soweit erforderlich, Genehmigung durch Schulleitung.
- **Anlage 2:** I. obligatorisch „1. das Klassenbuch“, „2. Liste der schriftlichen Arbeiten und deren Ergebnisse“; II. „3.
  Auflistungen … (z. B. … Klassenlisten)“, „**4. Notenliste (Notenbuch der Lehrkraft) mit Einzelnoten oder ggf.
  Teilleistungsnoten je Fach/Kurs …**“, „5. Notenspiegel …; Zensurenliste“.
- Anlage 1 A 1.13 „Foto“ – freiwillig und widerrufbar. Anlage 1 B: Leistungsdaten im Stammblatt.
- **Anlage 3** (Privatgeräte, zugleich Sichtbarkeitsmuster): I. unterrichtende Lehrkraft – Leistungsbewertungen und Bemerkungen zum
  AV/SV in den eigenen Fächern, Fehlzeiten in den eigenen Fächern; II. stellv. Schulleitung/Klassen-/Jahrgangsstufenleitung
  zusätzlich Halbjahresnoten aller Fächer, zeugnisrelevante Angaben, Zeugnisbemerkungen. Fotos fehlen.
- **§ 9:** Zeugnislisten/Klassenbuch/Prüfungsakten 10 Jahre, übrige Daten 5 Jahre (Beginn frühestens Ende der Schulpflicht);
  Privatgeräte 1 Jahr.

**VO-DV II.** § 2 Abs. 1 wortgleich; § 2 Abs. 2: Schulleitung entscheidet über automatisierte Verarbeitung und erstellt das VVT;
§ 3 Auftragsverarbeitung; Begründung 2020: mit Dienstgerät entfällt die Erforderlichkeit des Privatgeräts.

**DA ADV / Vordruck / Handreichung – was wirklich verboten ist.**
- DA ADV Nr. 1: schuleigene Anlagen und kommunale Rechenzentren zulässig. **Aber:** auf Anlagen mit Schülerzugang keine lokale
  Verarbeitung von Zeugnissen, sonderpädagogischen Gutachten, Lern- und Förderempfehlungen (§ 50 Abs. 3) und Benachrichtigungen
  (§ 50 Abs. 4) → **gehören nicht in SchulOS**. Teilnoten/Notenbuch sind dort nicht genannt.
- Nr. 3: Verfahrensverzeichnis, Vorabkontrolle durch die DSB vor Echtdaten. Nr. 11.1: Privatgeräte nur mit Genehmigung (Vordruck).
  Nr. 11.4: feststellbar, wer wann was eingegeben hat (→ Audit).
- **Vordruck Teil B Nr. 4 (das eigentliche „Cloud-Verbot“):** Backups in Cloudspeicher und cloudbasierte Anwendungen ohne
  AV-Vertrag mit der Schulleitung sind unzulässig. Teil B Nr. 1: Sperre nach max. 15 min, Verschlüsselung; LOGINEO-Online-Editor
  wird *bevorzugt* (nichts lokal). Teil A Nr. 7: Löschfrist 1 Jahr inkl. Backups. 3.3: Bilder nur mit Einverständnis.
- Handreichung: „Es sind ausschließlich Webanwendungen und Clouddienste zulässig, bei denen die Schule ein Verfahrensverzeichnis
  führt und eine offizielle Vereinbarung über die Datenverarbeitung im Auftrag … existiert.“ Lehrkraft nur Daten ihrer Lerngruppen.

**Lesart:** Die Vorgabe lautet nicht „lokal“, sondern **„kein Drittanbieter ohne Vertrag, kein unkontrolliertes Gerät“**.

**MSB/Landtag zu Lehrer-Apps.** Drs. 16/1126 (2012), Frage zu TeacherTool: welche Software auf privaten Anlagen genutzt werden darf,
bestimmt die Genehmigung der Schulleitung; grundsätzlich dienstliche Arbeitsplätze, Privatgeräte nur in Ausnahmefällen – keine
Positivliste, kein App-Verbot. MSB-FAQ (zusammengefasst): Privatgeräte nur ohne dienstliches Gerät; Datenkatalog Anlage 3; schon
Betrachten ist Verarbeitung; dienstlicher Zugriff vom Privatgerät über ein schulisch bereitgestelltes System **und** mit Genehmigung.

**Sitzpläne/Fotos.** Name + Platz = abgeleitet aus Klassenliste, Zweck Unterrichtsorganisation. Fotos: nur mit Einwilligung (Hessen:
„Für die Anfertigung eines Fotositzplans steht keine Rechtsgrundlage zur Verfügung.“; NRW über § 120 Abs. 2/6 gleiches Ergebnis).
Andere Länder (Niedersachsen, Bayern, nur Sekundärquellen) bestätigen: Problem = Privatgerät/Drittanbieter, nicht Server der Schule.

**Folgerungen (Anforderung → Maßnahme).**

| Anforderung | Maßnahme in SchulOS |
|---|---|
| Need-to-know (§ 120 Abs. 1 S. 2; § 2 Abs. 1 VO-DV I; Anlage 3) | Teilnoten nur Fachlehrkräfte des Lehrauftrags; KL/SL nur Halbjahreswerte; Verwaltung nichts (kein `view_all`) |
| VVT (§ 2 Abs. 2 VO-DV II; DA ADV Nr. 3) | `processing` + `retention` im Manifest → DS-07/DS-12 |
| Protokollierung (DA ADV 11.4) | Audit Schreiben, `auditRead("lesen.notenbuch")` bei Fremdzugriff, Export protokolliert |
| Zugangsschutz, 15-min-Sperre (Vordruck B1) | 2FA-Pflicht fürs Modul, kürzerer Inaktivitätsablauf (P4-71) |
| Kein Drittanbieter ohne Vertrag (Vordruck B4) | eigener Server; Schulträger → AV; kein Push/CDN |
| Keine Zeugnisse auf Systemen mit Schülerzugang (DA ADV Nr. 1) | kein Zeugnisdruck/-bemerkungen/§ 50-Briefe; nur CSV-Export |
| Keine Art.-9-Daten im Freitext | Kurzkommentar mit Hinweis, keine Beobachtungsnotizen in V1 |
| Privatgerät = Genehmigung | nichts lokal (`no-store`, kein SW-Cache), Hinweis + Nutzungsordnungs-Baustein |
| Fristen (§ 9) | Teilnoten LK-SJ-1J; Halbjahresliste optional im Archiv; Sitzplan LK-SJ |
| Fotos nur mit Einwilligung | nur Profilbilder (DS-09), Druck ohne Fotos |
| Einsicht/Auskunft (§ 120 Abs. 9) | `exportForUser()` liefert Noten + Kommentare des Kindes |

**Nicht im Wortlaut verifiziert:** aktuelle LDI-Stellungnahme (alte Seite offline); LOGINEO-FAQ 2022 (hinter Login); Landtag Drs.
17/17088 (nur Snippet); MSB-FAQ nur zusammengefasst; Bayern/Niedersachsen nur Suchtreffer. Auslegungsfragen für die DSB: Papierfassung
des Notenbuchs nach § 4 Abs. 5 nötig?; „Liste der schriftlichen Arbeiten“ 5 oder 10 Jahre?; braucht Browserzugriff vom Privatgerät
ohne lokale Speicherung eine Genehmigung (MSB-FAQ: ja – Plan geht davon aus).

## 3. Optionen

| | A) Server-Speicherung | B) Ende-zu-Ende-verschlüsselt | C) Lokal/offline-first |
|---|---|---|---|
| Recht | passt genau (§ 2 Abs. 1 VO-DV I, DA ADV Nr. 1); Schule bleibt handlungsfähig | nicht gefordert; behindert Auskunft, Einsicht, Vertretung, Löschung, Audit | auf Privatgeräten zusätzlich § 2 Abs. 2 (Genehmigung, 1 Jahr, Löschpflicht) |
| Sicherheit | Serverkompromittierung = lesbar (wie Klassenbuch); LUKS, 2FA, Audit, Außenzugang | schützt vor Betreiber/Dumps; Schlüsselverlust = Notenverlust, Recovery hebt Schutz auf, XSS = Schlüsselklau | Gerätediebstahl, Sync-Konflikte, Browser-Storage flüchtig |
| Aufwand | M–L, nutzt Vorhandenes | L+ (Krypto, Key-Mgmt, Recovery) | L (Sync, Konflikte, verschlüsselter Cache) |

**Empfehlung A** mit den Maßnahmen oben. B verworfen; C später nur für Dienstgeräte (P5-20).

**Abgrenzung:** SchulOS-Notenbuch = **Arbeitsnotenbuch der Fachlehrkraft** (Anlage 2 II Nr. 4): Teilnoten, Gewichtung, Vorschlag der
Halbjahresnote. Amtliche Zeugnisnoten/Zeugnisse/Bemerkungen/§ 50-Benachrichtigungen bleiben in der Schulverwaltungssoftware; SchulOS
liefert CSV-Export und Übergabeliste je Klasse. PHASE4 §5.2 („Zeugnis-/Notenverwaltung nicht empfohlen“) bleibt für amtliche Zeugnisse
richtig.

## 4. Plan – Block 5a

**Einordnung (korrigiert 2026-10-13 nach §0):** Block 5a liegt **nach 4d und vor 4e** → GATE 5a mit `/code-review ultra` +
`/security-review` → weiter mit 4e → **Release v0.5.0** (nach 4e, enthält 5a). Was 5a aus 4e braucht, baut 5a modulbezogen selbst:
2FA-Pflicht nur fürs Notenbuch (statt SEC-01), kurzer Inaktivitätsablauf für Notenbuch-Seiten (statt P4-71), `no-store` und
PWA-Ausschluss (statt P4-73) – 4e verallgemeinert das später. Sitzplan (P5-01…04) lief mit 4d (F5-02, Release v0.4.0).
Abarbeitung über `docs/BACKLOG.md` „5a Notenbuch“.

**Module:** `notenbuch` („Notenbuch“, Bereich Unterricht), `sitzplan` („Sitzplan“) – per Update **ausgeschaltet** (B-34).
Rechtsgrundlage: Art. 6 Abs. 1 lit. e DSGVO i. V. m. § 120 Abs. 1, 5 SchulG NRW, § 4 Abs. 5 i. V. m. Anlage 2 II Nr. 4 bzw. Nr. 3 VO-DV I.

**Datenmodell (grob).**

| Tabelle | Felder (Auszug) | `retention` |
|---|---|---|
| `notenbuch_books` | school_year_id, term, group_id, subject_id, assignment_id?, scale (`noten6`, `noten6_tendenz`, `punkte15`), weights, locked_at, created_by | LK-SJ-1J (Vorschlag) |
| `notenbuch_book_teachers` | book_id, teacher_id | follows |
| `notenbuch_columns` | book_id, kind, title, date, weight, max_points, points_to_grade, exam_id?, order | follows |
| `notenbuch_entries` | column_id, student_id, value (Note/Punkte/`fehlt`/`befreit`), comment ≤ 200, updated_by/at | follows |
| `notenbuch_term_grades` | book_id, student_id, computed, final, finalized_at | follows; KL/SL sehen nur diese |
| `sitzplan_plans` | group_id, room_id?, subject_id?, owner_id, title, layout, school_year_id | LK-SJ |
| `sitzplan_seats` | plan_id, student_id, row, col | follows |

**Rechte:** `notenbuch.own` (Lehrkraft, eigene Lehraufträge) · `notenbuch.term_view` (KL automatisch, Gruppe Schulleitung; Lesen
protokolliert) · `notenbuch.transfer` (Schulleitung, admin) · `notenbuch.export` (Schulleitung; Verwaltung nur Export, nie Teilnoten)
· `sitzplan.edit` (Lehrkraft; sehen: Lehrkräfte der Gruppe + KL) · **kein `view_all`, Admin-`*` greift nicht** (expliziter Test).

**Einstellungen:** Noten für Schüler:innen sichtbar (Vorgabe aus), Eltern bis Jahrgang (aus), 2FA fest an, Teilnoten-Frist fest,
Profilbilder im Sitzplan (an, nur mit Einwilligung).

**Aufgaben** (S < 1 h · M 1–3 h · L = 2 Commits; Opus, Abweichung ausdrücklich):
- [x] **P5-00** (S) Datenschutz-Vorlauf: DSB-FRAGEN §15 Notenbuch / §16 Sitzplan, Checkliste, DATENSCHUTZ §3.4/§5, Fahrplan
- [x] **P5-01** (M) `sitzplan` Grundgerüst: Manifest, Schema, Migration, Service (Sichtbarkeit), Tests
- [x] **P5-02** (M) Sitzplan-Editor: Raster/Tischblöcke, Drag & Drop + Tastaturweg (A11y), Initialen/Profilbild, zufällig/alphabetisch,
  Kopie, Druck ohne Fotos; Lizenz der DnD-Bibliothek prüfen
- [x] **P5-03** (S) Einbindung: Klassenbuch-Eintrag zeigt Sitzplan (Fehlzeit per Klick), Kursraum-Reiter, Tagesleiste, Suche
- [x] **P5-04** (S) Datenschutz + E2E Sitzplan; SICHERHEIT S-Eintrag (Schüler/Eltern/Verwaltung sehen nichts, fremde Gruppen 404)
- [x] **P5-10** (M) `notenbuch` Grundgerüst + reine Rechenlogik `berechnung.ts` (Gewichtung, Notenschlüssel, Rundung, Tendenz,
  15 Punkte), Tabellentests
- [x] **P5-11** (M) Rechte/Sichtbarkeit im Service, `auditRead`, `transfer`, **2FA-Pflicht fürs Modul**, kein Admin-Override; SICHERHEIT
- [x] **P5-12** (M) Notentabelle: Tastatureingabe, Spalten (auch aus Klausurplan), Kommentar mit Hinweis, Live-Berechnung,
  Fehlstunden-Zähler aus eigenen Stunden (ohne Grund), Notenspiegel ohne Namen; `no-store`, kein SW-Cache
- [x] **P5-13** (M) Halbjahresabschluss: Vorschlag → Festlegen → Sperren; Übergabeliste je Klasse (Lesen protokolliert, „Entwurf –
  amtlich ist die Schulverwaltungssoftware“); CSV-Export (POST, Audit) – kein Zeugnisdruck
- [x] **P5-14** (S) Schüler-/Elternsicht als Einstellung (Vorgabe aus)
- [x] **P5-15** (S) Lebenszyklus: Schuljahreswechsel, Abgang einer Lehrkraft, Löschlauf, Auskunft
- [x] **P5-16** (S) Widgets/Verknüpfungen (nur für die Person selbst, keine Lehrkräfte-Statistik)
- [x] **P5-17** (S) Datenschutz-Doku, Nutzungsordnungs-Baustein, Hinweis beim ersten Öffnen
- [x] **P5-18** (M) E2E Gate 5a (`e2e/zx-gate5a.spec.ts`; `/security-review` am GATE 5a durch die Projektleitung)
- [ ] **GATE 5a** → weiter mit 4e → Release v0.5.0

- [x] **P5-20** (L) Offline-Eingabe auf Dienstgeräten (verschlüsselter IndexedDB-Cache, Sync, Konflikte) – **in V1 (F5-15), Fable (F5-16)** → §6

Später, nicht in V1: **P5-21** Beobachtungsnotizen erst nach DSB-Votum; E2EE nicht geplant.

## 6. Offline-Eingabe auf Dienstgeräten (P5-20) – umgesetzt 2026-10-13

**Wo erlaubt.** Moduleinstellung `notenbuch.offline` (Verwaltung → Rechte & Module → Notenbuch): `aus` · **`zertifikat` (Vorgabe)** =
nur Geräte mit gültigem, freigegebenem Gerätezertifikat der Schule (P4-40b, `certCheck`; nur von außen sichtbar, weil Caddy im
Schulnetz keine Client-Zertifikate prüft) · `schulnetz` = zusätzlich Geräte im Schulnetz, dann bestätigt die Lehrkraft beim
Einschalten je Gerät „Dies ist ein Dienstgerät der Schule“ (Dienstanweisung-Baustein §15). Von außen ohne Zertifikat (Privatgerät)
nie – dort entsteht kein Cache (§ 2 Abs. 2 VO-DV I). Entscheidung je Anfrage aus den Caddy-Kennzeichen (`offline-reasons.ts`,
`decideOffline`, im Zweifel nein); Begründung der Vorgabe in Q-5A-24.

**Schlüssel (`offline-crypto.ts`).** Beim Einschalten erzeugt der Browser 32 zufällige Bytes und importiert sie sofort als
**nicht exportierbaren** HKDF-CryptoKey (Geräteanteil, in IndexedDB); der Server erzeugt je Gerät 32 zufällige Bytes
(Server-Anteil, `notenbuch_offline_devices`, Migration 0076). Der AES-GCM-256-Cache-Schlüssel entsteht per HKDF aus beiden
Anteilen + Gerätekennung nur im Arbeitsspeicher der Seite; der Server-Anteil wird im Browser nie gespeichert. Er geht nur an eine
zweifaktor-geprüfte, nicht gesperrte Notenbuch-Sitzung derselben Person mit `notenbuch.own`; die Zeile gehört **Person + Gerät**
und merkt sich nur die zuletzt genutzte Sitzung (GATE-5a, Q-5A-28): **echtes Abmelden** löscht sie (der Browser warnt vorher), die
Neuanmeldung aus der 15-Minuten-Sperre nicht (neu gebunden), **Rechteentzug** beim Abruf, **Frist** 7 Tage (nächtlicher Lauf),
**Ausschalten** durch die Person; Geräte anderer Personen bleiben unberührt (IndexedDB je Konto). Nicht mehr erlaubt (z. B. jetzt
Privatgerät, Q-5A-31) oder Frist abgelaufen → Anteil nur noch zum Übertragen der Warteschlangen **aller** Bücher (Frist = jetzt);
erst wenn nichts mehr offen ist (auch keine Konflikte), schaltet der Browser aus und löscht seinen Cache (Q-5A-32).
Halbjahresabschluss/Vorjahr: der Abgleich lehnt ab, die Tabelle ist ohnehin nur lesbar. Jeder Eintrag hat einen eigenen IV und ist
an Gerät/Buch gebunden (AAD).

**Cache-Inhalt.** Nur die noch nicht übertragenen Teilnoten (Wert, Kommentar, Grundrevision) des eigenen Buchs – keine Kopie der
Tabelle: ohne Service Worker (P4-73 offen, Notenbuch-Pfade bleiben `no-store`, S46) lässt sich ohne Verbindung keine Seite laden;
offline weiterarbeiten kann nur die **schon offene** Notentabelle. Stirbt der Tab, bleibt die verschlüsselte Warteschlange und wird
beim nächsten Öffnen des Buchs mit Verbindung abgeglichen. Halbjahresnoten, Spalten, Gewichte nur online (Q-5A-13 bleibt).

**Abgleich (`offline-sync.ts`, `offline.ts`).** Revision je Zelle (`notenbuch_entries.version`, seit GATE-5a aus einer Sequenz –
monoton auch über Löschen und Neuanlage; Konflikte bleiben bis zur Auflösung in der Warteschlange): Änderung nur, wenn die Grundrevision
noch stimmt (`setEntry` mit `expectedVersion` – dieselben Prüfungen und Spuren wie online); trägt der Server schon genau diesen Wert,
gilt sie als angewendet (**idempotent**, Wiederholung nach verlorener Antwort gefahrlos); sonst **Konflikt** ohne Überschreiben –
die Tabelle zeigt Server-Wert (ggf. mit Name der anderen Lehrkraft) gegen lokale Eingabe, Auflösung je Zelle („Meine Eingabe
übernehmen“ setzt auf die Server-Revision neu auf, „Server-Wert behalten“ verwirft). Je Zelle höchstens eine Änderung in der
Warteschlange (spätere ersetzt Wert/Kommentar, Grundrevision bleibt). Audit `notenbuch.offline.ein/aus/abgleich` mit Zahlen und
Gerätekennung, nie Noten (DA ADV 11.4). Sicherheit: S52, S53.

**Tests.** Vitest `offline-sync.test.ts` (rein), `offline-crypto.test.ts` (WebCrypto in Node), `offline.test.ts` (Einstellung ×
Zone × Zertifikat, Lebenszyklus des Anteils, Abgleich/Konflikt/Sperre/Audit); Playwright `e2e/offline-notenbuch.spec.ts` (Vorgabe
ohne CA → nicht verfügbar, Schulnetz mit Bestätigung, offline eintragen → `setOffline` → Abgleich, Konflikt mit beiden Auflösungen,
Privatgerät von außen, Ausschalten).

## 5. Fragen an die Projektleitung (Vorschlag = Vorgabe)

1. **F5-01** Block 5a nach 4e/v0.5.0? — ja.
2. **F5-02** Sitzplan (P5-01…04) vorziehen, mit 4d? — ja.
3. **F5-03** Umfang V1: Teilnoten, Gewichtung, Halbjahresvorschlag, Übergabeliste, CSV; keine Zeugnisse/Bemerkungen/§ 50-Briefe? — ja.
4. **F5-04** Skalen 1–6, mit Tendenz, 15 Punkte; Notenschlüssel je Spalte; Gewichtung in % je Buch? — ja.
5. **F5-05** Teilnoten nur Fachlehrkräfte; KL/Schulleitung nur Halbjahreswerte (protokolliert); Verwaltung/Admin gar nichts? — ja.
6. **F5-06** Noten für Schüler:innen/Eltern sichtbar per Einstellung, Vorgabe aus? — so.
7. **F5-07** 2FA-Pflicht fürs Notenbuch schon vor dem SEC-01-Stichtag? — ja.
8. **F5-08** Nur Kurzkommentar je Note, keine Beobachtungsnotizen/AV-SV in V1? — ja.
9. **F5-09** Fotos nur über Profilbilder mit Einwilligung, Druck ohne Fotos? — ja.
10. **F5-10** Fehlzeiten nur als Zähler aus eigenen Stunden, ohne Grund? — ja.
11. **F5-11** Teilnoten LK-SJ-1J; Halbjahresliste optional im Archiv (Frist klärt DSB)? — so.
12. **F5-12** Eigenexport der Lehrkraft ohne Notenbücher (Daten der Schule), Übergabe per `transfer`? — so.
13. **F5-13** Mitlehrkräfte gleichberechtigt, Vertretung kein Zugriff (nur per Übertragung)? — ja.
14. **F5-14** Hinweis beim ersten Öffnen + Nutzungsordnungs-Baustein? — ja.
15. **F5-15** Offline (P5-20) und E2EE nicht in V1; P5-20 als Fable-Aufgabe notieren, E2EE verwerfen? — ja.
16. **F5-16** Alles Opus, Gate 5a mit Ultra-Review durch die Projektleitung? — ja.
