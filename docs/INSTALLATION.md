# SchulOS – Installationskonzept (ISO-Komplettpaket)

> Stand: 2026-10-03 · Status: **Konzept, Grundrichtung von der Projektleitung bestätigt** (Debian 13 + Docker Compose,
> ein Installer für Hauptsystem und Backupserver, Demo- oder Produktivinstanz, alles quelloffen)

> **Ohne Gewähr, Betrieb in eigener Verantwortung (DS-14):** SchulOS ist ein quelloffenes Lern- und Demoprojekt ohne
> Gewährleistung und Haftung (AGPL-3.0, §§ 15–16). Verantwortliche nach DSGVO ist die Schule, die SchulOS betreibt;
> SchulOS liefert Vorgaben und Vorlagen (Datenschutzhinweise, VVT), die die Schule prüft und anpasst. Vor dem Betrieb mit
> echten Daten die bzw. den Datenschutzbeauftragten der Schule einbinden. Der Installer zeigt diesen Hinweis am Ende.

> **Vorschau-Software (REPO-03):** ohne Gewähr, **kein Support**; verantwortlich für die Daten ist die Schule. Vor einem
> Echteinsatz fehlen: externer Penetrationstest (SEC-16), Klärung mit der bzw. dem Datenschutzbeauftragten, Pilotbetrieb.
> Der Installer zeigt das **vor allen Fragen und vor der Plattenauswahl**; weiter geht es nur mit eingetipptem
> „VERSTANDEN“ (Esc beendet, nichts verändert). In der Web-Oberfläche sehen Admins (Recht „System“) ein Band, bis einer den
> Hinweis unter Verwaltung → System bestätigt (einmal je Fassung, Protokoll `system.disclaimer.ack`); die Karte bleibt dort
> dauerhaft – so kommt der Hinweis auch per Update auf bestehende Server. Entfällt mit v1.0 nach dem Pilot.

---

## 1. Ziel

**Eine ISO für alles.** Beim Start wählt man die Rolle:

| Rolle | Wozu | Läuft darauf |
|---|---|---|
| **Hauptsystem** | der SchulOS-Server der Schule | SchulOS-App, Postgres, Caddy, Backup-Agent |
| **Backupserver** | eigener Rechner, getrennt vom Hauptsystem (anderer Raum oder anderes Gebäude) | **SchulOS Backup** mit eigener Web-UI, restic-Speicher, optional Offsite-Kopie |

Ablauf aus Sicht der installierenden Person:

1. ISO auf einen USB-Stick schreiben bzw. in Proxmox als VM-Laufwerk einhängen und starten
2. Der Installer fragt **alle nötigen Angaben vorab** ab (§3) und zeigt eine Zusammenfassung
3. „Installieren“ – danach läuft alles unbeaufsichtigt (≈ 10 Minuten, ohne Internet)
4. Nach dem Neustart zeigt die Konsole die Adresse der Web-Oberfläche (Domain und IP) und den Status, etwa
   `https://schulos.schule-xy.de · läuft · letztes Backup: –`
5. Fertig. Hauptsystem und Backupserver sind schon gekoppelt, wenn der Backupserver zuerst
   installiert wurde (§4.3)

Der Web-Assistent aus dem ersten Entwurf entfällt als Pflichtschritt. Was im Installer
abgefragt wurde, lässt sich später in der Verwaltung ändern.

### 1.1 ISO herunterladen und prüfen (REPO-02)

Jedes Release hat als Anhang die ISO `schulos-<version>.iso`, ihre Prüfsumme `schulos-<version>.iso.sha256`, die
cosign-Signatur der Prüfsumme `schulos-<version>.iso.sha256.sig` und die Stückliste `schulos-<version>.stueckliste.json`
(alle Images per Digest). Signiert ist mit demselben Schlüssel wie Images und Release-Manifest (`release/README.md`).
Das Repository ist öffentlich – der Download geht ohne Anmeldung, auch per Browser von der Release-Seite.

```bash
V=<version>; R=schulos/schulos       # Repo der Releases
gh release download "v$V" -R "$R" -p "schulos-$V.iso*"       # oder per Browser von der Release-Seite
# öffentlicher Schlüssel aus dem Repo – Fingerabdruck mit release/README.md vergleichen (am besten über einen
# zweiten Weg, z. B. eine schon installierte Fassung oder die Projektseite)
curl -fsSLO "https://raw.githubusercontent.com/$R/v$V/release/cosign.pub"
openssl pkey -pubin -in cosign.pub -outform DER | sha256sum
# 1. Signatur der Prüfsumme (ohne Transparenzlog signiert, daher --insecure-ignore-tlog) → „Verified OK“
cosign verify-blob --key cosign.pub --insecure-ignore-tlog=true \
  --signature "schulos-$V.iso.sha256.sig" "schulos-$V.iso.sha256"
# 2. ISO gegen die Prüfsumme → „schulos-<version>.iso: OK“
sha256sum -c "schulos-$V.iso.sha256"
```

Unter Windows: `cosign.exe` (Release-Seite von sigstore/cosign) für Schritt 1, für Schritt 2
`(Get-FileHash schulos-<version>.iso -Algorithm SHA256).Hash` mit der ersten Spalte der `.sha256`-Datei vergleichen.
Erst wenn beide Schritte passen, die ISO auf einen Stick schreiben (z. B. `dd`, Rufus im DD-Modus, balenaEtcher) bzw. in
den Hypervisor laden. Eine ISO ohne passende Signatur nicht verwenden.

---

## 2. Aufbau der ISO

```
┌─────────────────────── schulos-<version>.iso (≈ 1,5 GB) ──────────────────────┐
│ Debian-13-Live-Umgebung (minimal) + SchulOS-Installer (Text-Oberfläche)       │
│ Offline-Paketquelle: Debian-Basis, docker.io, docker-compose, restic, ...     │
│ Container-Images als .tar:  schulos-app · postgres:18 · caddy                 │
│                             schulos-backup · restic-rest-server               │
│ /opt/schulos: compose-Dateien je Rolle, schulosctl, systemd-Units             │
└───────────────────────────────────────────────────────────────────────────────┘
```

| Entscheidung | Gewählt | Warum |
|---|---|---|
| Basis-OS | **Debian 13 „trixie“** | verbreitete Basis für Schulserver, lange Sicherheitsunterstützung, frei |
| Laufzeit | **Docker Engine + Compose** (Debian-Paket `docker.io`, Apache 2.0) | wie im Homelab; derselbe Stack läuft auch ohne ISO |
| Installer-Technik | **eigener Installer in einer Live-Umgebung** (wie Proxmox oder TrueNAS): erst alle Fragen, dann Partitionieren, `debootstrap` aus der Offline-Quelle, Konfiguration schreiben | Der Debian-Installer (d-i) kann eigene Fragen nur umständlich stellen und mischt Fragen mit Installation. Hier sollen alle Fragen **vorher** kommen, Prüfungen inklusive (Passwortstärke, IP-Format, Erreichbarkeit des Backupservers) |
| Installer-Oberfläche | TypeScript + Ink (Text-Oberfläche, läuft auf der nackten Konsole) | eine Sprache im ganzen Projekt; Logik (Validierung, Konfiguration erzeugen) mit Vitest testbar. Die Systemschritte (Partitionieren, LUKS, debootstrap) sind kleine Shell-Skripte |
| ISO-Bau | `live-build` in GitHub Actions | reproduzierbar, CI-Test in QEMU (§7) |

**Antwortdatei:** Liegt eine `schulos-install.yaml` auf dem Stick (oder auf einem zweiten mit der
Bezeichnung `SCHULOSCFG`), übernimmt der Installer die Antworten daraus als **Vorbelegung** und fragt nur, was fehlt –
bestätigt wird immer in der Oberfläche (Vorschau-Hinweis, Zusammenfassung, ggf. „ÜBERSCHREIBEN“). Das hilft einem
Schulträger, der mehrere Schulen ausstattet. Am Ende jeder Installation bietet der Installer die Antworten **ohne Passwörter**
als Datei an. **Eine Installation ganz ohne Mensch davor gibt es nur als CI-Testmodus** für die Entwicklung (INST-07, §7.1) –
ein Stick allein löst sie nie aus.

**Umgesetzt (B-40…B-42, `apps/installer`):**
- *Fragen* (§3) als Daten mit Vorgaben, Prüfungen und Warnungen; `schulos-install.yaml` lesen/schreiben (Export ohne Geheimnisse);
  daraus `.env` + `schulos.env` bzw. `backup.env` je Rolle (Admin-Passwort nur als scrypt-Hash), Wartungsfenster als Timer-Drop-in.
- *Text-Oberfläche* (Ink): alle Fragen vorab, Platten aus `lsblk`, Passwörter doppelt, Vorab-Prüfung Backupserver + Kopplungscode
  (nur „hello“, Code bleibt unverbraucht), Zusammenfassung mit Ändern. `--unbeaufsichtigt` ohne Oberfläche (beim Installieren
  nur im CI-Testmodus, §7.1).
- *Systemschritte* (`src/system/`, argv-Listen statt Shell-Zeichenketten, Geheimnisse nur auf stdin, Protokoll ohne sie):
  GPT/UEFI mit EFI-Partition je Platte (`grub-install --removable` auf jeder → Spiegel startet auch ohne erste Platte) · bei zwei
  Platten mdadm-RAID 1 · **/boot unverschlüsselt** auf eigener ext4-Partition (bei zwei Platten eigener Spiegel): GRUB kann LUKS2 mit
  Argon2 nicht öffnen, entsperrt wird im Initramfs · LUKS2: Passphrase, TPM2 (PCR 7+8+9, SEC-09) oder TPM2 + PIN **plus Wiederherstellungsschlüssel**, der am Ende angezeigt und bestätigt (§2.1)
  wird (ohne ihn bricht die Installation ab) · btrfs `@`/`@srv`/`@snapshots` · fstab/crypttab über Labels statt UUIDs ·
  debootstrap aus der Offline-Quelle, Kernel + **dracut** + Docker danach per apt in der chroot (debootstrap würde initramfs-tools
  danebenlegen) · systemd-networkd/resolved, Tastatur, Sprache, Zeitzone, Wartungskonto `schulos-admin` (sudo, docker), root
  gesperrt, SSH nur mit Schlüssel ohne Passwort · Docker 26 aus Debian mit **containerd-Image-Speicher** und `data-root` `/srv/docker`
  (Volumes liegen in `@srv`, nicht im System-Schnappschuss) · Node 24 vom Medium (Debian hat 20) für `schulosctl` · Units aus
  `deploy/systemd` (Hauptsystem) · **Erststart** (`schulos-erststart.service`, einmal): Images laden, starten, koppeln – bzw. vor
  dem ersten App-Start wiederherstellen · **Konsolenstatus** auf tty1 (Web-Oberfläche per Domain und IP, Zustand, letztes Backup bzw. beim Backupserver der Weg zum Kopplungscode), Anmelden mit **Enter** auf tty1 (agetty, normales Passwort, kein Autologin; nach dem Abmelden wieder der Status) bzw. auf tty2 (Strg+Alt+F2).
- *Wiederherstellen* als Instanztyp: „aus Backup“ (Ersatz-Kopplungscode → `agent.mjs wiederherstellen`) und „aus der Offsite-Kopie“
  (rclone-Ziel + Wiederherstellungsschlüssel → neu `agent.mjs wiederherstellen-offsite`; findet die Sicherung im Ordner selbst,
  bei mehreren fragt es nach dem Unterordner `i-…`). Beides immer als Produktivinstanz; SMTP wird neu gefragt (steht nicht in der
  Sicherung). Host-Schlüssel des SFTP-Ziels übernimmt der Erststart beim ersten Kontakt (Fingerabdruck im Protokoll).
- *Medium* (`--medium`, auf der ISO `/run/live/medium/schulos`): `node/`, `compose.yaml`, `compose.backup.yaml`, `schulosctl.mjs`,
  `systemd/`, `images/*.tar` + `images/images.env` (Image-Namen für die `.env`, seit SEC-08 als `name:tag@sha256:…` mit dem Digest aus dem Archiv – nach der
  Installation zählt kein Tag mehr; auch `compose.backup.yaml` nimmt alle Images aus Variablen) – baut B-44.
- *ISO* (B-44, `iso/`): `bash iso/build-docker.sh [--version x] [--rauchtest]` baut Bundles und Images (aus dem Stand im Repo) und
  ruft `iso/build.sh` in einem privilegierten Debian-13-Container auf: Offline-Paketquelle `/debian` mit genau den Paketen aus
  `schulos-installer --paketliste` samt Abhängigkeiten (debootstrap + `apt --download-only`, Index per apt-ftparchive, unsigniert →
  `--no-check-gpg`/`[trusted=yes]` nur für diese Quelle), `/schulos` (Medium, Node 24 mit Prüfsumme von nodejs.org), Live-System
  per live-build (nur UEFI, deutsches Bootmenü mit 5 s Timeout, Installer statt Anmeldung auf tty1, Antworten von der ISO oder vom
  Laufwerk `SCHULOSCFG` (Test-Schalter dort nur im CI-Testmodus, §7.1), Meldungen auch auf ttyS0 – Wiederherstellungsschlüssel und Kopplungscode
  dort geschwärzt). Danach prüft das Skript Inhalt und Bootmenü (auch: kein `schulos.testmodus` in der gebauten ISO);
  `iso/smoke.sh` startet die ISO in QEMU/OVMF bis zum Installer. Workflow `iso.yml` (von Hand, Artefakt 2 Tage).
  Stand dev: ≈ 1,4 GB. Images für eine Release-ISO aus den signierten GHCR-Images – mit dem Release-Workflow.
- *Stückliste* (B-48): `schulos-<v>.stueckliste.json` neben der ISO – Version, Git-Commit, Node-Version, alle Debian-Pakete der
  Offline-Quelle (= Zielsystem) und des Live-Systems mit Version, jedes Image mit ID bzw. Registry-Digest; dazu `sbom-<v>/` mit
  einer CycloneDX-SBOM je Image (syft: OS- und npm-Pakete in den Images). Dieselbe Stückliste (ohne Live-System) liegt auf dem
  Medium und nach der Installation unter `/usr/share/doc/schulos/stueckliste.json`. Releases: Commit und Digests in `release.json`,
  CycloneDX je signiertem Image als Release-Anhang `sbom-{app,backup,agent}.cdx.json`.
- *Reproduzierbar* (B-47): Debian (Offline-Quelle, Live-System, Bauwerkzeuge) aus `snapshot.debian.org` mit dem Datum in
  `iso/debian-snapshot` – Debian-Updates kommen bewusst per neuem Datum (eigener PR); `SCHULOS_DEBIAN_MIRROR`/`-SECURITY`
  überschreiben das. Fremd-Images, Build-Container (`node:24-trixie`), BuildKit und syft per Digest aus
  `deploy/upstream/Dockerfile` (Dependabot, wöchentlich; `sh scripts/pin.sh <name>`); dieselben Digests nimmt ein getaggtes
  Release, der wöchentliche Neubau löst die Tags frisch auf. Alle Zeitstempel = `SOURCE_DATE_EPOCH` (Commit-Zeit); eigene
  Images als Archiv (`type=docker`) mit `rewrite-timestamp`, ohne Provenance. Prüfung: `bash iso/repro.sh` (bzw. `gh workflow run iso.yml
  -f reproduzierbar=true`) baut zweimal und vergleicht je Datei (Medium und Live-System, diffoscope für Abweichungen).
  **Grenzen:** App- und Backup-Image sind nicht bitgleich – Next.js würfelt Chunk-/Action-IDs und Schlüssel (Vorschau,
  Server Actions), die geheim bleiben müssen; das fällt mit der Release-ISO aus den signierten Images (B-49) weg. `apk add` in den
  Images zieht den jeweils aktuellen Alpine-Stand (kein Snapshot) – bitgleich nur zeitnah, die Stückliste hält fest, was drin ist.
- *Getestet*: Schritte als Unit-Tests; echt mit `scripts/installer-system-test.sh` (privilegierter Debian-13-Container, Loop-Geräte):
  „einfach“ lokal (Docker Desktop kann weder md noch dm-crypt), „spiegel“ (2 Platten, mdadm, LUKS) im Workflow `installer.yml`
  (von Hand). TPM2, der echte Start und Erststart/Konsole folgen mit den QEMU-Tests (B-45).

### 2.1 Abschluss der Installation (INST-01)

- **Wiederherstellungsschlüssel** (nur bei TPM2): Der Installer zeigt ihn am Ende als **Text** in 8 nummerierten Blöcken und
  darunter am Stück (passt in 80×25; in der Hyper-V-Konsole, die keinen Text kopieren kann: abschreiben oder abfotografieren).
  **Keinen QR-Code** (INST-05): Auf der Linux-Konsole fehlten der Schrift die Halbblöcke (◆ statt ▀ ▄) – vermutlich, weil setupcon aus dem postinst
  von console-setup ersetzt während debootstrap die Schrift des Live-Systems –, der Code war nicht scanbar. **Kein Zeitlimit:** Weiter geht es erst, wenn **Block 8** eingetippt ist (Groß-/Kleinschreibung
  egal); falsch → nochmal, Enter ohne Eingabe → Schlüssel erneut anzeigen. Der Schlüssel landet nie im Protokoll und nie auf der
  seriellen Schnittstelle. Beim Start (TPM-Ausfall) wird er mit allen 8 Blöcken samt Bindestrichen eingegeben.
