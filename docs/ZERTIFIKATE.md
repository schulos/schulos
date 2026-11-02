# Zertifikate – eigene CA beherrschbar machen und öffentliche Zertifikate per DNS

Freigegeben von der Projektleitung am 2026-11-01 (Fragebogen Runde 12). Aufgaben: `docs/BACKLOG.md`, Block „Zertifikate“
(CA-01 ff.). Dieses Dokument hält Befund, Umfang, Umsetzung, Datenschutz und Entscheidungen fest.

## Befund: `caddy_data` und `step_ca` sind nicht im Backup (im Code geprüft)

Der Backup-Agent sichert genau drei Pfade: Datenbank-Dump, `filesDir` und `configDir` (`apps/agent/src/agent.ts`). Im Dienst
`backup-agent` (`compose.yaml`) hängen nur die Volumes `config`, `files` und `agent_tmp`; `caddy_data` ist ausschließlich in `caddy`
gemountet. Folge: Nach Wiederherstellung auf neuer Hardware (oder Neuinstallation) erzeugt Caddy eine **neue Root**, alle Clients
müssen neu vertrauen. Dasselbe gilt für `step_ca` (Schlüssel der Gerätezertifikate-CA): INSTALLATION §5c schreibt „gehört ins
Backup“, der Agent sichert das Volume aber nicht. Gleiches beim Backupserver (`compose.backup.yaml`). **Lücke, als Sofort-Fix
(CA-01) vor allem anderen schließen.**

## Problem und Nutzen

- **Admin:** Nach jeder Neuinstallation oder Wiederherstellung Zertifikatsfehler an allen Geräten. Der Browser zeigt nur das kurzlebige
  Zwischenzertifikat, nicht die Root; die Root liegt nur auf dem Server, ohne SSH kommt man nicht heran. Das Fehlerbild (HSTS-Sperre,
  kein Weiterklicken) ist schwer zu deuten.
- **Lehrkräfte, Sekretariat, Schulleitung:** Dienstgeräte funktionieren nach Neuinstallation nicht, bis die IT neu verteilt hat.
- **Schüler:innen, Eltern:** Private Geräte sind nicht verwaltbar: Zertifikatswarnung, keine Passkeys, keine Kamerafunktionen. Nur ein
  öffentlich vertrauenswürdiges Zertifikat löst das wirklich.

## Umfang

**Teil A – eigene CA beherrschbar machen**

1. `caddy_data` (genügt: `pki/authorities/local`, Root + Schlüssel) und `step_ca` ins Backup aufnehmen und beim Restore zurückspielen
   (**CA-01**, Sofort-Fix).
2. Download der **Root** (nur Zertifikat, nie Schlüssel): Verwaltung → System („Schul-Zertifikat herunterladen“: `.crt`, `.cer`,
   Apple-`.mobileconfig`), dazu Hinweisseite beim Aufruf per IP/Fremdname; **SHA-256-Fingerabdruck** daneben, in `schulosctl status`
   und in der Erststart-Ausgabe. Zusätzlich ohne Anmeldung unter `/ca.crt`, nur im Schulnetz (ohne Vertrauen kein Login).
3. Import-Anleitung (Tabelle „Verteilwege“) als Hilfeseite im Modul `hilfe` und in INSTALLATION §TLS.
4. Backupserver: gleicher Download auf seiner Oberfläche (`apps/backup`); `compose.backup.yaml` kopiert die Root schon nach `/ca/root.crt`.
5. Alarm an Admin bei Wechsel der Root (Fingerabdruck geändert), bis der neue Fingerabdruck bestätigt ist.

**Teil B – öffentliche Zertifikate per DNS-Prüfung (ACME DNS-01)**

Caddy weist die Domain über einen TXT-Eintrag `_acme-challenge.<domain>` beim DNS-Anbieter nach; der Server braucht nur
ausgehenden Internetzugang, keinen eingehenden (Server „nur im Schulnetz“, Name per Schul-DNS auf die private IP). Installerfrage bei
„Adresse & TLS“, eigenes Caddy-Image mit DNS-Modulen (xcaddy, reproduzierbar, per Digest auf der ISO, B-47) **nur bei DNS-01**
(Standard bleibt `caddy:2`), Stufe 1 mit den Anbietern cloudflare, hetzner, ionos, netcup, inwx, desec, route53, rfc2136 (technische
Abhängigkeit: je ein DNS-Modul von Caddy). Token nur in `.env` (Rechte 600), nie im Backup-Klartext; Ablauf/Fehler der Erneuerung als
Warnung in Verwaltung → System + Mail an Admin. Der Backupserver nutzt dann den System-Truststore statt CA-Pinning.

