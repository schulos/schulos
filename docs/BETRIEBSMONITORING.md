# Betriebsmonitoring – Health-Details, `schulosctl status --json`, IP-freies Zugriffsprotokoll

Freigegeben von der Projektleitung am 2026-11-01 (Fragebogen Runde 12). Aufgaben: `docs/BACKLOG.md`, Block „Betriebsmonitoring“
(BM-01 ff.). Herkunft: PHASE4 §5.2 OPS-5. Dieses Dokument hält Problem, Umfang, Umsetzung, Datenschutz und Entscheidungen fest.

## Problem und Nutzen

- **Admin:** `/api/health` zeigt heute nur `{ok, db}`. Ob der Mail-Versand hängt, Jobs stehen, die Platte volläuft oder die Sicherung
  bzw. Offsite-Kopie veraltet ist, steht verstreut in Verwaltung → System/Backup oder nur in Alarm-Mails. Ein Außen-Monitor kann
  nichts davon abfragen; `schulosctl status` gibt es nur als Text.
- **Schulleitung:** verlässliche Aussage „läuft der Betrieb gesund?“ für Pilot und Betriebsübergabe (Verfügbarkeit ist TOM, siehe
  BETRIEBSHANDBUCH).
- **Schulträger-IT:** maschinenlesbarer Status ohne SSH.
- Lehrkräfte, Schüler:innen, Eltern und Sekretariat sind nur mittelbar betroffen (Störungen fallen früher auf).

## Umfang

**Gehört dazu**

1. `/api/health` bleibt die schlanke Liveness-Antwort (Container-Healthcheck, CI-Smoketest, Lasttest hängen daran). Neu
   **`/api/health/details`** (nur Kennzahlen ohne Personenbezug, geschützt per Token oder nur Schulnetz): Version, Datenbank
   (Latenz), Mail-Ausgang (pending/failed, ältester Eintrag), Jobs (letzter Lauf je Job), Sicherung (Alter des letzten guten
   Stands, Offsite-Kopie), Speicherplatz, Zertifikatsablauf, ausstehende Updates/Neustart.
2. **`schulosctl status --json`:** dasselbe Statusobjekt als JSON (Compose-Zustand, Version/Kanal, Platte, Backup-Agent, Update,
   TLS-Ablauf); Exit-Code 0/1/2 (ok/Warnung/Fehler) für Skripte und Überwachungs-Plugins. Der Text-Status bleibt.
3. **Zugriffsprotokoll ohne IP:** aggregierte Betriebskennzahlen (Anfragen je Statusklasse, Latenz-Perzentile, 5xx-Rate) aus einem
   zweiten, **IP-freien** Log-Ausgang des Reverse-Proxys (Filter löscht `remote_ip`/`client_ip`/Header und maskiert URI-Tokens wie im
   bestehenden CrowdSec-Block), höchstens 48 h Aufbewahrung, dauerhaft nur Zähler.
4. Anzeige: Karte „Betrieb“ in Verwaltung → System; Warnungen über die vorhandene Alarmmechanik (`src/core/system/alarms.ts`,
   Gong + Mail an Admin).

**Ausdrücklich nicht:** eigener Metrik-/Dashboard-Stack, Weitergabe von Metriken an Dritte, Nutzungsstatistik je Person oder Seite,
Tracing, externer SaaS-Monitor als Pflicht, Log-Aufbewahrung mit IP über 48 h hinaus.
**Spätere Stufen:** OpenMetrics-Endpunkt (`/metrics`) auf Wunsch eines Schulträgers; Verlauf (Kennzahlen 30 Tage in einer Tabelle);
Statusseite für Nutzende („Störung bekannt“).

## Umsetzung

- **Modul:** kein neues Modul, Kern. Neue Datei `src/core/system/health.ts` (reine Funktion `collectHealth(db, status, now)`,
  getestet wie `status.test.ts`) bündelt vorhandene Quellen: `readSystemStatus` (`src/core/system/status.ts`), `outboxStats`
  (`src/core/mail.ts`), `BackupStatus` (`src/core/backup/status.ts`), `collectAlarms` (`alarms.ts`), Scheduler-Läufe
  (`src/core/scheduler.ts`).
- **Route:** `src/app/api/health/details/route.ts` (`force-dynamic`, `no-store`). Zugriff: Token aus dem `config`-Volume (zufällig,
  im Admin-UI erneuerbar, Muster wie die Monitor-Adresse unter `src/app/api/monitor/[token]`) oder Client-IP im Schulnetz. Der Pfad
  steht bewusst in `src/core/external-access.ts` **und** in der Allowlist des Caddyfiles (`compose.yaml`); Vorgabe: von außen
  gesperrt, ein Test vergleicht beide. Falsches Token: 404.
