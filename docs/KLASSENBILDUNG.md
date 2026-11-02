# Klassenbildung – Vorschlag für die Verteilung der Neuaufnahmen

Freigegeben von der Projektleitung am 2026-11-01 (Fragebogen Runde 12). Aufgaben: `docs/BACKLOG.md`, Block „Klassenbildung“
(KB-01 ff.). Herkunft: PHASE4 §5.2 P4-76. Der Vorschlag ersetzt keine Entscheidung: Verteilung und Feinschliff bleiben bei Menschen.

## Problem und Nutzen

- **Sekretariat/Schulleitung:** Die Klassenbildung für die Neuaufnahmen ist Handarbeit. Im Schritt „Neuaufnahmen“ des
  Schuljahreswechsels gibt es schon einen Vorschlag (`proposeAssignment` in `src/modules/anmeldung/uebernahme.ts`), aber er kennt nur
  „gleiche Familie zusammen“ und „reihum nach Grundschule sortiert“. Gewünscht: nachvollziehbarer Vorschlag mit Kennzahlen je
  Klasse (Größe, Anteil je Grundschule, erfüllte Wünsche) und Begründung je Kind.
- **Eltern/Kinder (mittelbar):** Kinder kommen mit mindestens einer bekannten Person in die Klasse; Zwillinge und Wunschpartner werden
  beachtet, ohne dass Eltern ein weiteres Online-Feld ausfüllen.
- **Klassenleitungen (mittelbar):** ausgewogenere Klassen.

## Umfang

- **Stufe 1 (ohne neue Daten):** reine Funktion `klassenbildung.ts` (deterministisch, getestet) mit harten Regeln (Klassengröße ±1 um
  den Richtwert, Familien/Mehrlinge zusammen) und weichen Zielen (Grundschulen gleichmäßig mischen: Gruppen ab 4 Kindern gleichmäßig
  verteilen, Gruppen von 2–3 Kindern zusammenhalten, kein Kind als Einzige:r seiner Grundschule, wenn vermeidbar). Ergebnis:
  Zuordnung + Begründung je Kind + Kennzahlenleiste je Klasse; „Neu vorschlagen“ lässt von Hand gesetzte Kinder („festgepinnt“)
  stehen. Ersetzt die heutige Reihum-Heuristik; Anzeige im bestehenden Schritt
  (`src/app/(shell)/verwaltung/schuljahreswechsel/admissions-step.tsx`).
- **Stufe 2 (Wünsche):** interne „Zusammen“-/„Nicht zusammen“-Wünsche zwischen zwei Anträgen, vom Sekretariat im Vorgang erfasst (aus
  Aufnahmegespräch oder Grundschulbogen), höchstens 2 je Kind; ein gegenseitiger Wunsch zählt doppelt; ohne Begründungstext. Wünsche
  fließen als weiche Ziele ein. Mehrlinge sind standardmäßig zusammen, mit Häkchen je Familie „getrennt“, das das Sekretariat setzt.
- **Ausdrücklich nicht:** Geschlecht oder andere Merkmale erheben (P4-76-Vorgabe), Förderbedarf/Religion/Gesundheit, Sprachenfolge und
  Profilklassen (bleiben Handarbeit), Geschwister an der Schule als Kriterium (das Feld „Geschwisterkind“ bleibt Information),
  automatische Aufnahme- oder Zuteilungsentscheidung, Freundeswunsch im öffentlichen Anmeldeformular, Verteilung bestehender
  Schüler:innen (Umklassung im Jahrgang), Speichern von Entwürfen.
- **Später möglich:** gespeicherter Entwurf mit Freigabe durch die Schulleitung, Profil-/Sprachenfolge-Klassen, Wunschfeld im Elternformular.

## Umsetzung

- **Modul:** bestehend – Logik in `anmeldung` (neu `klassenbildung.ts` neben `uebernahme.ts`, ersetzt/erweitert `proposeAssignment`),
  Oberfläche im Schuljahreswechsel (`verwaltung`). Keine neue Navigation.