**Verteilwege der eigenen Root (für Doku/Anleitung)**

| Geräte | Weg |
|---|---|
| Windows-PCs der Schule (Domäne) | Gruppenrichtlinie: Richtlinien für öffentliche Schlüssel → Vertrauenswürdige Stammzertifizierungsstellen |
| Windows ohne Domäne | Konfigurationsprofil der Geräteverwaltung („Vertrauenswürdiges Zertifikat“) |
| Windows einzeln | `certutil -addstore -f Root root.crt` (als Admin, LocalMachine) |
| iPads/Macs | Zertifikats-Profil der Geräteverwaltung (`.mobileconfig`); von Hand zusätzlich Zertifikatsvertrauenseinstellungen → volles Vertrauen |
| Android/Chromebooks | Geräteverwaltung bzw. Admin-Konsole des Geräteanbieters |
| Firefox | System-Roots über `security.enterprise_roots.enabled` bzw. Richtlinie `Certificates.ImportEnterpriseRoots` |
| Private Geräte (Eltern, BYOD) | praktisch nicht verwaltbar: Warnung bleibt; dafür Teil B |

Jede Neuinstallation erzeugt eine **neue Root**: alles neu verteilen, alte Einträge entfernen (sonst HSTS-Sperre).

**Ausdrücklich nicht:** Wildcard-Zertifikate in Stufe 1, automatische Verteilung der Root an Clients, eigene Geräteverwaltung,
Root-Download über HTTP als „vertrauenswürdig“ ausgeben ohne Fingerabdruck-Abgleich.
**Spätere Stufen:** `acme-dns`-Delegation (falls der Anbieter keine API hat); ACME-Staging-Test im Installer; Wildcard für
Vorschau-Instanz/Backupserver; automatischer Ausstellungstest in der CI (lokale ACME-Test-CA + DNS-Server per RFC 2136).

## Umsetzung

- **Modul:** kein neues Modul; Kern + Installer + ctl. `schulosctl` schreibt `system-status.json` (`apps/ctl/src/main.ts`), die App liest
  es (`src/core/system/status.ts`). Typ `SystemStatus` in `packages/server/src/system.ts` um
  `tls: { mode, rootFingerprint, rootNotAfter }` erweitern.
- **Root bereitstellen:** Die App sieht `caddy_data` nicht. Bevorzugt: `schulosctl` liest `/data/caddy/pki/authorities/local/root.crt`
  per `docker compose exec caddy` und legt sie als `root-ca.crt` ins `config`-Volume; die App liefert nur diese Datei aus. Abgelehnt:
  `caddy_data` in die App mounten (der Schlüssel liegt im selben Volume).
- **Download-Route:** `src/app/api/system/ca/route.ts` (angemeldet, Admin) und unauthentifiziert `/ca.crt` (nur Zertifikat) nur im
  Schulnetz; Pfad in `src/core/external-access.ts` und im Caddyfile (Allowlist, von außen gesperrt). Aktiv nur bei TLS-Modus
  `internal`, sonst 404.
- **Backup (CA-01):** Dienst `backup-agent` in `compose.yaml`: Volumes `caddy_data` und `step_ca` read-only mounten;
  `apps/agent/src/config.ts` neue Pfade, `agent.ts` (Pfadliste) erweitern, `restore.ts` Rückspielen mit Rechten 600 für Schlüssel;
  Tests `apps/agent/src/agent.test.ts`, Systemtest `scripts/backup-stack-test.sh`; Backupserver entsprechend.
- **Installer (Teil B):** `apps/installer/src/questions.ts` (`web.tls`): Wert für DNS-01 + Fragen `web.dns_provider`, `web.dns_token`
  (geheim, nur `.env`, nicht im Export `schulos-install.yaml`), `web.acme_mail`; `generate()` setzt `SCHULOS_CADDY_IMAGE` auf das
  DNS-Image; im Caddyfile kommt die DNS-Angabe zu `tls` dazu.
