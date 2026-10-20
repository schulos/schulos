# Lasttest „Montag 7:40“ (B-50a)

Simuliert auf der Build-VM: Demo-Hauptsystem aus dem qcow2-Abbild als VM auf der Build-VM, k6 von außen
(`scripts/lasttest.sh`, `scripts/lasttest/montag.js`, Workflow `lasttest.yml`). **Nur relative Aussagen** – geteilter Host
(Build-VM 6 Kerne, darauf auch k6), virtuelle Platte und Netz; die Bestätigung auf echter Hardware ist B-50b.

## Szenario

- Alle kommen in 2 Minuten (Anmelde-Rampe), dann 10 Minuten Volllast, angemeldet bleiben.
- Anmeldung über das Formular wie im Browser (Server Action). `/api/auth` ist per IP auf 10 Anmeldungen/min begrenzt – eine Schule
  hinter einer NAT-Adresse käme dort nicht durch; das Formular ist davon nicht betroffen.
- Rollen 65 % Schüler:innen, 20 % Lehrkräfte, 15 % Eltern; je Rolle die typischen Seiten (Heute, Stundenplan, Vertretungen, Aufgaben,
  Messenger, Dateien, News bzw. Klassenbuch, Elternbriefe, Abwesenheiten), 2–6 s Denkpause je Seite, 10–20 s nach jeder Runde.
  Etwa 0,2 Seiten/s je Nutzer. Nur lesend, ganze Seiten (HTML) – etwas teurer als die Navigation im Browser (RSC).

## Ergebnisse (2026-10-08)

