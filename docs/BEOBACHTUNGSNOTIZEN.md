# Beobachtungsnotizen im Notenbuch (nur nach DSB-Votum)

Freigegeben von der Projektleitung am 2026-11-01 (Fragebogen Runde 12) **unter dem Vorbehalt eines positiven schriftlichen Votums der/des
Datenschutzbeauftragten**. Aufgaben: `docs/BACKLOG.md`, Block „Beobachtungsnotizen“ (BN-01 ff.). Verwandt: `docs/PHASE5-NOTENBUCH.md`
(P5-21 „erst nach DSB-Votum“).

## Problem und Nutzen

- **Lehrkraft (Fachlehrkraft):** Das Notenbuch kennt nur Teilnoten mit Kurzkommentar (≤ 200 Zeichen, `notenbuch_entries.comment`). Für
  Elterngespräche, Förderplanung und die Bewertung von Arbeits- und Sozialverhalten fehlen strukturierte Notizen je Schüler:in, die
  nicht an eine einzelne Note hängen. Heute weichen Lehrkräfte auf Papier oder private Dateien aus – genau das soll das Notenbuch
  vermeiden (PHASE5-NOTENBUCH §1).
- **Schüler:in/Eltern:** profitieren mittelbar (besser vorbereitete Gespräche); sehen Notizen nicht im Alltag, haben aber Einsichts- und
  Auskunftsrecht (§ 120 Abs. 9 SchulG NRW, Art. 15 DSGVO).
- **Schulleitung/Verwaltung:** kein Zugriff und kein Nutzen außer Rechtssicherheit (zugelassene Datensammlung: Anlage 2 II Nr. 4 VO-DV I
  nennt „Aufzeichnungen zum Arbeits- und Sozialverhalten“).

## Umfang

- **Dazu:** Beobachtungsnotiz je Schüler:in im Notenbuch eines Lehrauftrags: Datum, Kategorie (Arbeitsverhalten, Sozialverhalten,
  Mitarbeit, Sonstiges), kurzer Freitext bis 300 Zeichen; Liste je Schüler:in im Notenbuch; Notizen in der Auskunft; Löschlauf mit dem
  Buch. Lesen dürfen nur die Fachlehrkräfte des Lehrauftrags (wie Teilnoten, Mitlehrkräfte eingeschlossen), nicht die Klassenleitung.
- **Übertragung eines Notenbuchs (Abgang/Vertretung):** Notizen werden nicht mit übertragen; sie bleiben für die bisherigen Lehrkräfte des
  Buchs lesbar, die übernehmende Lehrkraft sieht nur Noten.
- **Ausdrücklich nicht:** Notizen für Klassenleitung, Schulleitung oder Verwaltung; Sicht für Schüler:innen/Eltern im Alltag;
  Zeugnisbemerkungen oder Zeugnisdruck; Diagnose-, Förder- oder Gesundheitsangaben; Notizen im Offline-Cache (nur online, nicht in
  IndexedDB); Anhänge/Fotos; Einfluss auf die berechnete Note.
- **Spätere Stufen:** PDF-Auszug „Elterngespräch“ der eigenen Notizen (protokolliert); Verknüpfung in den Sprechtag.
- **Voraussetzung:** schriftliches Votum der/des Datenschutzbeauftragten; bis dahin Moduleinstellung aus (Vorgabe) und keine Umsetzung
  über die Ergänzung der DSB-Fragen hinaus.

## Umsetzung

- **Modul:** bestehend `notenbuch`. Neue Tabelle `notenbuch_notes` in `src/modules/notenbuch/schema.ts` (id, book_id → `notenbuch_books`
  cascade, student_id → users cascade, author_id → users set null, Kategorie-Enum, `noted_on`, Text mit Check ≤ 300 Zeichen, version,
  created/updated_at; Index (book_id, student_id)). Eine Migration, kein Umbau bestehender Tabellen.
- **Rechte:** kein neues Recht: `notenbuch.own` plus Prüfung „Lehrkraft des Buchs“ im Service (`src/modules/notenbuch/service.ts`, gleiche
  Regel wie Teilnoten). Alles über `moduleActions("notenbuch")`; Schüler- und Elternrollen bleiben gesperrt (`NOTENBUCH_ROLES`,
  `src/modules/notenbuch/rollen.ts`). Auskunft über das bestehende Recht `notenbuch.auskunft`.
- **Moduleinstellung:** `notenbuch.notes` (aus/an, Vorgabe aus) in `src/modules/notenbuch/settings.ts`; zusätzlich `NOTICE_VERSION` in
  `src/modules/notenbuch/hinweis.ts` anheben, damit alle den ergänzten Datenschutzhinweis bestätigen.
- **UI:** Panel „Beobachtungen“ je Zeile/Schüler:in in `src/app/(shell)/notenbuch/[id]/` (neben `tabelle.tsx`), `no-store` und kein
  SW-Cache wie die übrigen Notenbuch-Seiten; Hinweis über dem Eingabefeld („Sachlich und so, dass das Kind es lesen kann; keine
  Gesundheits-, Diagnose- oder Familienangaben“); Warnung (keine Sperre) bei Diagnosewörtern aus einer kleinen Liste im Code;
  Baustein für die Nutzungsordnung; Hinweis beim ersten Öffnen.