- **Caddy-Image (Teil B):** eigenes Dockerfile (xcaddy, gepinnt), Build in CI/ISO; `apps/ctl/src/update.ts` und das
  Release-Manifest führen es per Digest.
- **Tabellen/Rechte/Live-Kanal:** keine neuen Tabellen; vorhandenes Systemrecht (Admin); Mail nur Alarm bei Root-Wechsel/Ablauf über
  `collectAlarms` (`src/core/system/alarms.ts`).
- **Doku:** INSTALLATION §TLS (Checkliste Schulträger: Domain, Split-DNS, Token mit Minimalrechten nur für diese Zone),
  BETRIEBSHANDBUCH (Neuinstallation = neue Root, Restore = gleiche Root), SICHERHEIT.

**Stand Teil A (CA-02…CA-05 umgesetzt), Abweichungen vom Entwurf oben:**
- Statustyp: eigenes Feld `rootCa: { fingerprint, notAfter }` in `SystemStatus` und `CtlStatusReport` statt `tls.rootFingerprint` –
  `tls.expiresAt` misst seit BM-04 das ausgelieferte Serverzertifikat, die Root ist davon unabhängig. Kein Feld `mode`: ohne eigene
  CA fehlt `rootCa` und `root-ca.crt` wird entfernt.
- Gemeinsamer Code in `@schulos/server/root-ca` (Erkennen, Fingerabdruck, `.cer`, `.mobileconfig`, Download-Antwort), App-Seite in
  `src/core/system/root-ca.ts` (Bestätigung in `app_settings`, Schlüssel `zertifikat.root`; die erste Root gilt als bestätigt).
- Routen: `/api/system/ca?format=crt|cer|mobileconfig` (Admin) und `/ca.crt` (Schulnetz). Backupserver: `/api/ca` nur angemeldet,
  kein `/ca.crt` ohne Anmeldung (dort gibt es keine Unterscheidung Schulnetz/außen).
- Anleitung als Starter-Seite „Schul-Zertifikat installieren“ im Handbuch (anlegen über Starter-Seiten) und INSTALLATION §5d.
- **Hinweis beim Aufruf per IP/Fremdname** (Rest Teil A): Über `http://` zeigt Caddy im Schulnetz eine eigene Hinweisseite
  (Vorlage `adresshinweis` in `compose.yaml`, Caddy-`templates`: aufgerufener Name maskiert, Domain und TLS-Modus aus der
  Umgebung) mit Link auf die Domain und – nur bei eigener CA – auf `/ca.crt` (über http an die App, die nur im Schulnetz
  ausliefert) samt Fingerabdruck-Hinweis. Die Domain und Aufrufe von außen leitet Caddy weiter auf https (seine automatische
  Weiterleitung steht vor dem Catch-all; ACME-HTTP-Prüfungen beantwortet Caddy vor allen Blöcken). Über `https://<IP>` bleibt
  die Zertifikatswarnung **unvermeidbar** – Caddy kennt beim Handshake nur die Domain und liefert deren Zertifikat (INST-10);
  ein Zertifikat für beliebige IPs/Namen (on-demand) wäre ohne Vertrauen in die Root nicht besser und öffnete die Ausstellung
  für fremde Namen. Nach dem Bestätigen der Warnung nennt die Anmeldeseite die richtige Adresse (`src/core/system/foreign-host.ts`).
- **Backupserver:** bewusst kein `/ca.crt` ohne Anmeldung – er unterscheidet nicht zwischen Schulnetz und außen, und seine Root
  braucht nur die IT (angemeldet, Karte „Zertifikat dieses Servers“). Keine Hinweisseite dort: der Aufruf per IP ist beim
  Backupserver der übliche Weg (Konsole zeigt `https://<IP>`).
- **Handbuch-Link:** Verwaltung → System verlinkt die Starter-Seite nur, wenn es sie gibt; sonst verweist die Karte auf
  „Starter-Seiten anlegen“ im Handbuch (bzw. auf INSTALLATION §5d, wenn das Handbuch ausgeschaltet ist).