- **Tabellen (Stufe 2):** `anmeldung_klassenwuensche` (id, antrag_id → `anmeldung_antraege` cascade, partner_antrag_id → cascade, art
  `zusammen|nicht_zusammen`, erfasst_von, erfasst_am; Unique je Paar und Art). Stufe 1: keine Migration, kein neues Schema.
- **Rechte:** Vorschlag berechnen/anzeigen wie der Schritt heute (`verwaltung.privacy` für die Seite, `verwaltung.users` zum
  Übernehmen, `src/app/(shell)/verwaltung/schuljahreswechsel/page.tsx`). Wünsche erfassen: `anmeldung.manage` über
  `moduleActions("anmeldung")` in `vorgang-actions.tsx`; sichtbar im Vorgang (`vorgang-details.tsx`) nur mit `anmeldung.view`.
  Kein neues Recht.
- **Einstellungen:** Klassengröße-Richtwert (heute Konstante `CLASS_SIZE_HINT` = 27) als Moduleinstellung `anmeldung.klassengroesse`
  (24–30); Gewichtung bleibt fest im Code.
- **Live/Mail/Job:** keiner. Die Berechnung läuft als reine Funktion **im Browser** des Schritts (umgesetzt mit KB-02 statt in einer
  Server Action: die Seite hat die Daten ohnehin, so entsteht keine neue Aktion mit eigener Rechteprüfung). An den Browser geht je Kind
  nur ein neutraler Familienschlüssel, nicht die E-Mail-Adresse. **Entwurf nur im Browser**, nicht gespeichert; die Schulleitung
  prüft die Klassenlisten vor dem Übernehmen.
- **Tests:** Eigenschaften (Größenabweichung ≤ 1, Familien zusammen, Wunsch erfüllt wo möglich), Determinismus, Gegenprobe ohne
  Rechteprüfung; E2E erweitert den vorhandenen Schuljahreswechsel-Test.

## Stand der Umsetzung (KB-01, KB-02)

- `src/modules/anmeldung/klassenbildung.ts`: `proposeClasses()` (Vorschlag) und `explain()` (Begründung je Kind, Kennzahlen je Klasse,
  Hinweise – auch für von Hand geänderte Zuordnungen). Harte Regeln: Klassengrößen höchstens 1 Kind Unterschied (⌊n/k⌋…⌈n/k⌉, Anzahl
  Klassen = ⌈n/Richtwert⌉), Familien als Block (außer „getrennt“), Festgepinntes bleibt, höchstens 2 Wünsche je Kind (weitere ignoriert,
  mit Hinweis). Sprengt Festpinnen eine harte Regel, gewinnt das Festpinnen und der Schritt zeigt einen Hinweis. Weiche Ziele mit festen
  Gewichten: Wünsche, „getrennt“, kein Kind allein aus seiner Grundschule, Gruppen von 2–3 zusammen, Gruppen ab 4 gleichmäßig.
  Verfahren: mehrere gierige Startzuordnungen + lokale Suche (verschieben/tauschen), die beste gewinnt; deterministisch über einen Seed.
  Wünsche und „getrennt“ nimmt die Funktion schon an – erfasst werden sie erst mit KB-03.
- Schritt „Neuaufnahmen“: Begründung je Kind unter der Klassenauswahl, Kennzahlentabelle je Jahrgang (Kinder, festgepinnt,
  Grundschulen, „allein aus ihrer Grundschule“, ab KB-03 erfüllte Wünsche), Knopf „Neu vorschlagen“ (nächster Seed), Häkchen
  „festpinnen“ je Kind; eine von Hand gewählte Klasse wird automatisch festgepinnt. Einstellung `anmeldung.klassengroesse` (24–30,
  Vorgabe 27) unter Verwaltung → Rechte & Module.

## Datenschutz