- **Live-Kanal/Mail/Job:** keiner. **Offline:** Notizen nicht in `offline-queue.ts`/IndexedDB.
- **Lebenszyklus:** Löschung mit dem Buch (Manifest `follows: notenbuch_books`, LK-SJ-1J); Auskunft in `src/modules/notenbuch/auskunft.ts`
  um den Abschnitt „beobachtungen“ ergänzen (`restricted.tables`/`sections`); Audit `notenbuch.note.*` ohne Text; kein Fremdzugriff,
  daher kein `auditRead` nötig, die Auskunft bleibt protokolliert.
- **Doku:** PHASE5-NOTENBUCH §3 (Zeile „Keine Art.-9-Daten im Freitext“) und den Notenbuch-Abschnitt in DSB-FRAGEN anpassen.

## Datenschutz

- Personenbezug: ja, Kind plus Lehrkraft (Autor:in); Freitext mit Nähe zu Art. 9 (Verhalten und Auffälligkeiten können Rückschlüsse
  auf Gesundheit/Förderbedarf erlauben).
- Löschklasse: **LK-SJ-1J** über `notenbuch_books` (Schuljahresende + 1 Jahr), kein eigener Fristbeginn; Notizen sind kein Archivbestandteil.
- Art. 9 vermeiden: feste Kategorien, Zeichenlimit 300, Hinweis am Feld, Warnung bei Diagnosewörtern, Baustein für die Nutzungsordnung,
  Hinweis beim ersten Öffnen.
- Sichtbarkeit je Rolle: Fachlehrkräfte des Lehrauftrags ja; Klassenleitung, Schulleitung, Verwaltung, Admin nein; Schüler:innen und
  Eltern nur über Auskunft/Einsicht durch eine berechtigte Person (`notenbuch.auskunft`, nie Admin-Konten).
- Auskunft: Notizen sind Teil der Auskunft nach Art. 15 und der Einsicht nach § 120 Abs. 9; Berichtigung durch die Autor:in, Löschung auf
  Antrag über die Verwaltung (Datenschutz).
- **Blocker:** Votum der/des Datenschutzbeauftragten zu Rechtsgrundlage (Anlage 2 II Nr. 4 VO-DV I), Art. 9 und Aufbewahrung.

## Aufgaben (Größe)

| Nr. | Aufgabe | Größe | Abhängigkeit |
|---|---|---|---|
| BN-01 | DSB-Fragen ergänzen: neues Thema in der DSB-Checkliste (`checkliste.ts`), `docs/DSB-FRAGEN.md` neu erzeugen, Test grün; Votum einholen | S | – (jetzt dran) |
| BN-02 | Schema, Migration, Service, Rechte, Moduleinstellung, Manifest (`retention`), Auskunft, Tests inkl. Rechte-Gegenprobe | M | BN-01, DSB-Votum |
| BN-03 | Oberfläche im Notenbuch, Hinweis- und Wortwarnung, Hinweis-Version | M | BN-02 |
| BN-04 | Handbuch, Nutzungsordnungs-Baustein, Datenschutzdoku, E2E | S | BN-03 |

Gesamt **M**. Alle Aufgaben außer BN-01 erst nach DSB-Votum.

## Entscheidungen (Projektleitung 2026-11-01)

- **bn-1** Nicht umsetzen, bevor das Votum vorliegt: zuerst Fragenabschnitt in DSB-FRAGEN und Votum abwarten; Moduleinstellung Vorgabe aus. – wie vorgeschlagen
- **bn-2** Form: Kategorie + Datum + kurzer Freitext bis 300 Zeichen. – wie vorgeschlagen
- **bn-3** Lesen nur Fachlehrkräfte des Lehrauftrags (wie Teilnoten), Mitlehrkräfte eingeschlossen; Klassenleitung nicht. – wie vorgeschlagen
- **bn-4** Schüler:innen/Eltern sehen die Notizen nicht im Alltag, aber in Auskunft/Einsicht (durch Person mit `notenbuch.auskunft`). – wie vorgeschlagen
- **bn-5** Löschfrist wie das Buch, LK-SJ-1J. – wie vorgeschlagen
- **bn-6** Bei Übertragung eines Notenbuchs werden Notizen nicht mit übertragen; sie bleiben für die bisherigen Lehrkräfte lesbar, die übernehmende Lehrkraft sieht nur Noten. – wie vorgeschlagen
- **bn-7** Keine Offline-Eingabe, nur online, nicht im IndexedDB-Cache. – wie vorgeschlagen
- **bn-8** Schutz vor sensiblen Inhalten: Hinweis am Feld, Warnung bei Diagnosewörtern (nicht blockieren), Nutzungsordnungs-Baustein. – wie vorgeschlagen
- **rf-1** Reihenfolge der Runde 12: nur DSB-Fragen ergänzen (BN-01), Bau nach Votum. – wie vorgeschlagen