| Lauf | Abbild | Nutzer | VM | Seiten/s | p95 schwerste Seite (Heute) | p95 übrige | Fehler | Engpass |
|---|---|---:|---|---:|---:|---:|---:|---|
| 37752219770 | v0.1.0-rc.3 | 300 | 2 Kerne, 4 GB | 45 | 77 ms | 50–105 ms | 0 % | keiner – VM 39 %, App 54 % eines Kerns |
| 37752219770 | v0.1.0-rc.3 | 300 | 4 Kerne, 4 GB | 45 | 54 ms | 34–74 ms | 0 % | keiner – VM 21 % |
| 37768383108 | main (B-51) | 1000 | 1 Kern, 4 GB | ~52 | 29,6 s | 10–16 s | 0 % | CPU der VM voll (App 71 %, Postgres 19 %) |
| 37768383108 | main (B-51) | 1000 | 2 Kerne, 4 GB | ~82 | 9,2 s | 4,6–6,4 s | 0 % | Node-Prozess der App: 108 % eines Kerns, VM 76 % |
| 37787748120 | B-56 (570d714) | 1000 | 2 Kerne, 4 GB | ~92 | 6,5 s | 3,8–5,2 s | 0 % | Node-Prozess der App: 106 % eines Kerns, VM 73 %; Caddy 8 % (komprimiert jetzt) |
| 37805412542 | v0.1.0 (Release) | 300 | 2 Kerne, 4 GB | 47 | 52 ms | 37–59 ms | 0 % | keiner – VM 34 %, App 48 % eines Kerns (Regressionswächter vor dem Release) |
| 38038758497 | v0.2.0 (Release) | 300 | 2 Kerne, 4 GB | 47 | 56 ms | 37–60 ms (Stundenplan 60 ms; Anmeldung 89 ms) | 0 % | keiner – VM 35 % (max 52 %), App 48 % eines Kerns (max 81 %) bei 345 MB, Postgres 15 %/115 MB, Caddy 4 %/123 MB; Phase 3 ohne messbaren Mehraufwand gegenüber v0.1.0 (52 ms); 33 777 Anfragen (Regressionswächter vor dem Release) |
| 38140402834 | v0.3.1 (Release) | 300 | 2 Kerne, 4 GB | 47 | 61 ms | 40–66 ms (Stundenplan 66 ms; Anmeldung 95 ms) | 0 % | keiner – 33 756 Anfragen; qcow2 frisch aus der Release-ISO (Lauf 38139859480), ohne parallele CI; Blöcke 4a–4c ohne messbaren Mehraufwand gegenüber v0.2.0 (56 ms) |
| 38140402834 | v0.3.1 (Release) | 300 | 4 Kerne, 4 GB | 47 | 47 ms | 32–51 ms (Anmeldung 73 ms) | 0 % | keiner – 33 793 Anfragen |
| 38202496597 | v0.3.2 (Release) | 300 | 2 Kerne, 4 GB | 47 | – | 41–67 ms (Stundenplan 67 ms; Anmeldung 90 ms) | 0 % | keiner – 33 799 Anfragen; VM 36 % (max 55 %), App 50 %/368 MB, Postgres 16 %/119 MB; qcow2 frisch aus der Release-ISO (Lauf 38197975586), ohne parallele CI; erster Lauf mit App-Rolle ohne Superuser (SEC-07) und 4f R1–R4 – kein messbarer Mehraufwand gegenüber v0.3.1 |
| 38202496597 | v0.3.2 (Release) | 300 | 4 Kerne, 4 GB | 47 | – | 34–53 ms (Anmeldung 74 ms) | 0 % | keiner – 33 837 Anfragen; VM 20 % (max 30 %) |
| 38417691069 | v0.4.0 (Release) | 300 | 2 Kerne, 4 GB | 47 | – | 46–85 ms (Heute 80 ms, Stundenplan 77 ms, Abwesenheiten 85 ms; Anmeldung 99 ms) | 0 % | keiner – 33 816 Anfragen; VM 38 % (max 57 %); qcow2 aus der Release-ISO (Lauf 38407516967); erster Lauf mit 3b + 4d – leicht über v0.3.4, im Rahmen |
| 38417691069 | v0.4.0 (Release) | 300 | 4 Kerne, 4 GB | 47 | – | 34–59 ms (Anmeldung 74 ms) | 0 % | keiner – 33 737 Anfragen; VM 22 % (max 30 %) |
| 38336139168 | v0.3.4 (Release) | 300 | 2 Kerne, 4 GB | 47 | – | 41–71 ms (Stundenplan/Heute 71 ms; Anmeldung 98 ms) | 0 % | keiner – 33 880 Anfragen; VM 38 % (max 52 %), App 52 %/368 MB, Postgres 16 %/123 MB; qcow2 frisch aus der Release-ISO (Lauf 38330628783); erster Lauf mit 4f R5–R8 + Gate 4f – im Rahmen von v0.3.2 |
| 38336139168 | v0.3.4 (Release) | 300 | 4 Kerne, 4 GB | 47 | – | 31–55 ms (Anmeldung 76 ms) | 0 % | keiner – 33 847 Anfragen; VM 21 % (max 30 %) |

Speicher: App bis 790 MB, Postgres bis 125 MB, Caddy bis 280 MB – 4 GB reichen auch unter Überlast.

## Befunde

1. **Die Grenze ist der eine Node-Prozess der App**, nicht Postgres: ein Prozess schafft hier ~80 ganze Seiten/s. 300 gleichzeitig
   aktive Nutzer (~60 Seiten/s) laufen mit 2 Kernen ohne Engpass; bei 1000 (~200 Seiten/s angefragt) bricht die Antwortzeit ein,
   ein dritter oder vierter Kern hilft dann nicht mehr. Mehr Durchsatz gibt es nur mit mehreren App-Instanzen (**B-52**) oder
   weniger CPU je Seite.
2. **Postgres ist unkritisch:** Datenbankzeit insgesamt wenige Sekunden in 10 Minuten, jede Abfrage im Mittel 0,02–0,2 ms
   (`pg_stat_statements`, B-51). Die sequenziellen Scans betreffen kleine Tabellen (users, groups, grants, group_features) – bei
   einer Schulgröße passen sie in wenige Seiten, Postgres wählt den Scan dort bewusst.
