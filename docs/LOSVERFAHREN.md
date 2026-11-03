# Losverfahren bei Anmeldeüberhang (Schulanmeldung, LO-01…LO-03)

Freigegeben von der Projektleitung 2026-11-02 (Runde 13). Hebt Q-34 („kein Losverfahren in V1“, Schulanmeldung) für ein eigenes,
protokolliertes Werkzeug auf. Code: `src/modules/anmeldung/los.ts` (Service), `src/core/los.ts` (Losreihenfolge, gemeinsam mit der
Kurswahl), Seiten `/verwaltung/anmeldung/<verfahren>/los/<lauf>` und `/druck/anmeldung-los/<lauf>`, Handbuch-Starter-Seite
„Schulanmeldung: Losverfahren bei Anmeldeüberhang“.

## 1. Problem und Nutzen

- **Schulleitung:** Bei Anmeldeüberhang ist das Los ein zulässiges Kriterium, in NRW nach § 1 Abs. 2 APO-S I nach Geschwistern,
  Schulweg und ausgewogenem Verhältnis (**zu prüfen**, je Land und Schulform verschieden). Heute wird oft außerhalb von SchulOS gelost
  (Zettel, Tabellenkalkulation) – schwer nachweisbar bei Widerspruch oder Klage. Das protokollierte, nachrechenbare Los gibt einen
  Nachweis und spart das Abtippen in die Entscheidungsliste.
- **Sekretariat:** Die Wartelisten-Reihenfolge steht danach fest (Rang in Liste und Export).
- **Eltern:** indirekt; keine neue Elternansicht, keine Mitteilung des Losergebnisses (Bescheid weiter per Post, Q-35).

## 2. Entscheidungen (Projektleitung 2026-11-02)

1. **Wer lost:** nur `anmeldung.decide` (Schulleitung), ohne zweite Bestätigung; Zeug:innen stehen im Protokoll.
2. **Zufallsquelle:** SchulOS-Seed, Hash vorab angezeigt (Commit-Reveal), Reihenfolge jederzeit nachrechenbar.
3. **Ergebnis:** Rangliste als Vorschlag, Übernahme per Klick (Aufnahme Rang 1…N, Rest Warteliste mit Rang).
4. **Neu losen:** nur mit Pflicht-Begründung, der alte Lauf bleibt im Protokoll sichtbar.
5. **Protokoll:** gespeichert nur Antragsnummern, Seed und Zeug:innen-Funktionen; Namen nur im Druck.

## 3. Ablauf

| Schritt | Wer | Was passiert |
|---|---|---|
| Losgruppe bilden | `anmeldung.decide` | In der Entscheidungsliste offene Anträge ankreuzen (eingegangen, Termin, Unterlagen vollständig), Plätze N eintragen (1 ≤ N < Anzahl). Seed (128 Bit, Zufallsgenerator des Betriebssystems) entsteht und wird gespeichert, angezeigt wird nur sein SHA-256 („Prüfwert“). Teilnehmende werden nach Vorgangsnummer gespeichert, nicht in Klickreihenfolge |
| Prüfwert zeigen | – | Den Zeug:innen zeigen bzw. ins Protokoll übernehmen (Druck geht schon vor dem Ziehen) |
| Los ziehen | `anmeldung.decide` | Seed wird aufgedeckt, Reihenfolge = `lotOrder(seed, Vorgangsnummern)`; Zeug:innen nur als Funktionen (höchstens 300 Zeichen). Nur aus „vorbereitet“, nur solange alle Anträge noch offen sind |
| Ergebnis übernehmen | `anmeldung.decide` | Rang 1…N „aufgenommen“, Rest „Warteliste“ mit `waitlist_rank` 1, 2 …, über die bestehende Entscheidung (`decide`: Statusmaschine, Verlauf, Mail „Bescheid folgt per Post“ bei der ersten Entscheidung); je Antrag Notiz „Losverfahren Lauf k: Rang n von m“. Alles oder nichts in einer Transaktion |
| Neu losen | `anmeldung.decide` | Nur nach dem Ziehen und vor der Übernahme, nur mit Begründung (höchstens 500 Zeichen): alter Lauf → „verworfen“ mit Begründung, neuer Lauf mit gleicher Gruppe und Platzzahl, neuem Seed und Verweis auf den alten |
| Verwerfen | `anmeldung.decide` | Vor dem Ziehen ohne Begründung (es ist nichts gelost), danach nur mit Begründung; übernommene Läufe nie |
| Lesen, Druck | `anmeldung.view` | Läufe auf der Entscheidungsseite, Laufseite, Protokoll-Druck (A4) mit Namen aus den noch vorhandenen Anträgen |

## 4. Nachrechnen

`src/core/los.ts` (unverändert aus der Kurswahl übernommen, P4-63/Q-4D-24 – bestehende Kurswahl-Ergebnisse bleiben gleich):