- Stufe 1 nutzt nur vorhandene Daten (Name, Grundschule, E-Mail für Familienerkennung) – kein neues Datum, keine neue Rechtsgrundlage.
  Die Zuordnung ist ein Vorschlag, die Verwaltung bestätigt jede Klasse (keine Entscheidung mit Rechtswirkung allein durch Automatik,
  Art. 22 nicht berührt).
- Stufe 2: Wünsche sind Daten über Dritte (das Partnerkind). Sie hängen am Antrag und folgen dessen Löschklasse **LK-90**
  (`follows: anmeldung_antraege` im Manifest); kein Freitext, keine Begründung („nicht zusammen“ ohne Grund, damit keine Konflikt- oder
  Gesundheitsdaten hineingeraten). Hinweis im Vorgang: „keine Gründe eintragen“.
- Sichtbarkeit: nur Sekretariat/Schulleitung (`anmeldung.view`/`manage`); Eltern sehen Wünsche nicht, Klassenleitungen nie. Auskunft
  (`src/modules/anmeldung/auskunft.ts`): eigene Wünsche des Kindes ohne Namen des Partnerkindes („Wunsch zusammen mit einem anderen Kind“).
- Kein Geschlecht, keine Art.-9-Merkmale. `processing` im Manifest anpassen (Zweck „Klassenbildung“).

## Aufgaben (Größe)

| Nr. | Aufgabe | Größe | Abhängigkeit |
|---|---|---|---|
| KB-01 | Reine Funktion Klassenbildung + Eigenschaftstests | M | – |
| KB-02 | Anzeige im Schritt „Neuaufnahmen“: Begründung je Kind, Kennzahlen je Klasse, „Neu vorschlagen“, Festpinnen | S | KB-01 |
| KB-03 | Wünsche: Tabelle/Migration, Erfassen im Vorgang, Einbezug in den Vorschlag, „getrennt“-Häkchen, Löschklasse, Auskunft | M | KB-01 |
| KB-04 | Doku (PHASE4-Verweis, DATENSCHUTZ, Handbuch), E2E | S | KB-02, KB-03 |

Gesamt **M** (Stufe 1 allein S–M, ohne Migration auslieferbar).

## Entscheidungen (Projektleitung 2026-11-01)

- **kb-1** Freundeswunsch intern durch das Sekretariat (aus Aufnahmegespräch/Grundschulbogen), höchstens 2 Wünsche je Kind, nicht im Online-Formular. – wie vorgeschlagen
- **kb-2** „Nicht zusammen“-Wünsche zugelassen, gleiche interne Erfassung, ohne Begründungstext. – wie vorgeschlagen
- **kb-3** Grundschulen: Gruppen ab 4 Kindern gleichmäßig auf die Klassen verteilen, Gruppen von 2–3 Kindern zusammenhalten, kein Kind allein aus seiner Grundschule, wenn vermeidbar. – wie vorgeschlagen
- **kb-4** Zwillinge/Mehrlinge standardmäßig zusammen (wie heute bei gleicher E-Mail), mit Häkchen je Familie „getrennt“ durch das Sekretariat. – wie vorgeschlagen
- **kb-5** Geschwister an der Schule kein Kriterium; das Feld „Geschwisterkind“ bleibt reine Information. – wie vorgeschlagen
- **kb-6** Geschlecht wird nicht erhoben und nicht berücksichtigt; Ausgleich macht die Schulleitung bei Bedarf von Hand. – wie vorgeschlagen
- **kb-7** Keine weiteren Kriterien: nur Größe, Grundschule, Familie und Wünsche; Profilklassen bleiben Handarbeit. – wie vorgeschlagen
- **kb-8** Rechte des Schuljahreswechsel-Schritts, Entwurf nur im Browser (nicht gespeichert); die Schulleitung prüft die Klassenlisten vor dem Übernehmen. – wie vorgeschlagen
- **rf-1** Reihenfolge der Runde 12: CA-01 → Betriebsmonitoring → CA Teil A → Klassenbildung Stufe 1–2 (KB-01…03) → Inventar INV-01/02 → CA Teil B → Inventar Rest. – wie vorgeschlagen