3. **Viele kleine Abfragen je Seite:** `app_settings` ~3× je Anfrage, dazu Sitzung, Konto, Gruppen und Rechte jeweils einmal,
   Benutzernamen der Eltern-Kind-Beziehung. Einzeln billig, zusammen Teil der Node-CPU (Serialisierung). Möglicher Gewinn: Einstellungen
   und Rechte je Anfrage zwischenspeichern (React `cache`) – Vorschlag **B-56**.
4. **Heute und Stundenplan sind die teuersten Seiten** (etwa doppelt so lang wie die übrigen unter Last).
5. Die Anmeldung (scrypt) kostet unter Last ~2–8 s p95, solange alle gleichzeitig kommen – danach nicht mehr relevant.

## B-56: Abfragen gecacht, Kompression in Caddy (2026-10-08)

Vorher/nachher mit 2 Kernen/4 GB und 1000 Nutzern (Läufe 37768383108 → 37787748120, gleicher Ablauf):

| | vorher | nachher | |
|---|---:|---:|---:|
| Anfragen in 12 min | 64 220 | 71 634 | +11,5 % |
| p95 Heute | 9 185 ms | 6 475 ms | −30 % |
| p95 Stundenplan | 9 072 ms | 6 905 ms | −24 % |
| p95 News / Aufgaben | 4 641 / 4 700 ms | 3 786 / 3 860 ms | −18 % |
| p95 Anmeldung | 4 991 ms | 4 269 ms | −14 % |

- **Was gewirkt hat:** fast nur die Kompression. Lokal gemessen (gebauter Server, Postgres 18, Demo-Schule, CPU-Profil) kostete
  gzip im Node-Prozess auf Heute ~8 von ~44 ms CPU je Seite; jetzt komprimiert Caddy (mehrere Kerne, 8 % CPU im Lauf).
- **Abfragen gecacht** (Einstellungen + Demo-Kennzeichen in einer Abfrage, Schulkalender und Modulstatus je Anfrage): Heute
  42 → 34, Stundenplan 33 → 28 Abfragen, `app_settings` 1× statt 3–6× – aber praktisch keine CPU (40,6 → 40,4 ms lokal); die
  Abfragen sind einzeln zu billig (0,01–0,2 ms in Postgres).
- **Warum Heute und Stundenplan teurer sind:** sie erzeugen mehr HTML – Heute ~70 KB (acht Widgets mit eigenen Daten), Stundenplan
  ~131 KB (Raster) gegenüber 40–45 KB bei News/Aufgaben; Rendern und Serialisieren wachsen mit der Ausgabe. Weiterer Hebel wäre ein
  schlankerer Stundenplan (Raster nur einmal ausliefern), lohnt erst, wenn B-50b es verlangt.
- **Nur Demo:** `users … where username in (…)` und `parent_child` laufen bei jeder Seite (Demo-Konten im Benutzermenü) – in einer
  Produktivinstanz entfallen sie.

## Gemeinsam bearbeiten: 30 Personen in einem Text / auf einer Tafel (Gate 3b, P3-13)

Frage (QUESTIONS, 3b): Reicht der Kanal aus POST + SSE (statt eigenem WebSocket-Dienst) bei ~30 Personen gleichzeitig? Gleiche
Infrastruktur wie oben (Demo-Hauptsystem aus dem qcow2 als VM, Messung `docker stats`/`vmstat` in der VM), aber eigener
Lastgenerator statt k6: `scripts/lasttest/gemeinsam/run.ts` (Node mit `yjs`) – k6 kann ohne eigene Erweiterung keinen SSE-Strom
lesen, und gültige Yjs-Updates braucht ohnehin yjs selbst.

- **Wer:** NUTZER Schüler:innen der 7b (der Demo-Seed hat 25; vor dem Lauf mit Schüler:innen anderer Klassen aufgefüllt – nur in der
  Demo-VM), Anmeldung über das Formular, je Person ein offener Live-Strom (`/api/gong/stream`) wie ein Browser-Tab.