1. SHA-256 (hex) des Seeds (Text, UTF-8) = angezeigter Prüfwert.
2. Für jede Vorgangsnummer `A-JJJJ-nnnn` den Text `<seed>:<nummer>` mit FNV-1a (32 Bit, Startwert `0x811c9dc5`, Primzahl
   `0x01000193`) hashen.
3. Aufsteigend nach dem Hash sortieren, bei Gleichstand nach der Nummer: das ist die Rangliste.

Die Laufseite und der Druck rechnen beim Anzeigen nach („Seed passt zum Prüfwert, Reihenfolge stimmt“); der E2E-Test rechnet mit
eigenem Code nach. Feste Prüfwerte in `src/core/los.test.ts` – ändert sich der Algorithmus, wären alte Protokolle nicht mehr
nachrechenbar.

## 5. Datenmodell (Migration 0130)

- `anmeldung_lose`: Verfahren, laufende Nummer je Verfahren, Stand (`vorbereitet`/`gezogen`/`uebernommen`/`verworfen`), Plätze,
  Teilnehmende `{ id, number }[]`, Seed, Seed-Hash, gezogene Reihenfolge (Nummern), Zeug:innen (Funktionen), Begründung, ersetzter
  Lauf, vorbereitet/gezogen/übernommen/verworfen von und am.
- `anmeldung_antraege.waitlist_rank`: Rang auf der Warteliste aus einem übernommenen Lauf; fällt beim Verlassen der Warteliste weg
  (Nachrücken, Ablehnung, Korrektur), die übrigen behalten ihre Zahl.

## 6. Datenschutz

- Protokoll ohne Namen; Namen kommen nur in Anzeige und Druck aus den Anträgen dazu (gelöschte Anträge: nur noch die Nummer).
- Löschklasse: `anmeldung_lose` folgt `anmeldung_verfahren` (LK-ENDE-1J ab Abschluss) – deckt Widerspruchs- und Klagefrist; die
  Anträge selbst bleiben bei LK-90/Q-36. Der Wartelisten-Rang gehört zum Antrag.
- Kein Art.-9-Bezug; Begründungsfeld mit Hinweis „keine Gesundheitsangaben“, Zeug:innen nur als Funktionen.
- Auskunft je Antrag (JSON): Teilnahme an Läufen (Lauf, Stand, gezogener Rang, Zahl der Teilnehmenden) und Wartelisten-Rang – ohne
  andere Teilnehmende. Audit: `anmeldung.los.*` ohne Namen (nur Zahlen), Druck als Lesezugriff `lesen.anmeldung.los`.
- Rechtsgrundlage und Reihenfolge der Kriterien: **zu prüfen** (Hinweis im Handbuch); SchulOS bewertet keine Kriterien.

## 7. Konservativ entschiedene Einzelfragen (bei der Umsetzung, LO-01…03)

- **Nur offene Anträge** können ins Los (nicht Warteliste/abgelehnt) – ein Los über bereits entschiedene Anträge (z. B. Wartelisten
  neu ordnen) bleibt außen vor; Korrekturen laufen über die Entscheidung je Antrag.
- **Ein Antrag in höchstens einem offenen Lauf** (vorbereitet oder gezogen) – verhindert parallele Läufe für dieselbe Gruppe.
- **Neu losen nur vor der Übernahme.** Nach der Übernahme bleibt der Lauf, wie er ist (kein automatisches Zurücknehmen von
  Entscheidungen und Mails).
- **Ändert sich ein Antrag** zwischen Vorbereiten und Ziehen bzw. Übernehmen (z. B. Eltern ziehen zurück), lehnt SchulOS das Ziehen
  bzw. die Übernahme ab – Lauf verwerfen und neu bilden.
- **Platzzahl < Teilnehmende**: sonst „kein Los nötig“. Die Kapazität des Verfahrens wird nicht automatisch eingesetzt (nur
  Information, wie in der Entscheidungsliste).
- **Kein Losverfahren in abgeschlossenen Verfahren und Entwürfen.** Offene Läufe blockieren den Abschluss nicht (ihre Anträge sind
  dann entschieden, Ziehen/Übernehmen geht nicht mehr).
- **Sekretariat** (`anmeldung.view`) sieht Läufe und Protokoll, Lehrkräfte nichts (404). Kein eigenes Recht „losen“.
- **Kein Live-Kanal, keine Mail, keine Monitore**; der Druck ist nur eine Ansicht (nicht gespeichert).

## 8. Später

- Mehrere Losgruppen je Verfahren in einem Protokoll, Zweitwunsch-Weiterleitung.
- Optional externe Zufallsquelle (z. B. gemeinsam vor Ort gewürfelter Zusatz zum Seed) – erst bei Bedarf.