**Stand Teil B (CA-06…CA-08 umgesetzt), Entscheidungen bei offenen Fragen (konservativ, Umsetzung 2026-11-02):**
- **Installer:** Wert `dns` für `web.tls` („öffentliche Domain, Server nur im Schulnetz (Let's Encrypt per DNS)“), dazu
  `web.dns_provider` und je Anbieter nur die Angaben, die sein Caddy-Modul braucht (`apps/installer/src/dns.ts`):
  `web.dns_token`, `web.dns_user`, `web.dns_secret`, `web.dns_server`, `web.dns_key_alg`, `web.dns_shared_secret` (INWX mit
  Zwei-Faktor) – abweichend vom Entwurf (nur `web.dns_token`), weil netcup, INWX, Route 53 und RFC 2136 mehrere Angaben brauchen.
  Die E-Mail bleibt `web.acme_email` (wie bei Let's Encrypt per HTTP). Je Feld eine Variable `SCHULOS_DNS_*` in der `.env`.
- **Nur Hauptsystem (Stufe 1):** Der Backupserver bekommt die Option nicht – ihn erreichen nur IT und Hauptsystem, die Kopplung
  pinnt seine eigene CA (bzw. nutzt bei Let's Encrypt per HTTP den System-Truststore wie bisher). Wildcard/Backupserver per DNS
  bleibt bei den späteren Stufen.
- **Prüf-DNS-Server** (`web.dns_resolvers`, Vorgabe 9.9.9.9 und 1.1.1.1): ohne sie fragte Caddy den Schul-DNS, der die Domain per
  Split-DNS anders auflöst und den TXT-Eintrag bzw. die Zone nicht kennt (typischer Fehler „expected 1 zone, got 0“). Änderbar,
  falls die Firewall DNS nach außen nur über einen eigenen Server erlaubt.
- **Caddy-Image ohne xcaddy-Aufruf:** `deploy/caddy-dns` enthält das Hauptprogramm, das xcaddy erzeugen würde, mit `go.mod` und
  `go.sum` – so liegt jede Abhängigkeit mit Prüfsumme fest, der Bau ist reproduzierbar (`-trimpath`, `-buildvcs=false`,
  `GOTOOLCHAIN=local`, `-mod=readonly`) und Dependabot (`gomod`) hält Caddy und die Module aktuell; xcaddy selbst wäre eine
  weitere, ungepinnte Abhängigkeit. Go-Basis (`golang`) und Laufzeit-Basis (`caddy:2`) per Digest aus `deploy/upstream/Dockerfile`.
  Hetzner über das Modul `caddy-dns/hetzner/v2` (DNS-API der Hetzner Console, API-Token eines Projekts).
- **Image im Release optional** (`images.caddy-dns` im Manifest): ältere Releases haben es nicht; eine Release-ISO bringt es nur,
  wenn das Release es nennt. `schulosctl update` führt `SCHULOS_CADDY_DNS_IMAGE` immer mit und stellt `SCHULOS_CADDY_IMAGE` nur
  bei DNS-Prüfung darauf um; nennt ein Release es nicht, **bricht das Update ab** (sonst liefe Caddy ohne Modul).
- **Abschlussprüfung = Erststart + `schulosctl zertifikat-pruefen`:** Eine Prüfung des Zugangs schon im Installer (acht
  verschiedene APIs, im Live-System ohne Caddy) ist bewusst nicht gebaut. Der Installer prüft Pflichtangaben und Formate (u. a. das
  Token-Format von Cloudflare – ein falsches stünde sonst in der Fehlermeldung des Moduls); der Erststart wartet bis zu 25 Minuten
  auf ein öffentlich gültiges Zertifikat und meldet sonst Ursache und nächsten Schritt, ohne SchulOS anzuhalten.
- **Ablaufwarnung:** Erneuerung überfällig = Restlaufzeit unter einem Drittel (Caddys Erneuerungszeitpunkt) minus Spielraum
  (ein Zehntel der Laufzeit, höchstens 3 Tage) – passt auch zu kürzeren Laufzeiten künftiger Let's-Encrypt-Zertifikate. Fehler der
  Erneuerung selbst (Caddy-Protokoll) werden nicht ausgewertet: die überfällige Erneuerung ist das verlässliche Zeichen, das
  Protokoll nennt dann die Ursache. Gilt für alle ACME-Zertifikate (auch Let's Encrypt per HTTP).
- **Systemtest mit ACME-Staging:** in der CI ohne Domain bis zur Ausstellung (`scripts/caddy-dns-test.sh`, Job `stack`), die
  Ausstellung selbst manuell (`scripts/acme-staging-test.sh`, INSTALLATION §5d.1). Ein vollautomatischer Test mit lokaler
  ACME-Test-CA und eigenem DNS-Server (RFC 2136) wäre möglich, ist aber eine spätere Stufe.

## Datenschutz

- Das Root-Zertifikat ist öffentlich und ohne Personenbezug. **Die Schlüssel der CA sind schützenswert:** nur im verschlüsselten Backup,
  nie im Download, nie im Support-Bundle (`schulosctl`, Bundle-Inhalt prüfen).
- Öffentliche Zertifikate: Der Domainname erscheint in den öffentlichen Certificate-Transparency-Logs (kein Personenbezug, im
  Hinweis erwähnen); der DNS-Anbieter sieht nur TXT-Änderungen; das API-Token ist ein Geheimnis.
- Löschklasse: nicht personenbezogen, kein `retention`-Eintrag. Sichtbarkeit: Download für Admin und im Schulnetz; Fingerabdruck
  zusätzlich an der Konsole.

## Aufgaben (Größe)

| Nr. | Aufgabe | Größe | Abhängigkeit |
|---|---|---|---|
| CA-01 | `caddy_data` + `step_ca` in Backup und Restore, Tests, Systemtest (Sofort-Fix) | M | – |
| CA-02 | Root + Fingerabdruck über `schulosctl` ins `config`-Volume, Statustyp erweitern | S | – |
| CA-03 | Download-Route (angemeldet und `/ca.crt` im Schulnetz) + Systemseite + Alarm bei Root-Wechsel | S | CA-02 |
| CA-04 | `.mobileconfig` + Hilfeseite/Anleitung | S–M | CA-03 |
| CA-05 | Backupserver: Download in `apps/backup` | S | CA-02 |
| CA-06 | Installer-Option DNS-01 (Anbieterliste, Tokenablage, Abschlussprüfung) | M | CA-07 |
| CA-07 | Eigenes Caddy-Image (xcaddy, Digest, ISO, Update-Weg, Dependabot) | M | – |
| CA-08 | Ablaufwarnung, Doku-Checkliste, Systemtest mit ACME-Staging | S–M | CA-06, CA-07 |

Teil A (CA-01…05) ≈ M, Teil B (CA-06…08) ≈ M–L; Gesamt **L**. Teil A ist unabhängig lieferbar und behebt den akuten Schmerz.

## Entscheidungen (Projektleitung 2026-11-01)

- **ca-1** Backup der CA (`caddy_data`/`step_ca`) als Fehler beheben, als eigene kleine Aufgabe vor dem Rest. – wie vorgeschlagen
- **ca-2** Root auch ohne Anmeldung unter `/ca.crt`, nur Schulnetz, mit angezeigtem Fingerabdruck zum Abgleich an der Konsole. – wie vorgeschlagen
- **ca-3** Teil B wird umgesetzt, Stufe 1 mit cloudflare, hetzner, ionos, netcup, inwx, desec, route53, rfc2136. – wie vorgeschlagen
- **ca-4** Eigenes Caddy-Image nur bei DNS-01 (Standard bleibt `caddy:2`). – wie vorgeschlagen
- **ca-5** `.mobileconfig` für Apple + Anleitungstabelle (GPO, Geräteverwaltung, Admin-Konsole) ohne Herstellerbindung. – wie vorgeschlagen
- **ca-6** Wechsel der Root löst einen Alarm an Admin aus, bis der neue Fingerabdruck bestätigt ist. – wie vorgeschlagen
- **rf-1** Reihenfolge der Runde 12: CA-01 zuerst als Sofort-Fix → Betriebsmonitoring → CA Teil A (Rest) → Klassenbildung 1–2 →
  Inventar INV-01/02 → CA Teil B → Inventar Rest. – wie vorgeschlagen