- **Text:** frischer Text `lasttest-gemeinsam` in der 7b. Jede Person hat einen eigenen Y.Doc wie der Editor, tippt in einen
  eigenen Absatz (Gruppenarbeit), 5–20 s am Stück mit 2–5 Zeichen/s, dann 3–15 s Pause, ab und zu Rücktaste/Korrektur/neuer
  Absatz. Senden wie der Editor: gebündelt alle 300 ms, höchstens ein POST unterwegs, Backoff bei Fehlern; Sync beim Start, alle
  2 Minuten und nach jedem Neuaufbau des Stroms; empfangene Updates werden angewandt.
- **Tafel:** Beispieltafel der 7b. Freihandstriche (~60 Punkte/s, 0,8–3 s), Rechtecke aufziehen, eigene Elemente verschieben,
  alte löschen (höchstens 12 eigene sichtbar), 1–6 s Pause zwischen den Aktionen. Senden wie die Tafel: geänderte Elemente
  gebündelt alle 250 ms.
- **Phasen** nacheinander je DAUER (Vorgabe 5 Minuten): `text`, `tafel`, `beide` (dieselben Personen haben Text und Tafel offen).
- **Gemessen:** Antwortzeit der Update-POSTs; **Zustellverzögerung** vom Absenden bis die *anderen* das Ereignis im SSE-Strom
  haben – für jedes Ereignis über die Kennung des gesendeten Bündels (Text: Yjs-Client + Uhr, Tafel: Element + Version); Fehler
  je HTTP-Status; CPU/Speicher von App, Postgres, Caddy je Phase; CPU und Event-Loop-Verzögerung des Lastgenerators selbst
  (zur Plausibilität). **Konsistenz** am Ende jeder Phase (Senden gestoppt, 5 s Ruhe): jede Person gleicht über den
  Sync-Endpunkt ab – gezählt wird, wer dabei noch etwas nachholen musste („mit Lücke“, also ein Ereignis im Strom verpasst hat),
  und ob danach alle denselben Stand wie der Server haben.
- **Grenzwerte** (Befund, kein Abbruch – `SHARED_LIMITS` in `packages/server/src/lasttest.ts`): POST p95 ≤ 500 ms, Zustellung
  p95 ≤ 1 s, Fehlerquote ≤ 1 %, alle sehen denselben Stand, App im Mittel ≤ 80 % eines Kerns. Der Bericht schreibt
  „reicht“ bzw. „reicht nicht“ mit den überschrittenen Werten.

Lauf (Texte/Tafeln gibt es erst nach v0.3.4 – erst ein Abbild des Branches bauen, es landet im Lager auf der Build-VM):

```bash
gh workflow run iso.yml --ref <branch> -f qemu=qcow2            # ~1 h, legt schulos-dev-<commit>-hauptsystem.qcow2 ab
gh workflow run lasttest.yml --ref <branch> -f szenario=gemeinsam -f nutzer=30 -f dauer=5m -f kerne=2 \
  -f abbild=schulos-dev-<commit>-hauptsystem.qcow2               # ~35 min
```

Lokal probieren (gebauter Server, Demo-DB): `npm run db:reset && npm start`, dann
`BASE_URL=http://localhost:3000 KONTEN=konten.json PERSONEN=5 DAUER=30s npx tsx scripts/lasttest/gemeinsam/run.ts` mit
`konten.json` = `{"accounts": ["lea.schaefer", …], "text": "text-7b-regeln", "tafel": "tafel-7b-brueche"}`.

### Ergebnisse (2026-10-13)

Lauf 38347964254: 30 Schüler:innen, 2 Kerne/4 GB, je Phase 5 min, Abbild `schulos-dev-f8b200f…-hauptsystem.qcow2` (Branch
`p3-12-tafeln`, ISO-Lauf 38341481898). **Bewertung: reicht** – alle Grenzwerte mit großem Abstand eingehalten.