- **Tabellen:** Stufe 1 keine. Für den späteren Verlauf: `core_health_samples` (Zeitpunkt, Zahlen, kein Personenbezug).
- **Rechte:** Karte über das vorhandene Systemrecht (Admin); kein neues Recht. API per Token.
- **Einstellungen:** Kernsetting `health.details` (aus / Token / Schulnetz) und Schwellen (Alter Sicherung, Mail-Stau).
- **Live-Kanal:** keiner (Karte lädt beim Öffnen; Alarme laufen über den Gong). **Mail:** nur die vorhandene Alarm-Mail; neue
  Alarmschlüssel (Mail-Stau, Zertifikat läuft ab) in `collectAlarms`.
- **ctl/Installer:** `apps/ctl/src/main.ts` (`statusReport`, `case "status"`) um `--json` ergänzen; Struktur als Typ in
  `packages/server/src/system.ts` (neben `SystemStatus`), damit App und ctl denselben Aufbau nutzen. Installer nur für die
  Token-Erzeugung beim Erststart.
- **Reverse-Proxy:** zweiter `log`-Block mit IP-Filter im Caddyfile (`compose.yaml`); kleiner Auswerter im App-Container liest die
  Logdatei aus `caddy_logs:ro` (Muster wie `src/core/crowdsec.ts`).
- **Backup:** nicht betroffen (keine neuen Daten). **Doku:** INSTALLATION (Betrieb), BETRIEBSHANDBUCH (Monitoring), SICHERHEIT.

## Datenschutz

- Kennzahlen sind aggregiert und ohne Personenbezug: keine Namen, Konten, Mailadressen, Pfad-Tokens; Fehlertexte über die
  vorhandene Bereinigung `scrubError` (`src/core/mail.ts`).
- Das IP-freie Log braucht keinen `retention`-Eintrag (kein Personenbezug); das IP-haltige CrowdSec-Log bleibt unverändert
  (höchstens 48 h, SEC-15).
- Sichtbarkeit: Admin (bzw. Verwaltung mit Systemrecht); Außen-Monitor nur mit Token. Der Endpunkt verrät Version und
  Betriebszustand, daher nicht öffentlich.
- VVT: Eintrag „Betriebsüberwachung“ (Zweck IT-Sicherheit/Verfügbarkeit, Art. 32) genügt.

## Aufgaben (Größe)

| Nr. | Aufgabe | Größe | Abhängigkeit |
|---|---|---|---|
| BM-01 | Typ `HealthReport` + `collectHealth` + Tests | S | – |
| BM-02 | Route `/api/health/details` mit Token/Netz-Zugriff, Allowlist in Caddy + `external-access.ts` | S | BM-01 |
| BM-03 | `schulosctl status --json` mit Exit-Codes + Test | S | BM-01 (Typ) |
| BM-04 | Karte „Betrieb“ in Verwaltung → System + neue Alarme | S | BM-01 |
| BM-05 | IP-freier Zugriffslog + Auswerter (Zähler) | M | BM-01 |
| BM-06 | Doku, VVT-Eintrag, E2E-Test | S | BM-02…05 |

Gesamt **M**. BM-01…04 sind ohne BM-05 lieferbar.

## Entscheidungen (Projektleitung 2026-11-01)

- **bm-1** `/api/health/details` nur Schulnetz bzw. mit Token, von außen standardmäßig gesperrt. – wie vorgeschlagen
- **bm-2** Stufe 1 ohne Verlauf (nur aktueller Stand), 30 Tage Verlauf erst später. – wie vorgeschlagen
- **bm-3** Zunächst nur JSON + Exit-Codes, OpenMetrics auf Wunsch eines Schulträgers. – wie vorgeschlagen
- **bm-4** Warnungen an dieselben Empfänger wie die bisherigen Betriebsalarme (Verwaltung → System). – wie vorgeschlagen
- **bm-5** IP-freies Zugriffsprotokoll standardmäßig an (ohne Personenbezug, höchstens 48 h). – wie vorgeschlagen
- **rf-1** Reihenfolge der Runde 12: CA-Backup-Fix (CA-01) → Betriebsmonitoring → CA Teil A → Klassenbildung 1–2 → Inventar
  INV-01/02 → CA Teil B → Inventar Rest; Web-Push und Beobachtungsnotizen: nur DSB-Fragen ergänzen, Bau nach Votum. – wie vorgeschlagen