- **Kopplungscode** (Backupserver) danach auf dem Abschlussbildschirm – der Installer des Hauptsystems fragt ihn ab, der
  Backupserver übernimmt ihn beim ersten Start (24 h gültig, einmal verwendbar). Später oder abgelaufen: Web-Oberfläche des
  Backupservers → „Instanzen“ → „Kopplungscode erzeugen“; diesen Hinweis und die Adresse zeigt auch die Konsole nach dem Neustart.
- **Ohne Eingabe geht es nie weiter** (INST-05): Bis 0.3.2 endete der Installer an der Frage nach Block 8 sofort mit Code 0 (Ink gab
  stdin frei) – ohne Bestätigung, ohne Startreihenfolge, Neustart nach 30 s wieder in den Installer. Jetzt: Startreihenfolge wird
  vor der Bestätigung gesetzt; ist die Eingabe weg (EOF), bleibt der Schlüssel stehen und es wird nicht neu gestartet; Strg+C
  beendet die Fragen nicht. Neu gestartet wird nur auf Tastendruck (Enter bzw. `a` = ausschalten), nie per Zeitablauf.
- **Bootmenü der ISO:** Findet es eine **fertige** SchulOS-Installation (Markierung `/grub/schulos-installiert` auf der
  Boot-Partition, schreibt der Installer als letzten Schritt; auch auf dem Spiegel über `mdraid1x`), ist „Von der Festplatte
  starten“ die Vorgabe (nach 5 s) – auch wenn eine Firmware die Startreihenfolge nicht übernommen hat. Eine abgebrochene
  Installation zählt nicht. Liegt ein Antworten-Laufwerk `SCHULOSCFG` bei (bzw. steht `schulos.unbeaufsichtigt` in der
  Kernel-Zeile), bleibt der Installer die Vorgabe – eine unbeaufsichtigte (Neu-)Installation startet nie von selbst die alte
  Platte (GATE-4f C-03/C-04). Neu installieren: „SchulOS installieren“ wählen. Dass ein solcher Neustart mit noch steckendem
  Stick die frische Installation nicht wieder löscht, regelt der Überschreibschutz (INST-06, unten).
- **Startmedium:** Das Live-System läuft bis zum Schluss vom Medium (squashfs unter `/run/live/medium`) – es darf **nicht**
  während der Installation bzw. vor dem Neustart entfernt werden (sonst I/O-Fehler, INST-01). Der Installer trägt je Platte einen
  UEFI-Eintrag „SchulOS“ (beim Spiegel zusätzlich „SchulOS (Platte 2)“) auf `\EFI\BOOT\BOOTX64.EFI` (shim) ein und setzt ihn an den
  Anfang der Startreihenfolge (`efibootmgr`; frühere SchulOS-Einträge werden ersetzt). **Abschlussbildschirm (INST-06,
  Q-INST05-1)**, interaktiv wie unbeaufsichtigt, direkt vor der Frage *Enter = Neustart* (oder `a` = ausschalten; normaler
  Neustart wie in INST-05): „Das Installationsmedium kann nach dem Neustart entfernt werden – bleibt es drin, startet SchulOS
  automatisch von der Festplatte“ (Abschluss-Markierung + Vorgabe im Startmenü der ISO). Steckt ein eigener
  Konfigurations-Stick `SCHULOSCFG`, hängt der Installer ihn aus und zeigt darüber „>>> Konfigurations-Stick (SCHULOSCFG) JETZT
  abziehen, dann die Taste drücken. <<<“ – mit Stick bliebe im Startmenü der Installer die Vorgabe. `start-installer.sh`
  unterscheidet (`SCHULOS_CFG_ORT`): liegt `SCHULOSCFG` auf demselben Datenträger wie das Live-Medium (`lsblk` PKNAME von
  `findmnt /run/live/medium`, z. B. zusätzliche Partition auf dem ISO-Stick), wird es wie das Medium behandelt („nach dem
  Neustart bzw. bei ausgeschaltetem Rechner entfernen“, kein JETZT). Lässt sich die Startreihenfolge nicht setzen (kein UEFI,
  NVRAM gesperrt): Hinweis „im Boot-Menü die Platte wählen“, Vorgabe ist dann **ausschalten**.
- **Überschreibschutz (INST-06):** Bevor der Installer Platten löscht, prüft er jede Zielplatte auf die Markierung
  `/grub/schulos-installiert` – nur lesend: Boot-Partition (Nr. 2) per `blkid -p` erkennen, ext4 mit `ro,noload,nodev,nosuid,noexec`
  einhängen; beim Spiegel das einzelne Mitglied über den Daten-Offset aus `mdadm --examine` (kein Zusammensetzen des Spiegels),
  danach wieder aushängen. Die Markierung enthält seit INST-06 Rolle, Version und Datum (ältere: „nicht lesbar“).
  *Interaktiv* fragt er eigens: „Auf dieser Platte ist bereits SchulOS installiert (Hauptsystem, Version …, installiert am …) –
  wirklich überschreiben? Zum Bestätigen „ÜBERSCHREIBEN“ eintippen“ (Groß-/Kleinschreibung egal, „UEBERSCHREIBEN“ geht auch);
  alles andere, Strg+C oder EOF bricht ab. *Unbeaufsichtigt* (nur CI-Testmodus, §7.1; und mit `--plan`) nur mit Datei `ueberschreiben` auf dem
  SCHULOSCFG-Stick bzw. `schulos.ueberschreiben` in der Kernel-Zeile (Installer-Schalter `--ueberschreiben`; ersetzt interaktiv die
  Rückfrage nicht). Sonst endet der Installer mit **Code 5**, es wurde nichts verändert, die Meldung (Platte, Rolle/Version/Datum,
  „Konfigurations-Stick abziehen und neu starten“) steht auf tty1 und seriell; `start-installer.sh` startet dann **nicht** neu, sondern
  wartet auf `n` (neu starten), `a` (ausschalten) oder `i` (Installer neu starten) – mit `danach-aus` schaltet es aus (CI). So endet
  der Kreislauf „Firmware ignoriert die Startreihenfolge, Medium und Stick stecken noch → nach 5 s Neuinstallation“. Abbild bauen
  (`--abbild`) und einrichten (`--konfigurieren`) prüfen nicht (frische Bau-Platte bzw. laufendes System).
- **Unbeaufsichtigt** gibt es nur im CI-Testmodus (INST-07) – Ablauf und Test-Schalter in §7.1 (für Entwickler).
- **Schlüssel verloren?** Solange das TPM entsperrt, im installierten System als root an der Konsole bzw. per SSH:
  `sudo schulosctl wiederherstellungsschluessel` – entsperrt per TPM2 (`systemd-cryptenroll --unlock-tpm2-device=auto
  --recovery-key`), zeigt den neuen Schlüssel wie oben (nur Text) bis zur Bestätigung von Block 8 und löscht **erst dann** die
  alten Wiederherstellungs-Schlüsselplätze (`--wipe-slot=<platz>`, Plätze aus `cryptsetup luksDump --dump-json-metadata`).

**Test in Hyper-V:** VM der **Generation 2**; unter *Sicherheit* Secure Boot an mit der Vorlage **„Microsoft UEFI Certificate
Authority“** (nicht „Microsoft Windows“ – sonst startet shim/GRUB nicht), **TPM aktivieren** (vTPM, für LUKS mit TPM2); mindestens
32 GB Platte. Die ISO als DVD einlegen und unter *Firmware* zuerst starten lassen. Nach der Installation setzt der Installer die
Startreihenfolge selbst (siehe oben); klappt das nicht, unter *Firmware* die Festplatte nach oben schieben bzw. die DVD bei
ausgeschalteter VM auswerfen.

**Konsole im installierten System (INST-03):** Im Hyper-V-Konsolenfenster geht Alt+F2 nicht – deshalb zeigt tty1 den Status mit
„Enter drücken zum Anmelden“ (Benutzer `schulos-admin`, Passwort wie bei der Installation; alternativ Strg+Alt+F2). Nach 2 Minuten ohne Anmeldung und nach dem Abmelden kehrt tty1 zum
Status zurück. Das Zielsystem bekommt `/etc/default/console-setup` (UTF-8, Terminus) und die SchulOS-Konsolenschrift vom
Startmedium (`/usr/local/share/schulos/konsolenschrift`); `konsole.sh` und `schulosctl wiederherstellungsschluessel` schalten die VT
auf UTF-8 und laden die passende Größe (`konsole.sh` vor jedem Neuzeichnen); ohne die Schrift bleibt die Standardschrift.

### 2.2 Oberfläche des Installers (INST-02)

- Textmodus (Ink) in einem Rahmen: Kopf mit Logo und Version (`VERSION` auf dem Medium), links die **Schrittleiste** der
  Abschnitte (✔ erledigt, ▶ aktuell, · offen – bis Zusammenfassung und Installation), rechts die Frage, unten die Tasten. Passt in
  **80×25**; größere Terminals werden bis 120×40 genutzt, lange Listen (Bundesland) und die Zusammenfassung (Tabelle nach
  Abschnitten) zeigen einen Ausschnitt mit ▲/▼.
- **Installation:** Fortschrittsbalken über die Systemschritte (Schritt x von y, aktueller Schritt, verstrichene Zeit), darunter
  dezent die letzten Zeilen des Protokolls. Bei einem Fehler: Abbruch-Bildschirm mit Schritt, Meldung, Protokollpfad und
  **Alt+F2** (Konsole); danach wie bisher „Enter = Installer neu starten“. Unbeaufsichtigt, seriell und `--abbild` schreiben
  weiter Zeilen.
- **Zeichen und Farben:** Akzent aus `packages/ui` (Schulfarbe). Auf der Linux-Konsole (`TERM=linux`) nur die 8 Grundfarben und
  Zeichen, die auch die CP437-Schrift des Kernels hat (√ ► » █ ░ ┌─┐); ohne UTF-8 nur ASCII (`SCHULOS_TUI_ZEICHEN=unicode|konsole|ascii`
  erzwingt eine Stufe).
- **Konsolenschrift:** Die Schriften von console-setup (Lat15/Uni2, auch Terminus) haben keine Halbblöcke ▀ ▄ – das Logo wäre
  damit unleserlich (der QR-Code des Wiederherstellungsschlüssels ist mit INST-05 entfallen). Beim ISO-Bau erzeugt der Hook daraus `schulos-<B>x<H>.psf`
  (Terminus Bold mit ▀ ▄ ▌ ▐ ▓ statt einiger seltener kyrillischer Buchstaben, `schulos-installer --konsolenschrift`), der Installer
  lädt beim Start per `setfont` die größte Größe, mit der der Bildschirm noch 100×30 Zeichen fasst (sonst 80×25; z. B. 1024×768 →
  10×20, 1920×1080 → 16×32). Kein Grafikstack (kmscon o. ä.).

### 2.3 Schutz bei physischem Zugriff: GRUB-Passwort und TPM2 (SEC-09)

- **GRUB-Superuser:** Jede Installation setzt im Bootmenü den Superuser `schulos` mit einem eigenen, **zufällig erzeugten
  Bootmenü-Passwort** (Q-4E-61, G4E-O04/O05; nur als PBKDF2-Hash, `/etc/grub.d/01_schulos-passwort`). Der Installer zeigt es am
  Ende zusammen mit dem Wiederherstellungsschlüssel (seriell geschwärzt), ein eingerichtetes Abbild bis zum ersten Neustart auf
  der Konsole – **aufschreiben und zum Wiederherstellungsschlüssel legen**. Es ist nicht das Wartungspasswort, weil der Hash auf
  dem unverschlüsselten /boot liegt und sich offline angreifen ließe (dort gilt nur das Bootmenü-Passwort, nicht sudo/SSH).
  Der Standardeintrag „SchulOS“ (neuester Kernel, `/etc/grub.d/09_schulos-standard`, `--unrestricted`) startet ohne Eingabe;
  **Einträge bearbeiten (`e`), GRUB-Kommandozeile (`c`) und alle anderen Einträge** (ältere Kernel, „Stand vor dem
  Debian-Versionswechsel“, Schnappschüsse) verlangen Benutzer `schulos` + Passwort. So kommt niemand am Bootmenü per
  `init=/bin/sh` an das entsperrte System. **Am Bootmenü gilt die US-Tastaturbelegung** (y/z vertauscht, Sonderzeichen woanders,
  keine Umlaute): das erzeugte Passwort enthält nur Kleinbuchstaben a–x ohne i/l/o und Ziffern 2–9 – auf beiden Belegungen
  gleich; in Vierergruppen angezeigt, **ohne Leerzeichen** eintippen. Neu erzeugen: `sudo schulosctl sicherheit-nachruesten`;
  ein eigenes nur per `--passwort-stdin` und nur aus a–x, A–X, 0–9 (mindestens 12 Zeichen).
- **TPM2 nur mit Secure Boot:** Der Installer bietet TPM2 nur an, wenn Secure Boot aktiv ist (EFI-Variable `SecureBoot`);
  sonst Hinweis „im UEFI einschalten oder Passphrase wählen“. Ohne Secure Boot wäre PCR 7 wertlos.
- **TPM2 (automatisch)** – PCR **7+8+9** (Secure-Boot-Zustand, GRUB-Befehle, von GRUB gelesene Dateien: Kernel, Initramfs,
  grub.cfg). Im Live-System misst die GRUB der ISO, deshalb bindet der Installer zunächst nur an PCR 7 und legt eine Markierung;
  der **erste Start** des neuen Systems bindet an 7+8+9 und löscht alle anderen TPM2-Plätze (`schulos-tpm.service` →
  `/usr/local/lib/schulos/tpm-binden.sh start`). Steckt dabei das Startmedium (Start über dessen GRUB, andere Messwerte), wartet die
  Bindung bis zum Start ohne Medium.
- **Kernel-Updates** brechen die Entsperrung nicht: nach jedem dpkg-Lauf (auch unattended-upgrades) und beim Herunterfahren
  prüft `tpm-binden.sh pruefen` den Stand **aller Dateien unter /boot** samt EFI-Partition (Kernel, Initramfs, grub.cfg, grubenv,
  GRUB-Module, Sprachdateien und Schriften, Stub-grub.cfg, shim/GRUB – G4E-O02); hat er sich geändert, kommt ein
  **Übergangsschlüssel nur an PCR 7** dazu, der nächste Start entsperrt damit und bindet neu an 7+8+9. Zwischen Update und
  Neustart gilt also kurz nur PCR 7 (wie bisher). Fehlt der Übergang (Stromausfall direkt nach einem Update), fragt der Start
  nach dem Wiederherstellungsschlüssel.
- **shim-/GRUB-Updates** (`shim-signed`, `grub-efi-amd64-signed`): ein neues shim kann auch **PCR 7** ändern (SBAT-Stand) – dann
  hilft der Übergangsschlüssel nicht sicher. SchulOS legt ihn trotzdem an, vermerkt aber `efi-geaendert`: das Wartungsfenster
  startet dann **nicht** selbst neu (wie bei der Passphrase, Verwaltung → System „Neustart nötig“ samt Alarm). Neu starten, wenn
  jemand an der Konsole ist; verlangt der Start den Wiederherstellungsschlüssel, eingeben und danach `sudo schulosctl tpm-neu-binden`.
- **Überwachung der Bindung (G4E-O03):** `schulosctl system-sync` (Hauptsystem) bzw. `schulos-hoststatus.timer` (Backupserver)
  melden, wenn die Platte nicht vollständig an PCR 7+8+9 gebunden ist – Secure Boot aus, andere bzw. zusätzliche TPM2-Plätze,
  Übergang über einen Start hinaus (Medium eingelegt, Neu-Binden gescheitert) oder länger als 7 Tage, Fehler von
  `tpm-binden.sh` – als Karte unter Verwaltung → System bzw. auf der Übersicht des Backupservers und als Alarm-Mail (SEC-14).
- **Rettungsweg** `sudo schulosctl tpm-neu-binden` (an der Konsole, Secure Boot an, ohne Startmedium, keine Änderung unter /boot
  seit dem Start): bindet an die Werte des laufenden Starts, fragt dafür den Wiederherstellungsschlüssel ab und löscht die
  übrigen TPM2-Plätze – nach einem Start, der den Wiederherstellungsschlüssel brauchte.
- **TPM2 + PIN** (Installer-Wahl): PCR 7 + PIN (mindestens 8 Zeichen, bei jedem Start einzugeben); kein Neu-Binden nötig. Wie
  bei der Passphrase startet das Wartungsfenster dann **nicht** selbst neu (crypttab `tpm2-pin=yes`, Q5-18).
- **Bestehende Server nachrüsten:** `sudo schulosctl sicherheit-nachruesten` (an der Konsole bzw. per SSH mit Terminal) –
  erzeugt ein neues Bootmenü-Passwort und zeigt es an (bzw. `--passwort-stdin`), schreibt die Dateien, `update-grub`; bei TPM2
  ohne PIN zusätzlich Skript, Dienst und dpkg-Hook. Noch nicht gebunden: Markierung → der nächste Neustart ohne Startmedium
  bindet an 7+8+9 (Secure Boot muss an sein, sonst Hinweis). **Schon gebunden** (auch: Bootmenü-Passwort später ändern): das
  neue Bootmenü ändert PCR 8/9 – der Befehl legt deshalb nach `update-grub` den Übergangsschlüssel an (`tpm-binden.sh pruefen`,
  G4E-O01); scheitert das, sagt er es deutlich (erneut versuchen, sonst nach dem Start mit dem Wiederherstellungsschlüssel
  `tpm-neu-binden`).
  Der Backupserver hat kein `schulosctl`: `schulosctl.mjs` vom Hauptsystem (bzw. aus dem Release) hinüberkopieren und
  `sudo node schulosctl.mjs sicherheit-nachruesten` ausführen.