| Phase | Art | POSTs | POST p50 / p95 / p99 | Fehler | Zustellung p50 / p95 / p99 / max | SSE-Ereignisse empfangen | Konsistenz |
|---|---|---:|---:|---:|---:|---:|---|
| text | Text | 11 666 | 7 / 13 / 20 ms | 0 | 8 / 13 / 20 / 156 ms | 349 890 (29 MB) | 30/30 gleich, 0 mit Lücke (15 832 Zeichen) |
| tafel | Tafel | 11 254 | 8 / 16 / 22 ms | 0 | 8 / 15 / 22 / 373 ms | 337 410 (435 MB) | 30/30 gleich, 0 mit Lücke (377 sichtbare / 1 343 Elemente) |
| beide | Text | 11 510 | 8 / 17 / 49 ms | 0 | 8 / 17 / 51 / 608 ms | 344 339 (29 MB) | 30/30 gleich, 0 mit Lücke (31 415 Zeichen) |
| beide | Tafel | 11 288 | 8 / 17 / 37 ms | 0 | 8 / 17 / 36 / 661 ms | 337 170 (413 MB) | 30/30 gleich, 0 mit Lücke (381 sichtbare / 2 681 Elemente) |

| Phase | App CPU Mittel / Max | App Speicher max | Postgres CPU Mittel / Max | Caddy CPU | Lastgenerator |
|---|---:|---:|---:|---:|---|
| text | 19 % / 39 % | 366 MB | 6 % / 11 % | 5 % | 7 % CPU, Event-Loop p99 21 ms |
| tafel | 18 % / 49 % | 473 MB | 5 % / 8 % | 5 % | 8 % CPU, Event-Loop p99 21 ms |
| beide | 33 % / 48 % | 407 MB | 11 % / 16 % | 10 % | 13 % CPU, Event-Loop p99 21 ms |

VM im Mittel 19 % ausgelastet (max. 41 %). Anmeldung 30/30 (p95 448 ms). Keine Warnungen im App-Log.

Befunde:

1. **Der Kanal aus POST + SSE reicht für 30 Personen** in einem Text, auf einer Tafel und in beiden zugleich: rund 39 Update-POSTs/s
   je Art, jedes an 29 andere verteilt (~1 150 SSE-Ereignisse/s je Art), Zustellung p95 13–17 ms, nichts verloren, am Ende bei allen
   derselbe Stand. Die App braucht dafür im Mittel ein Fünftel (eine Art) bzw. ein Drittel (beide) eines Kerns – kein eigener
   WebSocket-Dienst nötig.
2. **Die 30 Neuaufbauten des Live-Stroms** sind die 15-Minuten-Höchstdauer je Strom (SEC-04), nicht Fehler; der Sync nach dem
   Neuaufbau hat jede Lücke geschlossen (0 mit Lücke).
3. **Tafel überträgt deutlich mehr Daten als Text** (~1,4 MB/s SSE über alle 30 Ströme gegenüber ~0,1 MB/s): ein Freihandstrich geht
   alle 250 ms vollständig mit allen bisherigen Punkten raus. Für 30 Personen unkritisch; bei mehreren voll besetzten Tafeln
   gleichzeitig wäre das Netz (WLAN im Klassenraum) eher der Engpass als der Server.
4. **Grabsteine wachsen mit:** gelöschte Elemente bleiben einen Tag stehen (Abgleich), nach 10 Minuten Dauerzeichnen 2 681 Elemente
   bei 381 sichtbaren. Jeder Sync liefert alle – bei einer intensiv genutzten Tafel wächst die Antwort entsprechend (hier weit unter
   der 4-MB-Grenze).

## Solver-Lauf im App-Prozess (SP-06, Q-SP-9) – 2026-10-19

Der Solver rechnet im Serverprozess **zeitgeschnitten**: ~25 ms rechnen, dann `setImmediate`; kam der Lauf danach spürbar verspätet zurück
(etwas anderes brauchte die Ereignisschleife), pausiert er 30 ms („Vorfahrt für Anfragen“). Heartbeat jede Sekunde (Fortschritt, Sperre,
Abbruchwunsch). Gemessen lokal (Entwicklungsrechner, PGlite – die Datenbank rechnet dort im selben Thread, im Betrieb wartet die App auf PostgreSQL).

**Groß-Benchmark (SP-G-15, `solver.benchmark.test.ts`):** synthetische Schule 7-zügig 5–10 (42 Klassen) + Oberstufe mit 120 Kursen in Schienen
(130 Schüler:innen je Jahrgang → Konfliktmengen), 70 Lehrkräfte, 1 323 Einheiten / 1 653 Wochenstunden, Zeitraster 8 Stunden mit großen Pausen
nach der 2./4./6. Stunde: Konstruktion 0,3 s, gesamt **0,9 s** bei 40 000 Verbesserungsschritten (82 Verbesserungen), **9 Einheiten (0,7 %) nicht
gesetzt** – alle Oberstufenkurse mit dichten Konfliktmengen über Schienen hinweg (Grund je Einheit: „Kurse mit gemeinsamen Schüler:innen von Q1-D2:
3 von 40 Slots frei (37 belegt)“; das löst erst die Blockung, SP-G-24), Hohlstunden Klassen 13 (max. 3 je Klasse), Lehrkräfte 169 (max. 10), kein
Raum fehlt. Grenzwerte im Test: ≤ 1 % nicht gesetzt, Klassen-Hohlstunden im Mittel < 1, < 120 s. Die Demo-Schule (354 Einheiten) rechnet „gründlich“
(4 × 40 Schritte je Einheit = 56 640 Schritte; bis SP-06 lief „gründlich“ wegen einer Deckelung in `improve()` nur so viele Schritte wie „normal“) in 1,7 s.

**Nachmessung SP-09 (2026-10-20, Raum je Kopplungsteil SP-G-02):** derselbe Benchmark liefert mit der Raumwahl je Teil **dieselbe Lösung** (ein Teil je
Einheit → gleiche Platzierungen und Räume): 9 Einheiten nicht gesetzt, Bewertung 2 163, Hohlstunden 169/13, Konstruktion 0,24–0,26 s, gesamt 0,7–0,9 s
(Streuung des Entwicklungsrechners). Variante **„Sport als geteilte Klasse“** (alle 42 Sek-I-Klassen mit zwei Sportlehrkräften → 84 Einheiten mit zwei
Teilen, 6 Sporthallen, 76 Lehrkräfte): alle 84 geteilten Einheiten mit **zwei verschiedenen Räumen** (61 davon beide in Sporthallen, der Rest ein Teil im
Klassenraum – Raumwunsch 784 statt 756), 10 Einheiten (0,8 %) nicht gesetzt (wieder Oberstufenkurse mit dichten Konfliktmengen), kein Raum fehlt,
Hohlstunden 169/11, gesamt 0,9 s. Grenzwerte unverändert (≤ 1 % nicht gesetzt, kein „ohne Raum“, < 120 s).

**Ereignisschleife während eines gründlichen Laufs (`solverlauf.latenz.test.ts`, Demo, In-Memory-PGlite):** 5-ms-Timer als Messfühler – Verzögerung
p50 20,7 ms, **p95 23,3 ms**, p99/max 80 ms (63 Messpunkte; Ruhe p95 11 ms). Das Maximum ist das Laden der Eingabe (`solverInputFromDb`, ~80 ms:
PGlite-Abfragen laufen als Microtask-Kette ohne Rückkehr zur Ereignisschleife – mit PostgreSQL sind das I/O-Wartezeiten). Grenzwerte im Test:
p95 < 100 ms, max < 300 ms.

**Antwortzeiten des gebauten Servers** (`next start`, Demo-DB, angemeldet als Stundenplanung; ein Abrufer holt der Reihe nach Heute, Stundenplan und
`/api/health`, Phasen: Ruhe · acht gründliche Läufe nacheinander starten (Formular, Weiterleitung, Solver-Seite mit Vorschau) · Läufe rechnen, Browser
weg von der Solver-Seite · danach):