- **Bekannte Grenze (Q-4E-60):** Unter Secure Boot lädt die signierte GRUB der ISO keine Module nach („prohibited by secure
  boot policy“) und erkennt eine fertige Installation auf der Platte (Markierung, Spiegel) nicht – mit eingelegtem Medium startet
  dann wieder der Installer (der Überschreibschutz INST-06 verhindert das Löschen). Bis zur Lösung: nach der Installation das
  Medium entfernen bzw. in der Firmware die Platte zuerst starten (der Installer trägt sie vorn in die Startreihenfolge ein).
- **Getestet:** Dateien, Schritte und `tpm-binden.sh` (echt in bash mit Attrappen, auch „gebunden → nachrüsten → prüfen →
  Start“, Sprachdatei/ESP/shim) per Vitest; der echte Ablauf – OVMF mit Secure Boot, swtpm, erster Start bindet,
  Initramfs-Update, Neustart ohne Eingabe, neu gebunden, Nachrüsten auf dem gebundenen System mit erneutem Neustart, Überwachung
  grün – nur in der CI (`scripts/qemu-test.sh` Schritte 2b/2b'). **Nicht in QEMU:** TPM2 + PIN (PIN-Eingabe an der Konsole) und
  ein echtes shim-Update.

---

## 3. Was der Installer abfragt

### 3.1 Für beide Rollen
| Bereich | Fragen | Vorgabe |
|---|---|---|
| Sprache, Tastatur, Zeitzone | | Deutsch, de, Europe/Berlin |
| **Rolle** | Hauptsystem / Backupserver | – |
| Zielplatte | Auswahl mit Größe und Modell; beim Backupserver auch mehrere | – |
| Verschlüsselung | TPM2 (entsperrt automatisch auf dieser Hardware, PCR 7+8+9) / TPM2 + PIN (PIN bei jedem Start) / Passphrase beim Start (bei PIN und Passphrase: Neustarts nach Sicherheitsupdates nur von Hand) / aus (nur Demo). **TPM2 nur mit Secure Boot** (SEC-09, §2.3) | TPM2, falls vorhanden und Secure Boot an |
| Netzwerk | Hostname · DHCP oder statisch (IP, Maske, Gateway, DNS) · optional Proxy | DHCP |
| Systemzugang | Passwort für das Wartungskonto `schulos-admin` · SSH an/aus · optional SSH-Schlüssel | SSH aus |
| **Schulnetz-Bereiche** (SEC-01/SEC-12) | CIDR-Liste der Schulnetze und des WireGuard-Netzes – eine Einstellung für die App (2FA-Pflicht nur von außen, `SCHULOS_INTERNAL_NETS`), Caddy (Außenzugang) und SSH (nur von dort) | private Netze (10/8, 172.16/12, 192.168/16, fd00::/8); nur Abweichungen landen in der `.env` |
| Updates | Kanal stabil/beta · Wartungsfenster für App-Updates | stabil, nachts 02–04 Uhr |

### 3.2 Hauptsystem
| Bereich | Fragen | Demo | Produktiv |
|---|---|---|---|
| **Instanztyp** | Demo / Produktiv | ● | ● |
| Schule | Name · Schulnummer · Bundesland (für Feiertage und Ferien; **freigegeben nur NRW** – andere Länder mit deutlichem Hinweis) · Schulform · laufendes Schuljahr | nur Name, Rest vorbelegt (Lindenhof) | Pflicht |
| Admin-Konto | Vor- und Nachname · Benutzername · Passwort (mind. 12 Zeichen); 2FA wird beim ersten Login eingerichtet | entfällt (Demo-Konten) | Pflicht |
| Vorlagen | Fächerliste des Bundeslandes mit Fachfarben · Zeitraster (45/60 min) · **keine Personendaten** | – | optional, Vorgabe aus |
| Adresse & TLS | öffentliche Domain (Let's Encrypt) / nur Schulnetz (eigene CA) / hinter vorhandenem Proxy (+ dessen Adresse) | nur Schulnetz | Pflicht |
| Außenzugang | aus dem Internet erreichbar: nichts / nur öffentliche Seiten (Schulanmeldung) / alles – §5b; Gerätezertifikate für Personal richtet der Admin danach ein (§5c) | nichts | Vorgabe nichts |
| E-Mail (SMTP) | Server, Port, Absender, Zugang; „Testmail senden“ | entfällt | optional, für Passwort-Reset und Benachrichtigungen |
| **Backup** | Adresse des Backupservers + Kopplungscode (§4.3) · oder „später koppeln“ | „später“ | dringend empfohlen; ohne Kopplung zeigt die Verwaltung dauerhaft eine rote Warnung |

### 3.3 Backupserver
| Bereich | Fragen | Vorgabe |
|---|---|---|
| Speicher | eine Platte oder **zwei als Spiegel** (RAID 1, mdadm) | Spiegel, wenn zwei Platten vorhanden sind |
| Web-UI-Konto | Name, Benutzername, Passwort; 2FA beim ersten Login | – |
| Adresse & TLS | wie beim Hauptsystem | nur Schulnetz. Die Web-UI ist auch über die IP-Adresse oder einen anderen Namen (z. B. `rechnername.local`) erreichbar – ohne DNS-Eintrag für die Domain (Caddy `default_sni`/`fallback_sni` + Site-Adresse `https://`, INST-10; gilt ebenso fürs Hauptsystem): der Browser zeigt dann das Zertifikat der Domain und warnt wegen des Namens, die Verbindung bleibt verschlüsselt. Anmelden mit Passkey geht nur unter der Domain. |
| Aufbewahrung | täglich / wöchentlich / monatlich | 14 / 4 / 3 (älteste Sicherung ≈ 3 Monate; mehr nur mit Begründung, siehe DATENSCHUTZ.md §3.3/§3.5) |
| Offsite-Kopie | aus / SFTP (z. B. Hetzner Storage Box) / S3 | aus, später in der Web-UI |
| E-Mail-Alarm | SMTP + Empfänger für „Backup überfällig“ | optional |

### 3.4 Demo oder Produktiv
| | Demo | Produktiv |
|---|---|---|
| Daten nach der Installation | Demo-Schule „Gesamtschule am Lindenhof“ (631 fiktive Konten) | **komplett leer**: nur das Admin-Konto und die Schuleinstellungen, auf Wunsch Fächer- und Zeitraster-Vorlagen |
| Demo-Schnell-Login | an | technisch ausgeschlossen |
| Kennzeichnung | dauerhaftes Band „DEMO – keine echten Daten eingeben“ | – |
| Umwandeln | **Demo → Produktiv geht nicht.** Eine Produktivinstanz entsteht immer leer. So landen nie echte Daten neben Demo-Konten oder Demo-Passwörtern | – |
| Zurücksetzen | `schulosctl demo-reset` (z. B. nächtlich für eine Vorführinstanz) | – |

Technisch: Der Installer schreibt `instance.type = demo | production` in die Konfiguration.
Beim ersten Start legt die App entweder per Seed die Demo-Schule an oder nur das Admin-Konto.
Das Passwort wird gleich als scrypt-Hash gespeichert, die Klartext-Antworten des Installers
werden danach gelöscht. Der bestehende Schutz (Demo-Login nur bei Demo-DB) bleibt zusätzlich.

---

## 4. Backupserver „SchulOS Backup“

### 4.1 Architektur
```
 Hauptsystem                                   Backupserver
┌──────────────────────────┐   HTTPS (Pinning) ┌───────────────────────────────────┐
│ backup-agent             │ ────────────────▶ │ rest-server (restic, append-only) │
│  · holt Zeitplan + Regeln│ ◀──────────────── │ schulos-backup (Web-UI + API)     │
│  · pg_dump + files/      │   Konfiguration,  │  · Zeitpläne, Aufbewahrung, Prune │
│  · restic backup (push)  │   Restore-Aufträge│  · restic check, Test-Restore     │
│  · meldet Ergebnis       │                   │  · Offsite-Kopie (restic copy)    │
└──────────────────────────┘                   │  · E-Mail-Alarm                   │
                                               └───────────────────────────────────┘
```

- **Gesteuert wird alles vom Backupserver aus**, wie gewünscht. Der Agent auf dem Hauptsystem
  holt sich Zeitplan und Regeln regelmäßig ab und führt sie aus. Er braucht keine eigene
  Oberfläche, die Verwaltung im Hauptsystem zeigt nur den Status an.
- **Append-only:** Das Hauptsystem darf Sicherungen nur hinzufügen, nie löschen. Gelöscht wird
  ausschließlich auf dem Backupserver. Damit kann auch ein kompromittiertes Hauptsystem die
  Backups nicht vernichten (Schutz vor Ransomware).
- Ein Backupserver kann **mehrere Hauptsysteme** sichern, z. B. ein Schulträger mit mehreren
  Schulen. Jede Instanz bekommt ein eigenes restic-Repository mit eigenem Zugang.
- Technik: `restic rest-server` (BSD-2) als Speicher, die Web-UI als eigene kleine Next.js-App
  mit denselben UI-Bausteinen wie SchulOS. Das Repo wird dafür auf npm-Workspaces umgestellt:
  SchulOS bleibt im Repo-Root, dazu `apps/backup` und `packages/ui` (Entscheidung 2026-10-04).

**Backup-Agent (umgesetzt in B-24, `apps/agent`):** eigener Container im Haupt-Stack (Node 24, restic 0.19.1, `pg_dump` 18,
uid 1000 wie die App), Volumes `config` (rw – liest `backup-pairing.json`, schreibt `backup-agent-state.json`) und `files` (ro),
`DATABASE_URL` wie die App. Jede Minute holt er den Plan (`GET /api/agent/plan`, Agent-Token, TLS gepinnt): Uhrzeiten (Vorgabe 01:30,
verpasste Termine werden bis 12 h nachgeholt) und „Jetzt sichern“. Ein Lauf = ein Snapshot mit Datenbank-Dump (`pg_dump -Fc`),
`files/` und `config/`; Ergebnis per `POST /api/agent/report` (nur Kennzahlen, keine Inhalte). Beim ersten Lauf legt er das Repository
an und trägt den **Wiederherstellungsschlüssel als zweiten restic-Schlüssel** ein. Zugangsdaten nur über die Umgebung der Kindprozesse.
Live geprüft: Snapshot enthält Dump + Dateien + Konfiguration, der Wiederherstellungsschlüssel öffnet das Repository, `forget` mit dem
Agent-Zugang scheitert (append-only), der Dump lässt sich mit `pg_restore` lesen. Der rest-server liest seine `.htpasswd` nur etwa
alle 30 s neu und bemerkt eine per `rename` ersetzte Datei gar nicht – die Backup-App schreibt sie deshalb in place, der Agent wartet
beim ersten Zugriff ein 401 bis zu einer Minute ab.

### 4.2 Web-UI
| Bereich | Inhalt |
|---|---|
| **Übersicht** | Ampel je gekoppelter Instanz: letztes Backup, Dauer, Größe, letzter Test-Restore, Offsite-Stand |
| Instanzen | koppeln (Kopplungscode erzeugen), entkoppeln, umbenennen |
| Zeitplan | Uhrzeit(en) je Instanz; zusätzlich automatisch vor jedem App-Update |
| Aufbewahrung | täglich/wöchentlich/monatlich, Vorschau „so viele Stände bleiben“. Die längste Stufe bestimmt, wann gelöschte Daten auch aus den Backups verschwinden. Die UI zeigt das ausdrücklich an und warnt oberhalb von 3 Monaten (DATENSCHUTZ.md §3.3/§3.5) |
| Snapshots | Liste je Instanz · **„Auf Hauptsystem wiederherstellen“** (ganz oder nur Dateien) · Download nur verschlüsselt |
| Prüfungen | wöchentlich `restic check`; monatlich **Test-Restore**: Snapshot in einen Wegwerf-Postgres einspielen, das SchulOS-Image dagegen starten, `/api/health` und Zählung der Tabellen prüfen |
| Offsite | Ziel einrichten, Zeitplan, Stand der letzten Kopie |
| Benachrichtigung | E-Mail bei „überfällig“ (z. B. > 26 h), fehlgeschlagener Prüfung, knappem Platz |
| Konten & Protokoll | Benutzer mit 2FA, Audit-Log aller Restores und Konfigurationsänderungen |

**Umgesetzt in B-25:** Seite *Instanzen → Detail* mit Zeitplan (1–4 Uhrzeiten), Aufbewahrung mit Live-Vorschau („höchstens 21 Stände,
älteste ≈ 3 Monate“) und Pflicht-Begründung über 3 Monate (im Protokoll), Sicherungsstände (`restic snapshots`) und Wartungsprotokoll.
**Aufräumen** (`forget --prune` mit der Aufbewahrung) läuft täglich um `SCHULOS_PRUNE_TIME` (Vorgabe 14:00, weit weg vom Sicherungstermin)
**lokal** auf dem Repository-Ordner – nur hier wird gelöscht. Dafür muss der rest-server als **uid 1000** laufen (gleicher Benutzer wie die
Backup-App), sonst gehören die Repository-Dateien root (live geprüft). Gleichzeitige Läufe regeln die restic-Sperren (`--retry-lock` auf
beiden Seiten). *Konten*: weitere Admins mit Startpasswort (Pflicht-Wechsel, dann Pflicht-2FA), sperren, Zwei-Faktor und Passwort
zurücksetzen – nie am eigenen Konto, das letzte aktive Konto lässt sich nicht sperren.

**Umgesetzt in B-26 (Prüfungen):** wöchentlich `restic check --read-data-subset=5%` (Struktur + zufällige Datenstichprobe – über Wochen
wird alles gelesen), monatlich **Test-Restore auf DB-Ebene**: neuester Stand → nur der Datenbank-Dump wird zurückgeholt (`restore --verify`),
`pg_restore --list` muss ihn lesen (und darf nur Arten des SchulOS-Schemas enthalten, SEC-06), mit `SCHULOS_RESTORE_TEST_DB` (Test-Postgres
als Sidecar, kein Docker-Socket) wird er in eine Wegwerf-Datenbank eingespielt – mit einer Wegwerf-Rolle ohne Superuser-Recht, die nur
Eigentümerin dieser Datenbank ist (SEC-06: der Dump kommt vom Hauptsystem) – und geprüft (Tabellen, Drizzle-Migrationsstand, Konten); danach wird alles gelöscht. Ergebnis nur als Kennzahlen
im Wartungsprotokoll. Zeiten: `SCHULOS_CHECK_TIME` (15:00), `SCHULOS_RESTORE_TEST_TIME` (16:00). Das ganze Dateiverzeichnis zurückzuholen
wäre monatlich unverhältnismäßig (Hunderte GB) – dafür sorgt die Datenstichprobe. Den Start des SchulOS-Images gegen den Restore ergänzt OPS-3.
Live geprüft (Docker): Aufräumen, Prüfung und Test-Restore laufen zur eingestellten Zeit, Kennzahlen stimmen mit der Quelle überein, die
Wegwerf-Datenbank ist danach weg.

### 4.3 Kopplung
1. Der Backupserver erzeugt in der Web-UI (oder direkt am Ende seiner Installation) einen
   **Kopplungscode**, z. B. `K7Q2-9MXA-4RT1`. Der Code ist 24 Stunden gültig und nur einmal
   verwendbar.
2. Das Hauptsystem bekommt im Installer (oder später in der Verwaltung) die Adresse des
   Backupservers und den Code.
3. Der Austausch läuft über TLS (umgesetzt in B-23, `packages/server/src/pairing*.ts`). **Der Code geht nie übers Netz:**
   aus ihm entstehen ein Suchschlüssel (SHA-256) und ein AES-256-GCM-Schlüssel (HKDF).
   - **hello** – TLS noch ungeprüft: das Hauptsystem schickt nur den Suchschlüssel, der Backupserver antwortet mit seiner
     CA (Caddy `tls internal`, `SCHULOS_TLS_CA_FILE`) bzw. „öffentliches Zertifikat“ – verschlüsselt mit dem Code. Wer den
     Code nicht kennt, kann die Antwort weder lesen noch fälschen.
   - **claim** – nur noch über TLS mit dieser CA (**Pinning der CA**, nicht des Blattzertifikats: Caddys interne Zertifikate
     wechseln alle 12 h) bzw. mit dem System-Truststore. Passt das Zertifikat nicht, bricht die Kopplung ab, der Code bleibt
     unverbraucht. Anfrage und Antwort sind ebenfalls mit dem Code verschlüsselt (Name, Repo-Passwort ↔ rest-server-Zugang,
     Agent-Token, Repository-Adresse).
   - Der Backupserver speichert vom Code nur Suchschlüssel und verschlüsselten Code-Schlüssel, verbraucht ihn atomar (einmalig)
     und trägt den Zugang als bcrypt-Eintrag in die `.htpasswd` des rest-servers ein (`--append-only --private-repos`; der
     rest-server liest die Datei nach Änderungen selbst neu – kein Docker-Socket nötig). Entkoppeln entfernt den Eintrag,
     das Repository bleibt.
   - Geht die Antwort auf „claim“ verloren (Verbindung bricht ab), liefert derselbe Code noch **15 Minuten** lang dasselbe
     Ergebnis (gleiche Instanz und Zugangsdaten, nur mit dem Code verschlüsselt; Protokoll „kopplung.wiederholt“). Dafür liegt die
     Antwort so lange mit dem App-Geheimnis verschlüsselt beim Code und wird danach gelöscht. Eine inzwischen entkoppelte Instanz
     lebt dabei nicht wieder auf.
   - Das Hauptsystem legt die Zugangsdaten in `<Konfiguration>/backup-pairing.json` ab (0600) – dort liest sie auch der
     Backup-Agent; die Oberfläche zeigt sie nie an.
4. Der **Repository-Schlüssel** entsteht auf dem Hauptsystem. Der Backupserver bekommt eine
   Kopie, weil er für Aufräumen (Prune), Prüfung und Test-Restore entschlüsseln muss.
   Zusätzlich gibt es einen **Wiederherstellungsschlüssel**, der einmal angezeigt und bestätigt
   wird („ausgedruckt und sicher verwahrt“). Damit lassen sich die Daten auch dann retten, wenn
   beide Server verloren sind und nur die Offsite-Kopie übrig ist.

### 4.3a Unveränderliche Offsite-Kopie (SEC-11, Ransomware)

Die Offsite-Kopie (B-37) schreibt der Backupserver selbst – und räumt dort auch auf. Wer Hauptsystem **und** Backupserver
übernimmt, könnte sie löschen. Unveränderlich wird sie erst durch das Ziel: **Schnappschüsse, die nur der Anbieter anlegt und
löscht**. SchulOS baut keinen zweiten Kopiermechanismus, sondern prüft täglich (Vorgabe 18:00, nach der Offsite-Kopie), ob der
neueste Schnappschuss die Kopie jeder Instanz enthält und höchstens 48 h alt ist.

- **Hetzner Storage Box (empfohlen, prüfbar):** in der Konsole des Anbieters **automatische Schnappschüsse** einschalten
  (täglich, z. B. 14 behalten) und „ZFS-Ordner sichtbar“ – die Schnappschüsse liegen dann **nur lesbar** unter `.zfs/snapshot`.
  Über SFTP (das Konto, das der Backupserver nutzt) lassen sie sich weder ändern noch löschen; das kann nur das Konto beim
  Anbieter – **mit eigenem Passwort und 2FA, nirgends auf den Servern hinterlegt**. Dann in `backup.env`:
  `SCHULOS_OFFSITE_SNAPSHOTS=offsite:.zfs/snapshot` (gleicher rclone-Remote wie `SCHULOS_OFFSITE`, Pfad der Schnappschüsse),
  optional `SCHULOS_OFFSITE_SNAPSHOT_MAX_HOURS` (Vorgabe 48) und `SCHULOS_OFFSITE_SNAPSHOT_TIME` (Vorgabe 18:00).
- **S3 mit Object Lock** (Compliance-Modus, Standard-Aufbewahrung ≥ 30 Tage, Versionierung an; Zugangsschlüssel ohne Recht,
  die Sperre zu ändern): ebenfalls unveränderlich, von SchulOS aber **nicht automatisch prüfbar** – Verwaltung → System zeigt dann
  „nicht eingerichtet“. Gegebenenfalls von Hand prüfen.
- **Anzeige und Alarm:** Der Backupserver führt die Prüfung als Wartungslauf „Unveränderliche Kopie“ (Instanzseite, Alarm-Mail
  bei Fehlschlag oder zu altem Stand). Das Hauptsystem bekommt das Ergebnis mit dem Plan des Agenten und zeigt unter
  Verwaltung → System → Backup „Unveränderliche Kopie: vorhanden/veraltet/fehlt/nicht eingerichtet“ mit Datum (SEC-14: Alarm-Mail
  auch vom Hauptsystem).
- **Wiederherstellen aus einem Schnappschuss** (beide Server verloren *und* die Offsite-Kopie gelöscht): Installer „aus der
  Offsite-Kopie wiederherstellen“ mit dem Pfad des Schnappschusses als Ziel, z. B. `offsite:.zfs/snapshot/<datum>/schulos`, und
  dem Wiederherstellungsschlüssel.
- **Was geprüft wird (G4E-O07):** nicht nur, dass die Datei `config` im Schnappschuss liegt, sondern dass sich die Sicherungsstände
  dort mit dem Repository-Passwort entschlüsseln lassen (`restic snapshots --no-lock` direkt im nur lesbaren Schnappschuss),
  mindestens ein Stand da ist und die Pack-Daten gegenüber der letzten guten Prüfung nicht unter die Hälfte geschrumpft sind.
  Ob **jedes** Pack noch lesbar ist, prüft das nicht (dafür wäre ein voller `restic check --read-data` über das Netz nötig) – im
  Zweifel von Hand einen Schnappschuss wiederherstellen (unten). Ein übernommener Backupserver kann seine Meldung an das
  Hauptsystem fälschen (bauartbedingt) – die Anbieter-Schnappschüsse selbst kann er nicht ändern.
- **Haltedauer beim Anbieter länger als die Zeit bis zur Entdeckung:** Verschlüsselt oder löscht ein Angreifer die Offsite-Kopie,
  enthalten nur die Schnappschüsse von **davor** noch saubere Stände. Die Haltedauer (z. B. 14 Tage) muss deshalb länger sein,
  als es dauern kann, bis jemand den Alarm sieht und handelt – im Zweifel länger wählen.
- **Aufbewahrung:** Schnappschüsse verlängern, wie lange Gelöschtes in Sicherungen existiert, um ihre Haltedauer (DATENSCHUTZ.md §3.5).

### 4.4 Wiederherstellung
| Fall | Weg |
|---|---|
| Einzelne Dateien oder Ordner versehentlich gelöscht | Web-UI → Snapshot → Dateien → „auf Hauptsystem wiederherstellen“ |
| Hauptsystem defekt, Hardware neu | ISO auf neuer Hardware → Rolle Hauptsystem → **„aus Backup wiederherstellen“** statt Demo/Produktiv → Backupserver + Kopplungscode → letzter Stand ist wieder da |
| Beide Server verloren | ISO → Hauptsystem → „aus Offsite-Kopie wiederherstellen“ mit Wiederherstellungsschlüssel |

Jede Wiederherstellung auf dem Hauptsystem muss **dort** zusätzlich bestätigt werden (Code im
Admin-Bereich). Die Bestätigung ist auf dem Hauptsystem verankert (SEC-06): Bei der Code-Eingabe legt die App eine
Freigabe für genau diesen Auftrag, Stand und Umfang in ihren Konfigurationsordner (30 Minuten gültig, einmal verwendbar),
und der Agent führt nur damit aus – ein „bestätigt“, das allein vom Backupserver kommt, reicht nicht. Ein übernommener
Backupserver kann so ohne die Admin des Hauptsystems nichts zurückspielen. **Grenze:** Bestätigt die Admin einen Auftrag,
spielt der Agent den Inhalt dieses Stands ein – der kommt vom Backupserver. Das Inhaltsverzeichnis des Dumps wird geprüft
(nur Arten des SchulOS-Schemas), eingespielt wird mit der App-Rolle `schulos` – seit SEC-07 ohne Superuser-Recht, sie kann also
nur die SchulOS-Daten ändern, nicht aus der Datenbank ausbrechen. Vor einer Wiederherstellung trotzdem prüfen, ob der
Backupserver vertrauenswürdig ist.

---

**Umgesetzt in B-27:**
- *Auftrag* auf dem Backupserver (Instanz → „Auf Hauptsystem wiederherstellen“): Stand + Umfang, 6-stelliger Bestätigungscode wird dort einmal
  angezeigt. Der Agent liefert den Auftrag mit dem Plan aus, **Verwaltung → Backup** im Hauptsystem zeigt ihn – erst mit dem Code
  (bzw. „Ablehnen“) geht es weiter; nach 5 falschen Codes ist der Auftrag verworfen.
- *Freigabe (SEC-06)*: Der Agent übernimmt nur Aufträge mit voller Snapshot-ID (64 Hex-Zeichen, an restic immer nach `--`) und bekanntem
  Umfang und führt einen „bestätigten“ Auftrag nur mit passender `restore-approval.json` im Konfigurationsordner aus (schreibt die App bei
  der Code-Eingabe, löscht sie bei falschem Code/Ablehnung; der Agent löscht sie vor dem Start). Vor jedem `pg_restore` prüft er das
  Inhaltsverzeichnis (`pg_restore --list`): Funktionen, Sprachen, Trigger, Sichten, fremde Erweiterungen u. Ä. → Abbruch;
  `pg_stat_statements` und Rechte werden übersprungen (`--use-list`).
- *komplett*: Sicherung des aktuellen Stands → `maintenance.json` im Konfigurationsordner (die App antwortet mit 503, Healthcheck bleibt) →
  `pg_restore --clean --if-exists --single-transaction` → Dateien genau wie im Stand (`restore --overwrite always --delete`) → Phase
  „neustart“: die App beendet sich, Docker startet sie neu (`restart: unless-stopped`), die Migrationen laufen auf der eingespielten DB.
  Auch nach einem Fehler gibt es den Neustart statt dauerhafter Wartung – der Stand von vorher liegt als eigene Sicherung vor.
- *nur Dateien*: `--overwrite never` – fehlende Dateien kommen zurück, vorhandene bleiben unverändert, kein Wartungsmodus.
- *Neue Hardware*: Backupserver → Instanz → „Ersatz-Kopplungscode“. Das neue Hauptsystem koppelt damit an **dieselbe** Instanz: neue
  rest-server-Zugangsdaten und neuer Agent-Token (die alten werden ungültig), dazu das **bestehende Repository-Passwort**; der
  Wiederherstellungsschlüssel steckt schon im Repository. Danach – vor dem ersten Start der App – `node agent.mjs wiederherstellen`:
  neuester Stand → Datenbank, Dateien und `secret.env` (mit dem alten Geheimnis sind die Zwei-Faktor-Geheimnisse verschlüsselt).
- Live geprüft (Docker): komplett (Datenbank und Dateien exakt wie im gewählten Stand, Wartungsdatei → neustart), nur Dateien (Fehlendes
  zurück, lokal Geändertes bleibt), neue Hardware (leere DB/Volumes → alles zurück, alter Agent-Token 401). Auch hier wartet der Agent beim
  ersten Zugriff ein 401 ab (rest-server liest die .htpasswd nur alle ~30 s).
- Für die Stacks (B-28): Agent braucht `files` **schreibend**, App `restart: unless-stopped`, Backupserver einen Test-Postgres-Sidecar.

## 5. Hauptsystem im Betrieb

- Compose-Stack: `caddy` (TLS, Reverse Proxy, SSE mit `flush_interval -1`) · `schulos-app`
  (Next.js standalone, Node 24 LTS, Nicht-Root, Migrationen beim Start, Jobs wie der Löschlauf im
  Prozess) · `postgres:18` · `backup-agent` · optional `clamav`
- **Virenscan (P4-72, optional, Vorgabe aus):** ClamAV (GPL-2.0, eigener Container – SchulOS spricht nur das Netzprotokoll von
  clamd, kein gemeinsamer Code) als Compose-Profil: in `.env` `SCHULOS_CLAMAV=clamav:3310`, dann
  `docker compose --profile clamav up -d`. Beim ersten Start lädt `freshclam` die Signaturen (~300 MB, Internet), danach
  regelmäßig neu; clamd braucht rund 1,5 GB RAM mehr. Geprüft wird vor dem Speichern: **Dateien, Aufgaben (Material und
  Abgaben), Gebäude-Fotos, Prüfprotokolle**. Fund → Meldung am Formular („enthält Schadsoftware … nicht gespeichert“), nichts
  landet im Speicher. Ist ClamAV eingeschaltet, aber nicht erreichbar, werden Uploads **abgelehnt** (streng, Q-4E-57) –
  Verwaltung → System → „Virenscan“ zeigt aktiv (mit Signaturstand) / nicht erreichbar / aus. Keine Daten verlassen den Server
  (nur der Download der Signaturen). Test: `node cli.mjs virenscan-pruefen` (EICAR-Testdatei, CI-Job `stack`).
- **Angriffserkennung (SEC-15, optional, Vorgabe aus):** CrowdSec (Engine MIT, Szenarien aus dem Hub MIT) als Compose-Profil
  `crowdsec`: in `.env` `SCHULOS_CROWDSEC=1`, `SCHULOS_CROWDSEC_URL=http://crowdsec:8080`, `SCHULOS_CROWDSEC_BOUNCER_KEY=<lang,
  zufällig>`, dann `docker compose --profile crowdsec up -d`. Caddy schreibt dann ein Zugriffsprotokoll (JSON, höchstens 48 h),
  CrowdSec erkennt darin Angriffsmuster (Szenarien für Caddy/HTTP, beim ersten Start aus dem Internet geladen) und entscheidet
  über befristete Sperren; **die App setzt sie durch** (`src/core/crowdsec.ts`: Zwischenspeicher, alle 10 s über die lokale API
  abgeglichen, Antwort 403 „Sicherheitsfilter“) – kein eigenes Caddy-Image nötig. Fällt CrowdSec aus, gelten die Sperren bis
  zum Ablauf weiter, sonst bleibt alles erreichbar. Status unter Verwaltung → System („Angriffserkennung“). **Datenschutz/Lizenz
  (geprüft):** Engine und Szenarien MIT (AGPL-verträglich, eigener Container); die **Online-API ist aus** (`DISABLE_ONLINE_API`),
  also weder Weitergabe auffälliger Adressen an die Community-Liste noch deren Sperrliste. Einschalten nur nach Prüfung durch die
  bzw. den DSB (Übermittlung von IP-Adressen an CrowdSec SAS, Frankreich) – DATENSCHUTZ.md §6. Der Virenscan (P4-72) ist
  davon unabhängig. Test: Sperre per `cscli decisions add` → 403 (CI-Job `stack`).
- Daten unter `/srv/schulos/{db,files,config}`
- **Domainwechsel (Q-4E-13):** Sicherheitsschlüssel/Passkeys sind an die Adresse gebunden (`BETTER_AUTH_URL`, aus `SCHULOS_DOMAIN`).
  Wer die Domain ändert, macht **alle** registrierten Passkeys ungültig – alle müssen ihren zweiten Faktor danach neu einrichten
  (Code-App bzw. Wiederherstellungscodes bleiben gültig). Domain daher vor dem Echtbetrieb festlegen.
- **Container-Härtung (SEC-13):** alle Dienste mit nur lesbarem Image-Dateisystem (`read_only`, beschreibbar nur Volumes
  und `/tmp`; Ausnahme Dienste mit Compose-`configs` – Caddy, PostgreSQL, step-ca, CrowdSec –: Compose kopiert den Inhalt beim
  Anlegen in den Container, das scheitert an einem nur lesbaren Dateisystem), ohne Linux-Capabilities (`cap_drop: [ALL]`), mit `no-new-privileges`, keiner mit `docker.sock`. App, Backup-Agent,
  Backup-App laufen als `node`, PostgreSQL direkt als `postgres` (Socket im tmpfs), step-ca als `step`, rest-server als 1000.
  **Ausnahmen** (in den Compose-Dateien begründet): Caddy bleibt root – seine Volumes gehören in bestehenden Installationen root –,
  hat aber nur `NET_BIND_SERVICE`; `geraete-ca-init` läuft einmal als root mit nur `CHOWN`, ohne Netz. Backup-Agent und
  Backup-App haben `/tmp` als Volume (`agent_tmp` bzw. `backup_tmp`: Datenbank-Dump, Test-Restore, restic-Cache) statt im
  Speicher. Kommt per `schulosctl update` (neue `compose.yaml`) auch auf bestehende Server. Geprüft am laufenden Stack
  (`scripts/haertung-pruefen.sh`, CI-Jobs `stack`/`backup`) und statisch (`compose-haertung.test.ts`).
- **Updates:** Betriebssystem und SchulOS werden getrennt aktualisiert, beides mit Sicherung
  vorher und Rückweg danach – Details in §5a.
- `schulosctl`: `status` · `update` · `rollback` · `backup now` · `reset-admin` · `schulnetz-zuruecksetzen` · `ssh-netze` ·
  `demo-reset` · `support-bundle` (Logs **ohne Personendaten**) · `sicherheit-nachruesten` · `tpm-neu-binden` (§2.3)
  - Stand B-31: `apps/ctl`, gebündelt zu einer Datei `schulosctl.mjs` (Node 24 auf dem Host, keine Abhängigkeiten),
    steuert den Stack im Installationsordner (`--dir`, `SCHULOS_DIR`, Vorgabe `/opt/schulos`) über `docker compose`.
    Im App-Container gibt es dafür `node cli.mjs info | reset-admin [name] | demo-reset` (`src/cli.ts`, Logik in
    `src/core/ops.ts`); `backup now` ruft `agent.mjs sichern` im Agent-Container (verweigert Doppelläufe, pflegt den
    Zustand). `reset-admin`: neues Zufallspasswort (beim Anmelden zu ändern), zweiter Faktor aus, Konto aktiv,
    Anmeldesperre weg, Sitzungen beendet, Eintrag im Audit-Log; setzt auch die Schulnetz-Bereiche der Anmeldung auf die Vorgabe.
    `schulnetz-zuruecksetzen` (Q-4E-42): nur die Schulnetz-Bereiche (Verwaltung → System → Anmeldung) auf die Vorgabe
    zurück, ohne Passwort/2FA anzufassen – der Ausweg, wenn eine falsche Liste alle „nach außen“ verlegt und damit z. B.
    die 2FA-Pflicht oder Sperren für die Verwaltung auslöst (ruft `node cli.mjs schulnetz-zuruecksetzen` im App-Container).
    **SSH bleibt davon unberührt** (G4E-O17): Firewall-Regel und sshd folgen der App-Einstellung nicht automatisch.
    `ssh-netze [<netz>…] [--yes]` zeigt bzw. setzt die SSH-Netze (`/etc/schulos/ssh-netz.nft` und `AllowUsers` in
    `/etc/ssh/sshd_config.d/schulos.conf`): Netze streng geprüft (Host-Bits wie `10.10.0.5/24` → Fehler mit Vorschlag
    `10.10.0.0/24`, G4E-O06), Regel vorher mit `nft -c`, sshd mit `sshd -t` geprüft, dann ohne Neustart von sshd geladen
    (`nft -f`, sshd nur `reload`); lauscht sshd danach nicht wieder auf Port 22, kommt der alte Stand zurück. Ältere Installationen bekommen dabei Dienst
    und Bindung von `ssh.service` an die Regel nachgezogen; läge die eigene SSH-Sitzung danach außerhalb, nur mit `--yes`.
    Wer die Schulnetz-Bereiche unter Verwaltung → System ändert, zieht SSH hier nach.
    `demo-reset`: nur Demo; App stoppen, Tabellen leeren,
    Demo-Schule neu, Dateien leeren, App starten. `support-bundle`: `.tar.gz` mit Status, Versionen, Konfiguration
    (Geheimnisse/Schulangaben `***`) und Logs, geschwärzt (E-Mail, IP, „Namen“, Token, Zufallswerte)
  - Stand B-32: `update [--check] [--yes] [--kanal] [--quelle <ordner>]` nach §5a.2/§5a.3 – Manifeste aus GitHub (privates
    Repo: `SCHULOS_GITHUB_TOKEN`; Images aus GHCR brauchen dann `docker login ghcr.io`) oder einem Ordner, Signatur gegen
    den eingebackenen `release/cosign.pub`, Weg mit Zwischenversionen, Patch ohne, Minor/Major mit Freigabe; je Schritt
    Backup → Probelauf (Datenbank `schulos_probelauf` im selben Postgres, App-Container nur im internen Netz, Version,
    Rauchtest mit technischem Konto, Löschnachweis) → Dump → Images per Digest in `.env` → Healthcheck → bei Fehler alte
    `.env` + `pg_restore` des Dumps. Protokoll `updates/protokoll.jsonl`. `test-restore`: dieselbe Wegwerf-Instanz mit dem
    neuesten Stand vom Backupserver (Agent `probe-einspielen`) und der laufenden Version – ergänzt die monatliche
    DB-Prüfung des Backupservers um den App-Start (B-26). SEC-06: Weil dieser Stand ungeprüft vom Backupserver kommt, gehört die
    Prüfdatenbank beim Test-Restore (auch vor `os-upgrade`) einer Wegwerf-Rolle `schulos_probelauf` ohne Superuser-Recht
    (je Lauf neues Passwort, am Ende samt Datenbank gelöscht und nachgewiesen); Agent und Prüf-App nutzen nur deren Zugang
    (`SCHULOS_PROBE_DATABASE_URL`), das Inhaltsverzeichnis des Dumps wird vorher geprüft. Der Probelauf vor Updates kopiert die
    eigene Datenbank und bleibt bei der App-Rolle
  - Stand SEC-07: **Datenbankrollen.** Die App (und der Backup-Agent) melden sich als `schulos` an – Eigentümerin der Datenbank
    `schulos`, aber `NOSUPERUSER NOCREATEROLE NOCREATEDB`. Superuser ist nur die Wartungsrolle `postgres` (`POSTGRES_USER` in
    `compose.yaml`, Passwort `POSTGRES_ADMIN_PASSWORD` in `.env`); `schulosctl` nutzt sie über den Socket im Container für
    Prüfdatenbank, Wegwerf-Rolle und Statistik. Neue Installationen: das Init-Skript `configs: postgres-init` legt `schulos` beim
    ersten Start an und richtet `pg_stat_statements` ein. Dumps für Probelauf und Rückweg macht `schulosctl` als `schulos` ohne
    `pg_stat_statements` (`--exclude-extension`), der Rückweg spielt sie ebenso als `schulos` ein.
    **Bestehende Installationen** (bis v0.3.x war `schulos` selbst der Superuser – die Bootstrap-Rolle, der Postgres das Recht
    nicht entziehen kann): `schulosctl update` (auch im Wartungsfenster und per Verwaltung → System) stellt vor dem Plan einmalig
    um, von Hand `schulosctl db-rolle`. Ablauf: `POSTGRES_ADMIN_PASSWORD` fehlt → zufällig erzeugen und in `.env` schreiben;
    App und Agent anhalten; eine Hilfsrolle `schulos_sec07` benennt in einer Transaktion `schulos` → `postgres` um (Passwort aus
    `.env`, an den Server nur als SCRAM-Verifier), legt `schulos` neu ohne Superuser-Recht an – mit dem gespeicherten
    Passwort-Verifier der alten Rolle (GATE-031: nicht aus `.env` gelesen, die Compose anders interpretieren könnte) – und überträgt Datenbank, Schemas,
    Tabellen, Sequenzen, Typen und Funktionen (Erweiterungen bleiben bei `postgres`; bleibt etwas übrig, wird alles
    zurückgenommen); Hilfsrolle löschen, Stack starten. Jeder weitere Lauf prüft nur `pg_roles` und ändert nichts („nichts zu
    tun“); hat `schulos` später wieder Superuser-Recht, wird es entzogen. Protokollschritt `db-rolle`. Die Umstellung braucht
    die neue `compose.yaml` nicht (dort steht bei alten Servern weiter `POSTGRES_USER: schulos` – zählt nur beim allerersten
    Start). **Wichtig (GATE-031):** Das kann nur ein `schulosctl` ab v0.3.2 – Server mit v0.3.1 und älter brauchen einmal das
    neue `schulosctl` von Hand, siehe §5a.2 „Umstellung älterer Installationen“. Rollen-Sitzungen laufen mit
    `pg_stat_statements.track = none` und festem `search_path`; Superuser-Abfragen in der Datenbank `schulos` von Hand nur mit
    `docker compose exec -e PGOPTIONS='-c search_path=pg_catalog,pg_temp' postgres psql -U postgres -d schulos` (die App-Rolle
    ist dort Eigentümerin und könnte sonst eigene Funktionen vor die eingebauten schieben).
    **Rückweg:** Ältere SchulOS-Versionen laufen auch mit der neuen Rolle (gleiches Passwort, gleiche Eigentümerin) – ein
    Update-Rückweg braucht nichts davon. Nur im Notfall das Superuser-Recht zurückgeben:
    `docker compose exec postgres psql -U postgres -c "alter role schulos superuser"` (wird beim nächsten `update` wieder
    entzogen). Die Umbenennung selbst bleibt; `POSTGRES_ADMIN_PASSWORD` nicht aus `.env` löschen
  - Stand B-33/B-34: systemd-Units in `deploy/systemd/` – `schulos-sync.timer` (alle 5 min `schulosctl system-sync`: Auftrag aus
    Verwaltung → System ausführen, Status für die App schreiben) und `schulos-wartung.timer` (02:30–03:00 `schulosctl wartungsfenster`:
    Patches automatisch, Funktions-Updates nur mit Freigabe für genau die verfügbare Version, immer mit Sicherung + Probelauf).
    Neue Module eines Updates kommen beim Serverstart ausgeschaltet (`syncModules`, bekannte Module in `modules.known`),
    ihre Standardrechte werden angelegt
  - Stand B-35: Vorschau-Instanz `compose.vorschau.yaml` (Projekt `schulos-vorschau`, Demo-Schule auf PGlite, Band „VORSCHAU auf
    SchulOS x“, ohne Jobs, 1 GB RAM, nur im Netz `edge` des Haupt-Caddy). `schulosctl vorschau an [--domain]` setzt Image (neuestes
    Release im Kanal beta, sonst die laufende Version) und Adresse (Vorgabe `vorschau.<Domain>`) und legt die Caddy-Site in das
    Volume `caddy_sites` (GATE-4c: Site nur fürs Schulnetz – `@extern not client_ip {$SCHULOS_INTERNAL_NETS}` → 403, mitgeschickte
    `X-SchulOS-*` verworfen; `--extern` öffnet sie und kennzeichnet wie Modus „alles“) (Haupt-Caddyfile: `import /etc/caddy/sites/*.caddy`); `aus` entfernt Site und Projekt samt Demo-Daten;
    `schulos-vorschau.timer` 04:15 `vorschau nacht` = aktualisieren + Demo-Reset (nur wenn an)
  - Stand B-36: Offline-Bundle `schulosctl bundle create <version…> [--out] [--quelle]` (Rechner mit Internet: release.json + .sig
    unverändert, App/Backup/Agent + caddy/postgres/rest-server per Digest mit `docker save` in eine .tar) und `bundle import <datei>`
    (Server: erst alle Signaturen prüfen, dann `images.tar` prüfen – `index.json`/`manifest.json`/`repositories` dürfen nur die
    signierten Digests und keine fremden Namen enthalten, sonst würde `docker load` z. B. `postgres:18` umbiegen (SEC-06) –, dann
    `docker load`; nur Images, deren geladene ID genau dem signierten Digest entspricht, werden benannt, damit `name@digest` offline
    auflösbar ist; Releases nach `updates/offline`, `SCHULOS_UPDATE_SOURCE` in `.env`).
    **Voraussetzung: Docker mit containerd-Image-Speicher** (Image-ID = Manifest-Digest; Docker ≥ 29 Standard, sonst
    `"features": {"containerd-snapshotter": true}` in `/etc/docker/daemon.json`) – der Installer (B-42) stellt das ein.
    Updates laden Images nur noch, wenn sie fehlen (`pull --policy missing`)
  - Stand B-37 (Backupserver): Offsite-Kopie mit rclone (SFTP, S3 …) – `SCHULOS_OFFSITE=<remote>:<pfad>` + `RCLONE_CONFIG_*`
    in backup.env (Beispiele in `backup.env.example`, Host-Schlüssel immer prüfen). Täglich 17:00 je Instanz: `config` und `keys/`
    1:1 (gleicher Hauptschlüssel → Wiederherstellungsschlüssel öffnet auch die Offsite-Kopie), `restic copy`, Aufräumen mit
    derselben Aufbewahrung; Ergebnis in der Übersicht und auf der Instanzseite („Offsite jetzt“)
  - Stand B-38: E-Mail auf beiden Seiten über `SCHULOS_SMTP_*` + `SCHULOS_ALARM_TO` (schulos.env bzw. backup.env), Testmail in
    Verwaltung → System bzw. auf der Übersicht des Backupservers. Alarme alle 15 min geprüft, je Ursache einmal, täglich erinnert,
    „behoben“ gemeldet. Hauptsystem: Backup fehlt/überfällig/fehlgeschlagen, Update fehlgeschlagen (Abbruch ohne späteres „fertig“,
    48 h), Speicherplatz ≥ 90 % (aus dem Systemstatus des Hosts), Abgleich steht. Backupserver: je Instanz Backup überfällig/
    fehlgeschlagen, Aufräumen/Prüfung/Test-Restore/Offsite fehlgeschlagen, Speicherplatz des Repository-Ordners ≥ 90 %
  - Stand SEC-14 (Sicherheitsalarme, ergänzt): Hauptsystem zusätzlich **Häufung fehlgeschlagener Anmeldungen** (alle Konten
    zusammen je Stunde, Schwelle je Schule unter Verwaltung → System, Vorgabe 50; Alarm bleibt bis unter die halbe Schwelle –
    keine Mail-Flut an der Grenze), **neue Admin-/Verwaltungsrechte** (Recht `*` oder `verwaltung.*` an Rolle/Gruppe vergeben,
    Konto mit Rolle Admin/Verwaltung angelegt – je Ereignis genau eine Mail, keine Erinnerung, kein „behoben“; wer es war, steht
    im Protokoll) und **unveränderliche Kopie veraltet/fehlt** (SEC-11). Empfänger: `SCHULOS_ALARM_TO` **und** zusätzliche
    Adressen unter Verwaltung → System (die Umgebung allein ist nicht mehr Pflicht). Backupserver: Wartungslauf „Unveränderliche
    Kopie“ fehlgeschlagen und **„Neustart nötig – Passphrase erforderlich“** (Q5-18) als Statuskarte auf der Übersicht samt Alarm –
    den Zustand schreibt `schulos-hoststatus.timer` auf dem Host nach `/run/schulos-host/status.json` (Bind-Mount `/host`, nur lesend);
    bestehende Backupserver: `sudo node schulosctl.mjs sicherheit-nachruesten` richtet den Timer ein. Keine Personendaten in den Mails.
  - Stand B-43 (Debian aktuell halten, §5a.1): der Installer richtet `unattended-upgrades` ein (nur Debian: Hauptarchiv, -updates,
    -security der laufenden Version; **kein** automatischer Neustart), `needrestart` startet betroffene Dienste ohne Rückfrage neu
    (Docker mit `live-restore`: Container laufen weiter), `snapper` legt vor/nach jedem apt-Lauf Schnappschüsse von `/` an (10 bleiben).
    Verlangt Debian einen Neustart (`/run/reboot-required`), startet `schulosctl wartungsfenster` den Server **nach einer Sicherung**
    im Fenster neu (scheitert die Sicherung: verschoben, Eintrag im Protokoll); der Backupserver hat dafür `schulos-neustart.timer` im
    eigenen Fenster. **Nur mit TPM2** (Q5-18): wird die Platte per Passphrase entsperrt (kein `tpm2-device=` in `/etc/crypttab`),
    startet das Wartungsfenster **nicht** neu – der Server hinge sonst nachts an der Passphrase. Stattdessen „Neustart nötig –
    Passphrase erforderlich“ im Protokoll, Hinweis in Verwaltung → System mit „Jetzt neu starten“ (Sicherung, dann Neustart beim
    nächsten Abgleich; danach Passphrase an der Konsole), Alarm-Mail (täglich erinnert), nach 14 Tagen rot. Der Backupserver bekommt
    mit Passphrase keinen `schulos-neustart.timer` (Neustart von Hand). **Versionssprung** von Hand: `schulosctl os-upgrade [--ziel forky]` – Vorbedingungen frische Sicherung +
    Test-Restore mit App-Start grün + ≥ 5 GB frei; beschreibbarer Schnappschuss `@snapshots/vor-os-upgrade` + tar von /boot (eigene
    Partition, nicht im Schnappschuss) + Bootmenü-Eintrag „Stand vor dem Versionswechsel“ (`/etc/grub.d/41_schulos-rueckweg`);
    Quellen umstellen, `full-upgrade` mit `--force-confold`, Neustart. Danach prüft `schulos-os-upgrade-pruefen.service`: neue
    Version und Stack gesund → fertig; sonst **automatisch zurück** (Subvolume `@` beiseitelegen, Schnappschuss als `@`, /boot
    zurück, Neustart); scheitert schon apt, sofort zurück. Markierung und /boot-Sicherung liegen auf `@srv` (überleben das
    Zurücktauschen). `schulosctl os-rollback` = derselbe Rückweg von Hand. Protokoll in Verwaltung → System
    („Debian-Versionswechsel“, „…zurückgenommen“, „Neustart im Wartungsfenster“).
    **Abweichung:** grub-btrfs gibt es in Debian 13 nicht – statt aller snapper-Stände im Bootmenü gibt es den einen Eintrag für
    den Stand vor dem Versionswechsel; snapper-Stände sind Rettungsmaterial (`snapper undochange`) für normale Updates.
- Ohne Internet: Let's Encrypt fällt weg (dann eigene CA). Updates kommen über ein
  Offline-Bundle auf USB-Stick.

**Hardware (Richtwerte):**

| | Minimum | Schule mit ~600 Konten |
|---|---|---|
| Hauptsystem | 2 Kerne, 4 GB RAM, 64 GB SSD | 4 Kerne, 12 GB (inkl. Vorschau-Instanz und Probelauf, §5a), 256 GB SSD |
| Backupserver | 2 Kerne, 2 GB RAM, Platte ≥ 3× Datenmenge | 2 Kerne, 4 GB, 2× 2 TB gespiegelt |

Beide sind x86_64 mit UEFI. Für die Demo reicht eine VM mit 2 Kernen und 4 GB.

**Last (B-50a, simuliert, `docs/LASTTEST.md`):** 2 Kerne / 4 GB tragen ~300 gleichzeitig aktive Nutzer (Montag 7:40, p95 < 110 ms).
Die Grenze ist der eine Node-Prozess der App (~80 Seiten/s) – mehr als 2 Kerne erhöhen den Durchsatz nicht, erst mehrere
App-Instanzen (B-52, ab ~400–500 gleichzeitig Aktiven bzw. Schulen ab ~1 000 Konten). Postgres ist unkritisch. Bestätigung auf echter
Hardware: B-50b.

**Postgres (B-51):** stellt sich beim Start selbst nach dem RAM der Maschine ein (`configs: postgres-start` in `compose.yaml`):
`shared_buffers` 20 % (128 MB – 4 GB), `effective_cache_size` 50 %, `work_mem` RAM/256 (4 – 32 MB), `maintenance_work_mem` RAM/16
(64 MB – 1 GB), SSD-Annahmen. Bekommt die VM mehr RAM, gelten nach dem nächsten Start die neuen Werte; feste Werte über
`SCHULOS_PG_SHARED_BUFFERS`, `SCHULOS_PG_EFFECTIVE_CACHE_SIZE`, `SCHULOS_PG_WORK_MEM`, `SCHULOS_PG_MAINTENANCE_WORK_MEM` in `.env`.
Die App nutzt höchstens 10 Verbindungen (`SCHULOS_DB_POOL` in `schulos.env`). `pg_stat_statements` ist an – die Abfragen mit der meisten
Datenbankzeit stehen unter Verwaltung → System (Werte durch Platzhalter ersetzt).

---

## 5b. Außenzugang (P4-40)

SchulOS ist per Vorgabe **nur im Schulnetz** erreichbar. Für die Schulanmeldung (Block 4c) müssen Eltern die Seiten
`/anmeldung…` aus dem Internet öffnen können – der Rest (Anmeldung mit Passwort, Verwaltung, Exporte) soll trotzdem im
Schulnetz bleiben. Das regelt `SCHULOS_PUBLIC_ACCESS` in der `.env` des Stacks (Installer: „Aus dem Internet erreichbar“):

| Wert | Von außen (nicht aus `SCHULOS_INTERNAL_NETS`) | Im Schulnetz |
|---|---|---|
| `keiner` (Vorgabe) | alles 403 „nur im Schulnetz“ | alles |
| `oeffentliche-seiten` | nur `/anmeldung` und darunter, `/impressum`, `/datenschutzhinweise`, `/api/schule/logo`, `/icon.png`, `/favicon.ico`, `/_next/static/…` – ohne Cookies; alles andere 403 | alles |
| `alles` | ganz SchulOS (nur mit 2FA für alle Konten und nach Rücksprache mit dem Datenschutz); Verwaltung/Admin per Vorgabe gesperrt, Personal nach den Regeln aus §5c | alles |

**Umsetzung.** Caddy (`configs: caddyfile` in `compose.yaml`) unterscheidet nach der Client-Adresse (`client_ip`):
„Schulnetz“ ist `SCHULOS_INTERNAL_NETS` (Vorgabe `private_ranges` = 10/8, 172.16/12, 192.168/16, 127/8, fd00::/8, ::1).
Die Liste ist eine **Allowlist** – neue Seiten sind von außen gesperrt, bis sie ausdrücklich eingetragen werden (Caddy **und**
`src/core/external-access.ts`, ein Test vergleicht beide). Anfragen von außen bekommen von Caddy `X-SchulOS-Extern: 1`;
ein mitgeschickter Header gleichen Namens wird immer verworfen. Die App prüft gekennzeichnete Anfragen ein zweites Mal
(`src/proxy.ts`: genaue Schreibweise, keine kodierten Punkte/Schrägstriche, keine `..`) und entfernt Cookie und
Authorization – von außen gibt es keine Sitzung. Ein unbekannter Wert lässt Caddy nicht starten (geschlossen statt offen).
Ändern: Wert in `/opt/schulos/.env` setzen, dann `docker compose up -d caddy` im Stack-Ordner. **Achtung beim Update auf
diese Version:** ohne Eintrag gilt `keiner` – wer SchulOS bisher absichtlich von außen erreichbar hatte, setzt `alles`.

**Hinter dem Proxy des Schulträgers** (`web.tls = proxy`): Alle Anfragen kommen dann von der Adresse des Proxys – ohne
`SCHULOS_TRUSTED_PROXIES` gilt jede als „aus dem Schulnetz“, und was von außen erreichbar ist, entscheidet allein der Proxy;
außerdem teilen sich dann alle Besucher ein Rate-Limit-Kontingent (die Schulanmeldung wäre nach 10 Anträgen/Stunde für alle
gesperrt). Mit Außenzugang (`oeffentliche-seiten`/`alles`) verlangt der Installer die Adresse deshalb (GATE-4c); ohne
Außenzugang warnt er nur. Mit der Adresse des Proxys liest Caddy die Client-Adresse aus `X-Forwarded-For`, und zwar von rechts
(`trusted_proxies_strict`): vorangestellte, vom Client selbst geschriebene Einträge zählen nicht. Der Proxy muss
`X-Forwarded-For` setzen bzw. ergänzen.

**Checkliste für den Schulträger** (Voraussetzungen, die SchulOS nicht selbst erfüllen kann):
1. Öffentlicher DNS-Name (z. B. `schulos.schule-xy.de`) zeigt auf die öffentliche Adresse der Schule bzw. des Proxys.
2. Portweiterleitung 443 (und 80 für Let's Encrypt) auf den SchulOS-Server – oder Weiterleitung durch den Proxy.
3. Zertifikat: Let's Encrypt (`web.tls = letsencrypt`) oder öffentliches Zertifikat am Proxy – mit der eigenen CA sehen
   Eltern eine Zertifikatswarnung.
4. Hinter einem Proxy: dessen Adresse(n) als `SCHULOS_TRUSTED_PROXIES`; der Proxy setzt `X-Forwarded-For`.
5. „Schulnetz“ prüfen: liegen Gäste-WLAN oder andere Netze im privaten Bereich, die nicht als intern gelten sollen,
   `SCHULOS_INTERNAL_NETS` auf die echten Schulnetze einschränken (z. B. `10.10.0.0/16 10.20.0.0/16`).
6. **IPv6:** Mit Docker-Vorgabe nimmt der „Userland-Proxy“ (`docker-proxy`) IPv6-Verbindungen an und reicht sie per IPv4
   weiter – Caddy sähe die Adresse des Docker-Gateways (privat → „Schulnetz“!). Der Installer schreibt deshalb
   `"userland-proxy": false` in `/etc/docker/daemon.json` (GATE-4c): Docker leitet dann nur per iptables weiter (IPv4, echte
   Absenderadresse), IPv6-Verbindungen von außen werden abgewiesen. SchulOS ist damit von außen **nur per IPv4** erreichbar
   (AAAA-Eintrag weglassen oder auf den Proxy zeigen lassen). `schulosctl status` meldet „Außenzugang über IPv6 offen“, wenn
   der Außenzugang an ist, die Einstellung aber fehlt. **Bestandsinstallationen** (vor GATE-4c installiert) vor dem Einschalten
   des Außenzugangs nachziehen: in `/etc/docker/daemon.json` `"userland-proxy": false` ergänzen, `systemctl restart docker`,
   dann im Stack-Ordner `docker compose up -d --force-recreate`. In jedem Fall Punkt 7.
7. **Von außen testen** (Mobilfunk, nicht das WLAN der Schule): `https://<domain>/anmeldung` lädt, `https://<domain>/login`
   zeigt „Diese Seite ist nur im Schulnetz erreichbar.“ (403). Im Schulnetz funktioniert die Anmeldung wie gewohnt.
8. Impressum (Verwaltung → Schule, Pflichtfelder nach § 5 DDG – ohne sie lässt sich keine Schulanmeldung veröffentlichen) und
   Datenschutzhinweise pflegen – Pflicht für öffentliche Seiten.
9. **Admin-Ebene nie ins Internet (SEC-12):** nur Port 443 (und 80) weiterleiten – **nie** 22 (SSH), nie die Oberfläche des
   Hypervisors (Proxmox 8006, Hyper-V/vSphere-Verwaltung, IPMI/BMC). Fernwartung nur über WireGuard (VPN am Router bzw. an der
   Firewall der Schule/des Schulträgers) ins Schulnetz, von dort per SSH und `schulosctl`. SchulOS selbst lässt SSH nur aus den
   im Installer eingetragenen Netzen zu (Frage „Schulnetz-Bereiche“ – dieselbe Einstellung wie für App und Caddy –, Vorgabe die privaten Bereiche; eine eigene
   nftables-Tabelle `schulos_ssh` macht Port 22 für alle anderen zu, `sshd` nimmt das Wartungskonto nur von dort an). Das
   WireGuard-Netz gehört in diese Liste, falls es nicht ohnehin privat ist. `ssh.service` startet nur mit geladener Regel
   (fail closed, G4E-O06) – scheitert die Regel, bleibt SSH aus und die Konsole hilft. **Später ändern bzw.
   Bestandsinstallationen** (vor SEC-12): `sudo schulosctl ssh-netze <netz> …` (§5) – legt Regel, Dienst und sshd-Einstellung an. **Pentest** vor dem Pilot mit Außenzugang: Punkt 10.
10. **Externer Penetrationstest – Pflicht vor einem Pilot mit Außenzugang (SEC-16):** von einer unabhängigen Stelle, gegen die
    Installation, die in den Pilot geht (gleiche Version, gleicher Außenzugang). **Prüfumfang mindestens:** Außenzugang (Zonen in
    Caddy, Allowlist der öffentlichen Seiten, IPv6, gefälschte `X-Forwarded-For`/`X-SchulOS-*`), Gerätezertifikate (Schul-CA,
    Sperrliste, mTLS, Rollen von außen), Anmeldung (2FA, Sperren, Sitzungen, Passwort zurücksetzen, Passkeys) und Backup-Pfad
    (Kopplung, Agent-API, Wiederherstellung mit Bestätigung, Offsite-Kopie und unveränderliche Kopie). Ergebnisse gehen als
    SEC-Folgeaufgaben in `docs/BACKLOG.md`; der Pilot startet erst, wenn alle hohen und kritischen Befunde behoben sind. Ohne
    Außenzugang (nur Schulnetz) wird der Test dringend empfohlen. SchulOS ist bis dahin Vorschau-Software ohne Gewähr (REPO-03).

Kein Außenzugang möglich? Die Schulanmeldung funktioniert auch nur im Schulnetz (Terminals im Sekretariat, Tag der offenen
Tür) – ohne Änderung. Personal-Zugang von außen mit Gerätezertifikaten: §5c. Die Vorschau-Instanz (§5a.3) ist eine
eigene Site und **unabhängig von dieser Einstellung nur im Schulnetz** erreichbar (von außen 403, gleiche Unterscheidung über
`SCHULOS_INTERNAL_NETS`); von außen nur ausdrücklich mit `schulosctl vorschau an --extern` (GATE-4c, Projektleitung 2026-10-10).

Geprüft: `src/core/external-access.test.ts` (Allowlist, Pfad-Tricks, Proxy, Caddy-Konfiguration) und im CI-Job `stack`
`scripts/aussenzugang-test.mjs` je Modus (von außen simuliert per `X-Forwarded-For` mit `SCHULOS_TRUSTED_PROXIES=private_ranges`).

### 5c. Gerätezertifikate für Personal von außen (P4-40b)

Lehrkräfte und Personal sollen SchulOS auch von außerhalb des Schulnetzes nutzen können – aber nur auf **Geräten der Schule
bzw. freigegebenen Geräten**, nicht von jedem beliebigen Rechner (Schutz gegen abgegriffene Passwörter, Ransomware über
private Geräte). Dazu weist sich das Gerät beim Verbindungsaufbau mit einem Zertifikat der **Schul-CA** aus (TLS-Client-
Zertifikat). Eltern und Schüler:innen melden sich wie bisher an (mit `alles`); Passkeys/2FA für sie folgen in Block 4e
(SEC-01/SEC-03). Öffentliche Seiten (§5b) brauchen kein Zertifikat.

**Wer kommt von außen herein?** (Entscheidung in der App, `src/core/device-certs/policy.ts`, SICHERHEIT.md S27/S28)

| Weg von außen | Lehrkraft/Personal | Verwaltung/Admin | Eltern/Schüler:innen |
|---|---|---|---|
| ohne Zertifikat, Modus `keiner`/`oeffentliche-seiten` | nur öffentliche Seiten | nur öffentliche Seiten | nur öffentliche Seiten |
| ohne Zertifikat, Modus `alles` | nur wenn „auch ohne Gerätezertifikat“ eingestellt | gesperrt (Vorgabe) | Anmeldung wie bisher |
| gültiges, freigegebenes Zertifikat (jeder Modus) | ja | gesperrt (Vorgabe); erlaubt → nur mit Zertifikat, das an genau dieses Konto gebunden ist | ja |
| Zertifikat gesperrt, nicht freigegeben oder an ein anderes Konto gebunden | nein | nein | nur im Modus `alles` (wie ohne) |
| Zertifikat abgelaufen oder von einer fremden CA | Verbindung bricht schon beim TLS-Aufbau ab | ebenso | ebenso |

Seiten ohne Anmeldung (Healthcheck, Monitore): mit Zertifikat in den Modi `keiner`/`oeffentliche-seiten` gesperrt (nur
öffentliche Seiten und Anmeldung), im Modus `alles` wie ohne Zertifikat erreichbar – das Zertifikat öffnet nie mehr als der
Modus und sperrt nichts, was ohne Zertifikat offen ist.

Die Regeln stellt der Admin unter **Verwaltung → System → Gerätezertifikate** ein – nur im Schulnetz: „Lehrkräfte und
Personal von außen“ (Vorgabe: nur mit Gerätezertifikat, **sobald die Schul-CA eingerichtet ist**) und „Verwaltung und Admin
von außen“ (Vorgabe: gesperrt; erlaubt gilt die Zertifikatspflicht wie für Personal). Die Anmeldeseite sagt von außen vorab,
wer sich dort anmelden kann; eine abgelehnte Anmeldung lautet wie bei falschem Passwort (verrät nicht, ob das Passwort stimmt)
und zählt für die Anmeldesperre. Eine im Schulnetz begonnene Sitzung gilt von außen nur nach denselben Regeln.

**Einrichten** (einmalig auf dem Server, im Stack-Ordner `/opt/schulos`):
1. In der `.env` zwei lange Zufallspasswörter eintragen: `SCHULOS_DEVICE_CA_PASSWORD` (Schlüssel der CA) und
   `SCHULOS_DEVICE_CA_PROVISIONER_PASSWORD` (damit stellt SchulOS aus). Beide gehören in den Notfallordner – ohne das erste
   lässt sich die CA nicht mehr starten. Optional `SCHULOS_DEVICE_CA_NAME` (Name der CA, Vorgabe „SchulOS Geraete-CA“).
2. `docker compose --profile geraete up -d` – startet step-ca (Compose-Profil `geraete`). Beim ersten Start entstehen Wurzel,
   Zwischen-CA und der Provisioner `schulos` (Laufzeiten bis 731 Tage); die öffentlichen Zertifikate liegen danach im
   Volume `geraete_ca`, die Schlüssel nur im Volume `step_ca` (gehört ins Backup – siehe Frage P4-40b). step-ca ist nur im
   internen Netz `ca` erreichbar, nicht von außen und nicht aus dem Schulnetz.
3. In der `.env` `SCHULOS_DEVICE_CERTS=an` setzen, dann `docker compose up -d`. Caddy fragt jetzt nach einem Client-Zertifikat
   (`client_auth`, Modus `verify_if_given`: ohne Zertifikat geht es normal weiter). **Reihenfolge einhalten:** ohne die
   Wurzel im Volume startet Caddy mit `an` nicht (geschlossen statt offen) – dann `SCHULOS_DEVICE_CERTS=aus` und Schritt 2 prüfen.
4. Verwaltung → System → Gerätezertifikate zeigt „Schul-CA erreichbar“ und den Fingerabdruck der Wurzel. Prüfung auf der
   Kommandozeile: `docker compose exec app node cli.mjs geraete-ca-pruefen`.

**Ausstellen und verteilen.** Unter Verwaltung → System → Gerätezertifikate: Gerätebezeichnung (steht nur in SchulOS, im
Zertifikat steht `geraet-<zufall>`), Laufzeit (30–730 Tage, Vorgabe 365), optional „nur für Konto“. SchulOS erzeugt Schlüssel
und Zertifikat und gibt sie **einmal** als Datei mit Zufallspasswort aus – gespeichert werden weder Schlüssel noch Passwort:
- **iPad/Mac (Apple):** `.mobileconfig` öffnen bzw. im Apple-MDM (z. B. Apple School Manager + MDM) als eigenes Profil
  hochladen. Das Profil enthält das Passwort, damit das MDM ohne Nachfrage installieren kann – so geheim behandeln wie die .p12.
- **Intune:** die `.p12` als „PKCS importiertes Zertifikat“ bzw. für Windows als Gerätezertifikat verteilen, für iOS/macOS
  alternativ die `.mobileconfig` als benutzerdefiniertes Profil.
- **Relution:** `.p12` mit Passwort als Zertifikats-Konfiguration hinterlegen und der Gerätegruppe zuweisen.
- **Ohne MDM:** `.p12` per Doppelklick (Windows/macOS) bzw. Einstellungen → Sicherheit → Zertifikat installieren (Android).
Der Browser bietet das Zertifikat beim Aufruf von SchulOS an (ggf. einmal auswählen). Dateien nur verschlüsselt weitergeben und
danach löschen.

**Sperren.** Verloren, ausgemustert, Schlüssel kompromittiert: in der Liste „Sperren“ mit Grund – wirkt sofort (jede Anfrage
prüft die Freigabeliste in der Datenbank; Caddy prüft vorher nur Kette und Laufzeit). Die Liste zeigt alle Zertifikate mit
Status (gültig, abgelaufen, gesperrt), gebundenem Konto und Fingerabdruck.

**Grenzen.** Hinter dem Proxy des Schulträgers (`web.tls = proxy`) endet TLS am Proxy – Client-Zertifikate kommen dann nicht
bei Caddy an (der Proxy müsste TLS durchreichen). Automatische Ausstellung durch das MDM (SCEP, ACME Device Attestation)
ist noch nicht eingebaut (Folgeaufgabe, siehe `docs/QUESTIONS.md`). Die ISO bringt das step-ca-Image nicht mit; es wird beim
ersten `--profile geraete` geladen.

Geprüft: `src/core/device-certs/*.test.ts` (Entscheidungstabelle aller Zonen × Rollen × Zertifikate × Einstellungen,
Freigabe-/Sperrliste, Anmeldung über Better-Auth, Ausstellung gegen eine nachgebaute step-ca, PKCS#12 gegen OpenSSL mit echter
TLS-Client-Authentifizierung), `src/core/external-access.test.ts` (Kennzeichen, Proxy, Caddy-Konfiguration), E2E
`e2e/geraetezertifikate.spec.ts`; im CI-Job `stack` `scripts/geraetezertifikat-test.sh` (Test-CA: gültig, gesperrt,
unbekannt, abgelaufen, fremde CA, gefälschte Kennzeichen – je Modus `keiner`/`alles`) und die echte step-ca
(`node cli.mjs geraete-ca-pruefen`).

---

## 5a. Updates: Betriebssystem und SchulOS

> Stand 2026-10-04 · Status: **Vorschlag** (Auftrag von der Projektleitung zum Start von Track B: „Lösungen finden, wie Debian
> aktuell bleibt – auch bei Versionssprüngen – und wie neue SchulOS-Funktionen ankommen, ggf. mit Testinstanz“).
> Offene Punkte zur Bestätigung: QUESTIONS.md.

Grundsatz: **Zwei getrennte Update-Wege.** Das Betriebssystem ist schlank und trägt nur Docker,
`schulosctl` und die Systemdienste; alles, was SchulOS ausmacht (App, Node, Postgres, Caddy), steckt in
Container-Images und kommt mit SchulOS-Releases. Deshalb ändert ein Debian-Update fast nie etwas an der
App, und ein SchulOS-Update nie etwas am Betriebssystem.

### 5a.1 Debian aktuell halten

| Art | Wie oft | Weg | Ohne Zutun? |
|---|---|---|---|
| **Sicherheitsupdates** (`trixie-security`) | sobald verfügbar | `unattended-upgrades`, täglich | **ja** |
| **Punkt-Releases** (13.1, 13.2 …, `trixie-updates`) | etwa alle 2 Monate | `unattended-upgrades` (Hauptarchiv + `stable-updates`) | **ja** |
| **Neustart** nach Kernel-/libc-Update | bei Bedarf | `needrestart` startet Dienste neu; ist ein Neustart nötig (`/run/reboot-required`), startet der Server **im Wartungsfenster** (Vorgabe 02–04 Uhr) neu – vorher ein Backup; mit LUKS-Passphrase nur Hinweis + „Jetzt neu starten“ (Q5-18) | ja, im Fenster (nur TPM2) |
| **Versionssprung** (13 „trixie“ → 14 „forky“) | etwa alle 2 Jahre; die alte Version bekommt danach noch ~1 Jahr Sicherheitsupdates (plus 2 Jahre LTS) | **geführt** mit `schulosctl os-upgrade` (s. u.), ausgelöst von der Admin | **nein, bewusst** |

**Versionssprung, geführt** (`schulosctl os-upgrade`, auch als Knopf in Verwaltung → System):
1. Vorbedingungen: letzte Sicherung < 24 h **und** letzter Test-Restore grün, genug freier Platz.
2. **Dateisystem-Schnappschuss:** Die ISO installiert das System auf **btrfs** mit den Subvolumes `@`
   (System) und `@srv` (Daten, nicht Teil des System-Schnappschusses). `snapper` legt vor jedem apt-Lauf
   automatisch einen Schnappschuss an, `grub-btrfs` macht die letzten Schnappschüsse im Bootmenü wählbar.
3. Paketquellen auf die neue Version umstellen, `apt full-upgrade` mit vorher getesteten Antworten
   (keine Rückfragen), Neustart.
4. Nach dem Start: Docker läuft, Stack gesund (`/api/health`), Backup-Agent meldet sich. Sonst **automatisch
   zurück** auf den Schnappschuss (bzw. von Hand im Bootmenü). Die Daten in `@srv` bleiben dabei unberührt.
5. Die Verwaltung zeigt dauerhaft an, bis wann die laufende Debian-Version Sicherheitsupdates bekommt,
   und ab 6 Monaten vor dem Ende den Hinweis „Versionswechsel empfohlen“.

**Plan B – Neuinstallation statt Upgrade:** neue ISO (mit Debian 14) → „aus Backup wiederherstellen“ (§4.4).
Das ist derselbe Weg wie bei defekter Hardware und wird in der CI ohnehin getestet. Er passt, wenn das
In-Place-Upgrade scheitert oder sowieso neue Hardware kommt.

Der **Backupserver** folgt denselben Regeln, mit eigenem Wartungsfenster, nie gleichzeitig mit dem Hauptsystem.

### 5a.2 SchulOS-Updates (neue Funktionen und Fehlerbehebungen)

**Releases:** Versionsnummern nach SemVer. Jedes Release ist ein signierter Satz Images (GHCR + cosign) plus
ein signiertes **Release-Manifest** (Version, Kanal, Mindestversion für den Sprung, Migrationen, Änderungsliste
in Alltagssprache, „sicherheitsrelevant ja/nein“). Die Images werden **wöchentlich neu gebaut**, damit
Sicherheitsupdates von Node, Postgres und Caddy auch ohne neue Funktionen ankommen (Patch-Release,
z. B. 1.4.3 → 1.4.4).

| Kanal | Für wen | Inhalt |
|---|---|---|
| **stabil** (Vorgabe) | Schulbetrieb | Releases, die mindestens 2 Wochen im Kanal „beta“ waren |
| **beta** | Vorschau-Instanz, Pilotschule | neue Funktionen früher |

**Wie ein Update ankommt:**

| Art | Weg |
|---|---|
| **Patch** (Sicherheit, Fehler, keine neuen Funktionen) | automatisch im Wartungsfenster: Backup → Probelauf → Update → Healthcheck → bei Fehler zurück. Danach ein Hinweis in der Verwaltung |
| **Minor** (neue Funktionen) | Verwaltung → System zeigt „SchulOS 1.5 verfügbar“ mit Änderungsliste. Die Admin **gibt frei** (sofort oder im nächsten Wartungsfenster). **Neue Module kommen ausgeschaltet** und werden wie heute unter „Rechte & Module“ eingeschaltet, wenn die Schule so weit ist |
| **Major** (größere Umbauten, z. B. Postgres 18 → 19) | wie Minor, mit Hinweistext, was sich ändert; die Datenbank wird beim Update per `pg_upgrade` bzw. Dump/Restore mitgezogen |

Eine Version ist nur von der direkt vorigen Minor-Version aus erreichbar (1.3 → 1.5 läuft über 1.4;
`schulosctl` erledigt die Zwischenschritte). Updates kommen aus GHCR, ohne Internet über ein
**Offline-Bundle** auf USB-Stick (Images + Manifest, Signatur wird geprüft).

**Woher `schulosctl` die Releases holt (REPO-02):** aus den GitHub-Releases des Repos (fest eingebaut, `RELEASE_REPO` in
`apps/ctl/src/stack.ts`). Privates Repo: Token in `SCHULOS_GITHUB_TOKEN` (Lesezugriff auf Inhalte; Images aus GHCR
brauchen dann zusätzlich `docker login ghcr.io`). Öffentliches Repo: **kein Token nötig** – die Liste der Releases kostet
einen API-Aufruf, `release.json`, Signatur und Host-Dateien kommen über die öffentlichen Download-Links (zählen nicht gegen
das Limit von 60 API-Aufrufen je Stunde und Adresse), die Images per anonymem `docker pull` aus GHCR. Vertraut wird in
beiden Fällen nur dem signierten Manifest, nicht dem Übertragungsweg.

**Host-Dateien (GATE-031, ab v0.3.2):** Jedes Release hängt `schulosctl.mjs` und `compose.yaml` an; ihre SHA-256 stehen im
signierten Manifest (`files`). `schulosctl update` übernimmt sie nur bei passender Prüfsumme: die `compose.yaml` während des
Updates vor dem Start (muss mit der `.env` durchgehen, alte Fassung als `compose.yaml.vorher-<version>`, der Rückweg legt sie
zurück; war sie von Hand geändert, steht das im Protokoll), `schulosctl.mjs` nach einem gelungenen Schritt (neue Datei muss
`version` beantworten, alte als `schulosctl.mjs.vorher`). Danach startet das neue `schulosctl` seine einmaligen
Umstellungen (`db-rolle`). Zurück zur vorigen Fassung: `cp /opt/schulos/schulosctl.mjs.vorher /opt/schulos/schulosctl.mjs`.
Das Offline-Bundle nimmt die Host-Dateien mit.

**Umstellung auf das öffentliche Repository (Installationen bis v0.5.1, einmalig von Hand, REPO-01):** Bis v0.5.1 holte
`schulosctl` die Releases aus dem damals privaten Repository und prüfte sie mit dem damaligen Schlüssel. Seit der
Veröffentlichung kommen die Releases aus `schulos/schulos` und sind mit einem **neuen Schlüssel** signiert (Fingerabdruck in
`release/README.md`). Ein altes `schulosctl` sieht deshalb keine neuen Releases mehr. Einmal das neue einsetzen:

1. `curl -fsSLO https://github.com/schulos/schulos/releases/download/v<version>/schulosctl.mjs` sowie `release.json`,
   `release.json.sig` und `compose.yaml` desselben Release; dazu `cosign.pub` aus dem Repo.
2. Fingerabdruck von `cosign.pub` mit `release/README.md` vergleichen (`openssl pkey -pubin -in cosign.pub -outform DER |
   sha256sum`), dann `cosign verify-blob --key cosign.pub --insecure-ignore-tlog=true --signature release.json.sig
   release.json` → „Verified OK“ und `sha256sum schulosctl.mjs compose.yaml` mit `files` in `release.json` vergleichen.
3. Einsetzen wie unten (Schritt 3): `schulosctl.mjs` nach `/opt/schulos/`, danach `sudo schulosctl update`.

**Umstellung älterer Installationen (bis v0.3.1, einmalig von Hand):** Ein `schulosctl` bis v0.3.1 kennt weder die
Host-Dateien noch die Rollen-Umstellung (SEC-07) – es spielt nur die neuen Images ein, die App läuft dann weiter mit
Superuser-Recht (Verwaltung → System zeigt dazu einen Hinweis). Einmal das neue `schulosctl` einsetzen:

1. Auf einem Rechner mit Zugang zum damaligen (privaten) Repository: `gh release download v0.3.2 -R <bisheriges Repo> -p release.json
   -p release.json.sig -p schulosctl.mjs -p compose.yaml -D sec07`; den Ordner auf den Server kopieren (z. B. nach `/root/sec07`).
2. Auf dem Server prüfen – **mit dem Schlüssel, der im laufenden `schulosctl` eingebacken ist**, nicht mit einem
   mitgelieferten `cosign.pub` (wer den Download manipuliert, könnte den passenden Schlüssel gleich mitliefern; GATE-031 R-03):
   `sudo schulosctl update --check --quelle /root/sec07`. Das alte `schulosctl` prüft dabei die Signatur von `release.json`
   (der Ordner darf nur dieses eine Release enthalten). Erwartet: Exit 0 oder 10 mit Änderungsliste bzw. „ist aktuell“;
   bei einer fremden oder veränderten Datei bricht es mit „Signatur des Release-Manifests ist ungültig“ ab – dann **nicht** weiter.
   Erst danach `sha256sum schulosctl.mjs compose.yaml` mit `files` in der geprüften `release.json` vergleichen.
   Zur Gegenprobe (optional) der Fingerabdruck des damaligen Release-Schlüssels (v0.3.0 bis v0.5.1):
   `openssl pkey -pubin -in cosign.pub -outform DER | sha256sum` →
   `45d4ea42983aa7ae7bed8fdf9bf47981921dbea9a7d786d056071b3e6e014be1`.
3. Einsetzen: `sudo cp /opt/schulos/schulosctl.mjs /opt/schulos/schulosctl.mjs.vorher && sudo install -m 0755 schulosctl.mjs
   /opt/schulos/schulosctl.mjs`, `schulosctl version` muss die neue Version nennen.
4. `sudo schulosctl db-rolle` (oder auf das nächste Wartungsfenster warten – `update` stellt vor dem Plan selbst um).
   Die neue `compose.yaml` kommt mit dem nächsten Release von selbst; wer sie sofort will:
   `sudo cp /opt/schulos/compose.yaml /opt/schulos/compose.yaml.vorher && sudo cp compose.yaml /opt/schulos/` und
   `docker compose --project-directory /opt/schulos up -d --wait`.

Danach erledigt `schulosctl update` alles weitere selbst.

### 5a.3 Testinstanzen: Vorschau und Probelauf

Die Idee „die Produktivumgebung enthält immer eine Testinstanz“ wird in **zwei** Formen umgesetzt, weil sie
zwei verschiedene Fragen beantworten:

| | **Vorschau-Instanz** | **Probelauf** (Generalprobe vor dem Update) |
|---|---|---|
| Frage | „Wie sieht die neue Version aus – wollen wir sie?“ | „Läuft die neue Version mit **unseren** Daten?“ |
| Daten | **Demo-Schule** (fiktiv), keine Personendaten, frei zum Ausprobieren für Kollegium und Schulleitung | **Kopie der echten Daten** aus der letzten Sicherung |
| Lebensdauer | dauerhaft, nächtlicher Demo-Reset | nur während des Updates, danach gelöscht |
| Version | immer die **nächste** Version (Kanal beta bzw. die freizugebende Version) | die Version, die gleich installiert wird |
| Zugang | eigene Adresse, z. B. `vorschau.schulos.schule-xy.de`, Demo-Logins, Band „VORSCHAU“; **nur im Schulnetz** (von außen nur mit `vorschau an --extern`, Warnung: Demo-Admin `admin`/`schulos`) | keiner (läuft automatisch); Ergebnis im Update-Protokoll |
| Ressourcen | ~1 GB RAM, abschaltbar | kurzzeitig DB-Kopie + App |

**Ablauf eines Funktions-Updates:**
1. Release erscheint → die Vorschau-Instanz aktualisiert sich selbst → Verwaltung: „1.5 verfügbar – in der
   Vorschau ansehen“.
2. Schulleitung/Admin schaut sich die neuen Funktionen in der Vorschau an und **gibt frei**.
3. Im Wartungsfenster: Backup → **Probelauf** (Snapshot in einen Wegwerf-Postgres, neue Version starten,
   Migrationen auf den echten Daten, Healthcheck, Rauchtest: Startseite, Login mit einem technischen Konto,
   Stundenplan, Zählung der Tabellen) → nur wenn alles grün ist: Update der echten Instanz.
4. Healthcheck nach dem Update; schlägt er fehl: alte Images und Datenbankstand von vor dem Update zurück.
   Weil Migrationen nur vorwärts laufen, gilt der automatische Rückweg nur im Update-Fenster selbst. Später
   führt der Weg zurück über eine Wiederherstellung aus dem Backup (mit dem Hinweis, dass seitdem
   Eingegebenes fehlt).

**Datenschutz beim Probelauf:** Die Kopie verlässt das Hauptsystem nicht, hat keinen Netzzugang nach außen
(keine Mails, kein Push, kein Gong), ist für Menschen nicht erreichbar und wird direkt nach dem Probelauf
gelöscht (Löschnachweis im Update-Protokoll). Eine **von Menschen bedienbare Kopie echter Daten**
(„Staging mit Echtdaten“) gibt es bewusst **nicht**: Sie wäre eine zweite Verarbeitung personenbezogener
Daten ohne eigenen Zweck und würde Löschungen umgehen.

**Vorschau mit Schulprofil (P4-77, Q-4E-28):** `schulosctl vorschau profil` übernimmt den Zuschnitt der echten Schule in die
Vorschau – Logo, Schulname, eingeschaltete Module, Rechte/Rollen und Einstellungen, **keine Personendaten**: Im App-Container des
Hauptsystems erzeugt `node cli.mjs schulprofil-export` das Profil (JSON), schulosctl legt es als `schulprofil.json` in den
Konfigurationsordner der Vorschau und setzt sie zurück; `demo-reset` (auch der nächtliche) spielt es danach jedes Mal wieder ein.
`schulosctl vorschau profil --aus` entfernt es (wieder die reine Demo-Schule). `vorschau an` fragt am Terminal, ob das
Schulprofil übernommen werden soll. Neue Einstellungen der Schule kommen erst mit erneutem `vorschau profil` in die Vorschau.

### 5a.4 Umsetzung

| Teil | Block |
|---|---|
| Release-Manifest, Kanäle, wöchentlicher Image-Neubau, Signaturen | OPS-3 |
| `schulosctl update` mit Probelauf, Rückweg, Offline-Bundle; Verwaltung → System (Version, verfügbare Updates, Freigabe, Protokoll, Debian-Supportende) | OPS-3 |
| Vorschau-Instanz als zweites Compose-Projekt (`schulos-vorschau`) mit eigener Subdomain in Caddy | OPS-3 |
| btrfs-Layout, snapper (statt grub-btrfs: eigener Bootmenü-Eintrag, s. B-43), `unattended-upgrades`/`needrestart`, `schulosctl os-upgrade` | OPS-4 (ISO) |
| CI: Update-Test N−1 → N inkl. Probelauf; Debian-Upgrade-Test in QEMU | OPS-4 |

---

## 6. Weitere Lieferformen aus demselben Build

| Artefakt | Für wen |
|---|---|
| `schulos-<version>.iso` | das Komplettpaket, beide Rollen |
| `compose.yaml` je Rolle + `.env`-Vorlage | Admins mit vorhandenem Docker, z. B. eine vorhandene Docker-VM |
| `.qcow2` je Rolle | Proxmox/QEMU ohne Installer (Antworten per `schulos-install.yaml` im Cloud-Init-Laufwerk) |

### 6.1 Abbild für Proxmox/QEMU (qcow2, B-46)

`schulos-<version>-hauptsystem.qcow2` und `schulos-<version>-backupserver.qcow2` entstehen aus der ISO
(`bash iso/build-qcow2.sh <iso> [ausgabe]`): die ISO installiert in einer QEMU-VM nur den Teil, der von der Rolle abhängt –
Debian, Docker, Images, Compose-Datei, schulosctl/Timer – auf eine Platte (virtuell 32 GB), **ohne Antworten**.

- **Erster Start:** der Dienst `schulos-konfigurieren` liest `schulos-install.yaml` vom Cloud-Init-Laufwerk (NoCloud, Bezeichnung
  `cidata`, Datei `user-data`) – alternativ von einem Laufwerk `SCHULOSCFG` wie bei der ISO – und richtet ein, was sonst der
  Installer schreibt: Hostname, Netz, Wartungskonto, SSH (neue Host-Schlüssel je Kopie), `.env`/`schulos.env` bzw. `backup.env`.
  Direkt danach läuft der Erststart (Images laden, starten, koppeln bzw. wiederherstellen) wie nach der ISO-Installation.
  `disk:` entfällt in der Datei, `role:` muss zum Abbild passen. Fehlt etwas, fragt der Installer auf der Konsole (tty1) nach.
  Kein Paket `cloud-init`: nur dieses eine Laufwerk, keine zweite Konfigurationsquelle.
- **Plattengröße:** die Systempartition wächst bei jedem Start auf die Größe der VM-Platte (growpart + `btrfs filesystem resize`),
  auch nach einem späteren `qm resize`. Kein mdadm-Spiegel – Redundanz macht der Hypervisor bzw. sein Speicher.
- **Ohne Verschlüsselung (LUKS):** jede Kopie eines verschlüsselten Abbilds hätte denselben Schlüssel. Wer Verschlüsselung
  braucht, verschlüsselt den Speicher des Hypervisors (z. B. ZFS-Verschlüsselung) – oder installiert von der ISO (TPM2/Passphrase).
- **Backupserver:** den Kopplungscode für das Hauptsystem zeigt nach der Einrichtung die Konsole (tty1) bis zum nächsten Neustart;
  neu: `docker compose --project-directory /opt/schulos-backup exec backup node cli.mjs kopplungscode`.

Proxmox (UEFI nötig – das Abbild startet nicht mit SeaBIOS):

```sh
qm create 120 --name schulos --memory 4096 --cores 2 --net0 virtio,bridge=vmbr0 \
  --bios ovmf --efidisk0 local-lvm:1,efitype=4m,pre-enrolled-keys=0 --scsihw virtio-scsi-single --agent 1
qm importdisk 120 schulos-1.0-hauptsystem.qcow2 local-lvm
qm set 120 --scsi0 local-lvm:vm-120-disk-1 --boot order=scsi0 --ide2 local-lvm:cloudinit \
  --cicustom user=local:snippets/schulos-install.yaml
qm resize 120 scsi0 100G   # optional – die Wurzel wächst beim Start mit
qm start 120
```

Die Antwortdatei enthält Passwörter: nach dem ersten Start das Cloud-Init-Laufwerk entfernen (`qm set 120 --delete ide2`) und das
Snippet löschen. Die Netz-Angaben von Proxmox (`ipconfig0`) gelten nicht – das Netz kommt aus `network:` in der Datei.

---

## 7. Automatisch getestet

In der CI für jede ISO:
0. **Stick ohne Testmodus** (INST-07): die ISO selbst mit Stick „unbeaufsichtigt“ → Hinweis + Oberfläche, keine Installation;
   alle weiteren Schritte mit der Test-Kopie (§7.1)
1. **Backupserver** in QEMU per `schulos-install.yaml` installieren, Kopplungscode per API holen
2. **Hauptsystem (Produktiv)** installieren und dabei koppeln → `/api/health`, Login mit dem
   Installer-Admin, Datenbank leer bis auf das Admin-Konto
3. Backup auslösen → Test-Restore auf dem Backupserver muss grün sein
4. **Hauptsystem (Demo)** installieren → Teil der Playwright-Suite; danach mit eingelegtem Medium und SCHULOSCFG-Stick neu
   starten → der Überschreibschutz bricht ab (Code 5, nichts gelöscht; INST-06)
5. **Update-Test:** Version N−1 installieren, auf N aktualisieren, Daten erhalten
6. **Restore-Test:** neues Hauptsystem „aus Backup wiederherstellen“, Daten identisch

Dazu für die Abbilder (§6.1, `scripts/qemu-test.sh <iso> <ordner> --qcow2`, Workflow `iso.yml` mit `qemu: qcow2`): beide aus der
ISO bauen, Backupserver und Hauptsystem daraus mit Cloud-Init-Laufwerk auf 48-GB-Platten starten → eingerichtet, Wurzel gewachsen,
gekoppelt, Sicherung + Test-Restore grün.

Ein ISO-Release gibt es nur, wenn alles grün ist.

### 7.1 Für Entwickler: CI-Testmodus (INST-07)

Nicht für Schulen. Eine Installation **ohne Mensch davor** (Platten löschen, installieren, neu starten) läuft nur, wenn
**beides** zutrifft: ein Laufwerk `SCHULOSCFG` steckt **und** die Kernel-Zeile enthält `schulos.testmodus`. Den Parameter setzt nur
`iso/testmodus-iso.sh` – eine Kopie der ISO, in der allein der Eintrag „SchulOS installieren“ des Bootmenüs ergänzt ist (xorriso,
`-boot_image any replay`). Aufrufer: `scripts/qemu-test.sh` (Workflow `iso.yml`) und `iso/build-qcow2.sh`. Die gebaute bzw.
Release-ISO trägt ihn nie (`iso/build.sh` bricht sonst ab); aus einer Datei auf dem Stick wird er nie gelesen.

- **Stick ohne Testmodus** (z. B. mit der Datei `unbeaufsichtigt`): tty1 zeigt einen Hinweis, dann startet die normale Oberfläche
  mit den Antworten als Vorbelegung – nichts wird ohne Zusammenfassung und Bestätigung gelöscht. Seriell: `SCHULOS-INSTALLER:
  kein-testmodus`. Geprüft in Schritt 0 von `scripts/qemu-test.sh`.
- **Test-Schalter** (Dateien auf `SCHULOSCFG` bzw. `schulos.<name>` in der Kernel-Zeile, alle nur im Testmodus):
  `unbeaufsichtigt` (ohne Oberfläche, Installer-Schalter `--unbeaufsichtigt --testmodus`) · `vorschau-verstanden` (REPO-03: der
  Vorschau-Hinweis gilt als bestätigt; ohne die Datei bricht die unbeaufsichtigte Installation ab) · `ueberschreiben` (INST-06) ·
  `ohne-bestaetigung` (Schlüssel nur als Zeile, seriell geschwärzt, Ende ohne Bestätigung von Block 8 und Neustart nach 30 s – der
  Schlüssel ist danach weg) · `seriell-geheimnisse` (Schlüssel und Kopplungscode ungeschwärzt auf ttyS0) · `abbild` (qcow2 bauen,
  §6.1). `danach-aus` (ausschalten statt neu starten) wirkt immer.
- **Ende wie im Betrieb** (INST-05): auch unbeaufsichtigt zeigt tty1 den Wiederherstellungsschlüssel (nie seriell), weiter erst mit
  Block 8, dann Neustart bzw. Ausschalten per Tastendruck – auch mit `danach-aus` (wirkt erst nach der Bestätigung). Ohne Terminal
  oder bei geschlossener Eingabe wartet der Installer. Das Abbild hat keinen Schlüssel und endet von selbst.
- **Kennzeichnung:** Abschlusszeilen und -bildschirm beginnen mit „TESTINSTALLATION (CI-Testmodus …)“.
- **Secure Boot im QEMU-Test:** nur das Hauptsystem läuft mit OVMF + Secure Boot (gezielt für SEC-09, Schritt 2b; es startet
  ohne Medium von der Platte). Backupserver, Demo und Ersatz-Hauptsystem laufen wie vor 4e ohne – Backupserver und Demo prüfen
  das Startmenü der ISO mit eingelegtem Medium, das unter Secure Boot nicht funktioniert (Q-4E-60, INST-08).
  Nur im Testmodus (`SCHULOS_TESTMODUS` aus `start-installer.sh`) bietet der Installer TPM2 auch ohne Secure Boot an.
- Der Installer selbst verweigert `--unbeaufsichtigt --installieren`, `--ohne-bestaetigung`, `--abbild` und `--vorschau-verstanden`
  ohne `--testmodus` (`apps/installer/src/cli.ts`); das Einrichten eines Abbilds (`--konfigurieren`, Cloud-Init) löscht keine Platte
  und bleibt ohne.

Ohne ISO schon heute (Track B S4/S5): Stack-Test Backup (Schritte 1–3 als Compose-Stacks, CI-Job `backup`, inkl. Test-Restore mit
App-Start) und **Update-Test** `scripts/update-test.sh` (B-39, Schritt 5 ohne ISO): N−1 (neuester Release-Tag mit schulosctl, sonst
der vorige Commit) aus der lokalen Registry starten, mit `schulosctl update` auf N (signiertes Test-Release, Probelauf, Löschnachweis,
Daten erhalten, Smoketest), dann ein Release mit abstürzendem Backup-Agent → Rückweg auf N mit dem Datenstand von vorher.
Läuft vor jedem getaggten Release (`release.yml`) und von Hand (`ci.yml`, workflow_dispatch).

---

## 8. Voraussetzungen im Code

1. Postgres-Pfad in der CI testen (Integrationstests einmal gegen echtes Postgres)
2. `output: "standalone"`, Dockerfile, Migrationen beim Start, Next-Telemetrie aus
3. Konfiguration aus `/srv/schulos/config` bzw. Umgebung (`instance.type`, Pfade, SMTP)
4. Erststart-Logik: Demo-Seed **oder** leere Instanz mit Admin aus der Installer-Konfiguration
5. Hintergrundjobs im App-Prozess (Löschlauf, Backup-Status)
6. Repo auf npm-Workspaces umstellen (für die Backup-App)

---

### 8.1 Konfiguration der App (Stand B-15/B-16)

`/srv/schulos/config/schulos.env` (KEY=VALUE, schreibt der Installer) – Umgebungsvariablen haben Vorrang:

| Variable | Bedeutung |
|---|---|
| `SCHULOS_INSTANCE` | `demo` oder `production` (Pflicht im Container; ohne Angabe passiert beim Start nichts) |
| `DATABASE_URL` | `postgres://…` (ohne: PGlite unter `PGLITE_DIR`, nur für Demo/Tests) |
| `BETTER_AUTH_URL` | öffentliche Adresse (`https://…` → `Secure`-Cookies) |
| `SCHULOS_ADMIN_USERNAME`, `_FIRST_NAME`, `_LAST_NAME` | Admin-Konto beim Produktiv-Erststart |
| `SCHULOS_ADMIN_PASSWORD_HASH` | scrypt-Hash (`salt:key`, Better-Auth) – **so schreibt es der Installer**; alternativ `SCHULOS_ADMIN_PASSWORD` im Klartext (wird nach dem Erststart aus `schulos.env` entfernt, wenn die Datei beschreibbar ist, sonst Warnung) |
| `SCHULOS_SCHOOL_NAME`, `_NUMBER`, `_STATE`, `_FORM` | Schuleinstellungen beim Produktiv-Erststart |
| `SCHULOS_TEMPLATES=1` | Fächer, Zeitraster, Jahrgänge, Stundentafel als Vorlage (keine Personendaten) |
| `SCHULOS_JOBS` | Hintergrundjobs (Löschlauf 02:30, Ferienabruf 03:30): im Container automatisch an, `0` = aus |
| `SCHULOS_HOLIDAYS_URL` | andere Ferien-Quelle mit derselben Schnittstelle (Spiegel/offline), Vorgabe OpenHolidays API |
| `SCHULOS_SOURCE_URL` | Ziel des Links „Quellcode (AGPL)“ auf der Anmeldeseite und im Benutzermenü (AGPL § 13) – **Pflicht für veränderte Fassungen**: das eigene Repo (nur `https://`). Vorgabe: der Stand der laufenden Version in `schulos/schulos` |
| `SCHULOS_ISSUE_URL` | Ziel von „Problem melden“ im Benutzermenü (nur Verwaltung/Admin, nur `https://`). Vorgabe: Fehler-Formular in `schulos/schulos` mit Version und Bereich (Seitenpfad ohne IDs/Namen); ein eigener Tracker wird unverändert verlinkt. Es wird nichts automatisch gesendet |

**Backupserver (Stand B-22):** Image `docker build -f apps/backup/Dockerfile -t schulos-backup .` (aus dem Repo-Root), Port 3100,
Daten unter `/srv/schulos-backup/{db,config}`. Konfiguration `backup.env` im Config-Verzeichnis mit denselben `SCHULOS_ADMIN_*`-Variablen
wie oben (Erststart legt das Admin-Konto an, ohne sie bricht der Start ab) und `BETTER_AUTH_URL`; `secret.env` entsteht beim ersten
Start. Die Datenbank ist PGlite (nur Konten, Protokoll, Einstellungen – die Sicherungen liegen im restic-Repository). Zwei-Faktor-Anmeldung
ist für jedes Konto Pflicht; eigene Cookies (`schulos-backup.*`), damit Hauptsystem und Backupserver auf einem Host nebeneinander laufen.
Weitere Angaben (B-23): `SCHULOS_REST_DIR` (Datenordner des rest-servers mit `.htpasswd`, beide Container teilen ihn), `SCHULOS_REST_URL`
(öffentliche Adresse des rest-servers, Vorgabe `<BETTER_AUTH_URL>/restic`), `SCHULOS_TLS_CA_FILE` (CA, die das Hauptsystem pinnt – bei
Caddy `tls internal` dessen `root.crt`; ohne Angabe öffentliches Zertifikat), `SCHULOS_BACKUP_NAME` (Anzeigename), `SCHULOS_INITIAL_PAIRING_CODE` (Kopplungscode, den der Installer bzw. die CI vorgibt – wird beim
Start einmal übernommen, 24 h gültig), `SCHULOS_RETENTION` (`14/4/3`, Aufbewahrung neu gekoppelter Instanzen; über 3 Monate nur mit
`SCHULOS_RETENTION_REASON`). Im Hauptsystem erlaubt
`SCHULOS_BACKUP_ALLOW_HTTP=1` die Kopplung über http – nur für Entwicklung und Tests.

**Backupserver mit vorhandenem Docker (B-28):** `compose.backup.yaml` – `cp .env.backup.example .env.backup`,
`cp backup.env.example backup.env`, anpassen, `docker compose -f compose.backup.yaml --env-file .env.backup up -d --build`. Dienste: Caddy
(`/restic/*` → rest-server, sonst Backup-App; kopiert nur das **öffentliche** `root.crt` seiner eigenen CA in das Volume `ca` – der
PKI-Ordner mit dem privaten Schlüssel ist nur für root lesbar), Backup-App, rest-server 0.14 (`--append-only --private-repos`, uid 1000,
startet nach der App), Test-Postgres auf tmpfs. Im Hauptsystem-Stack läuft dazu der Dienst `backup-agent`. Koppeln ohne Web-UI (Installer):
`docker compose run --rm backup-agent node /opt/schulos-agent/agent.mjs koppeln https://backup.schule.de <code>`; weitere Befehle
`sichern` und `wiederherstellen`. Ende-zu-Ende geprüft von `scripts/backup-stack-test.sh` (CI-Job `backup`).

**Mit vorhandenem Docker (ohne ISO):** `compose.yaml` im Repo – `cp .env.example .env`, `cp schulos.env.example
schulos.env`, anpassen, `docker compose up -d --build`. Caddy terminiert TLS (eigene CA oder Let's Encrypt) und reicht
SSE ungepuffert durch; nur Caddy hat Ports nach außen, die Datenbank hängt in einem internen Netz. Daten liegen in
benannten Volumes (`db`, `files`, `config`) – der Installer (OPS-4) bindet sie später nach `/srv/schulos/…`.
Smoketest: `node scripts/smoke.mjs https://<adresse> [--insecure]`.

`secret.env` erzeugt die App beim ersten Start selbst (Auth-Geheimnis, 0600) – gehört ins Backup.
Ein Wechsel des Instanztyps auf einer bestehenden Datenbank bricht den Start ab (Exit 1).

---

## 9. Fahrplan (Track B, nach Gate 2)

| Block | Inhalt | Ergebnis |
|---|---|---|
| **OPS-1** Container | §8 Punkte 1–5, `compose.yaml` Hauptsystem | SchulOS läuft als Stack auf einer vorhandenen Docker-VM (erst mit funktionierender Sicherung) |
| **OPS-2** Backup | Workspaces, `schulos-backup` (Web-UI, API, rest-server append-only), backup-agent, Kopplung, Prune/Check/Test-Restore, Restore auf Hauptsystem | zwei Compose-Stacks, die sich gegenseitig sichern |
| **OPS-3** Betrieb | `schulosctl`, signierte Images, Release-Manifest + Kanäle, Update mit Probelauf und Rollback, Vorschau-Instanz, Verwaltung → System, Offline-Bundle, Offsite-Kopie, E-Mail-Alarm (§5a) | Betrieb ohne Handarbeit |
| **OPS-4** Installer | Live-ISO, TUI-Installer mit allen Fragen aus §3, `schulos-install.yaml`, Demo/Produktiv/aus Backup, btrfs + Schnappschüsse, OS-Update-Regeln, `os-upgrade`, QEMU-Tests aus §7, qcow2 | **`schulos-x.y.iso`** |

Reihenfolge mit Absicht: Erst wenn die Stacks ohne ISO stabil laufen, kommt der Installer drumherum.
Sonst wird jeder Fehler im Stack zur Fehlersuche im Installer.