| Phase | Heute p50 / p95 | Stundenplan p50 / p95 | /api/health p50 / p95 | Messpunkte je Pfad |
|---|---:|---:|---:|---:|
| Ruhe | 318 / 595 ms | 176 / 326 ms | 27 / 40 ms | ~20 |
| Läufe starten (Bedienung) | 668 / 1 148 ms | 370 / 742 ms | 34 / 183 ms | 11 |
| **Läufe rechnen** (Browser weg) | **357 / 754 ms** | **196 / 469 ms** | 38 / 66 ms | 148 |
| danach | 251 / 403 ms | 169 / 257 ms | 23 / 31 ms | ~15 |

- **Während der Berechnung** liegen die Seiten im Median **+11–12 %** über der Ruhe (Heute +12 %, Stundenplan +11 %), p95 +27 % (Heute) bzw.
  +44 % (Stundenplan) – die Ruhe-p95 beruhen auf nur ~20 Messpunkten und streuen entsprechend. Preis: unter **dauerhaften** Anfragen (der Abrufer
  hält die Ereignisschleife ständig beschäftigt) pausiert der Lauf nach fast jeder Scheibe → acht gründliche Läufe brauchten 112 s statt ~14 s
  reiner Rechenzeit (≈ 8× langsamer); ohne Anfragen läuft er mit voller Geschwindigkeit. Zum Vergleich **ohne** „Vorfahrt“ (25-ms-Scheiben, nur
  `setImmediate`, gleiche Messung vorher): Heute +91 % im Median, Stundenplan +270 % – der Lauf teilt sich die CPU dann hälftig mit den Seiten.
- **Läufe starten** ist die teurere Phase: je Lauf baut `createRun` die Solver-Eingabe (Prüfung) und die Solver-Seite rendert nach der Weiterleitung
  Vorschlag + Diagnose des letzten Laufs (Diagnose O(n²) über ~1 000 Stunden) und lädt mit `AutoRefresh` alle 2 s neu. **Hinweis für SP-07:** Kennzahlen
  aus `metrics` statt `proposalDiagnosis` je Seitenaufruf, Vorschau erst auf Wunsch laden, Auto-Aktualisierung nur Status/Fortschritt.
- **Entscheidung Q-SP-9:** Der Lauf bleibt im App-Prozess (kein Worker-Thread, kein zweites Bundle für Next-Standalone/ISO): im Median unter +20 %,
  Spitzen durch Zeitscheibe (≤ 25 ms) plus Eingabe laden. Ein Lasttest-Regressionslauf auf der Build-VM (k6 „Montag 7:40“ mit laufender Berechnung)
  steht noch aus – er braucht ein qcow2 des Standes (~1,5 h) und ein Szenario, das den Lauf startet; bei Bedarf vor v0.6.0 nachholen.

## Folgerungen

- **Mindesthardware** (INSTALLATION.md): 2 Kerne / 4 GB reichen für eine Schule mit ~600 Konten (Spitze ~300 gleichzeitig aktiv);
  4 Kerne bringen Reserve für Vorschau-Instanz, Probelauf und Backups, aber keinen höheren Durchsatz der App.
- **B-52 (mehrere App-Instanzen)** ist für ~600 Konten nicht nötig; erst ab etwa 400–500 gleichzeitig aktiven Nutzern
  (Schulen ab ~1 000 Konten). Bleibt wie geplant „ganz zuletzt“; B-50b auf echter Hardware entscheidet.
- **Regressionswächter in der CI:** nicht in jedem PR – VM-Start und Demo-Seed brauchen ~10 min auf dem einzigen Runner. Stattdessen
  von Hand vor Releases (`gh workflow run lasttest.yml -f kerne=2 -f nutzer=300`) und Vergleich mit der Tabelle oben.
