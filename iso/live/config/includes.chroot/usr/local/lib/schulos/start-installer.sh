#!/bin/bash
# SchulOS-Live-System: Installer auf tty1 (INSTALLATION.md §1–§3). Antworten vorab aus schulos-install.yaml – auf dem Startmedium
# oder auf einem zweiten Laufwerk mit der Bezeichnung SCHULOSCFG (USB-Stick, QEMU-Test) – als Vorbelegung der Oberfläche.
# INST-07: Alles Folgende (unbeaufsichtigt, Abbild, Test-Schalter) NUR im CI-Testmodus = Kernel-Parameter schulos.testmodus UND
# SCHULOSCFG; ohne Testmodus → Hinweis, dann die Oberfläche. Liegt dort zusätzlich die Datei
# „unbeaufsichtigt“ (oder steht schulos.unbeaufsichtigt in der Kernel-Zeile), läuft alles ohne Oberfläche; „danach-aus“ schaltet
# nach der Installation aus statt neu zu starten (CI). Die Datei „abbild“ (Inhalt: main oder backup) baut statt einer Installation
# das qcow2-Abbild der Rolle auf die einzige Platte (B-46, iso/build-qcow2.sh).
# Auch unbeaufsichtigt wartet tty1 am Ende auf Block 8 des Wiederherstellungsschlüssels und einen Tastendruck (INST-05). NUR für
# Tests/Labor (QEMU-CI): Datei „ohne-bestaetigung“ (bzw. schulos.ohne-bestaetigung) – dann endet der Installer ohne Bestätigung.
# INST-06: Trägt die Zielplatte schon eine fertige SchulOS-Installation, installiert der Installer unbeaufsichtigt nur mit der Datei
# „ueberschreiben“ (bzw. schulos.ueberschreiben) – sonst Code 5: Meldung auf tty1, kein Neustart, keine Neuinstallation.
set -u
# Namensauflösung über systemd-resolved: live-build hinterlässt /etc/resolv.conf als leere Datei (beim Bau geleert) – dann
# kennt glibc keinen Nameserver und die Vorab-Prüfung findet den Backupserver nie (QEMU-Test: EAI_AGAIN über 2 min)
if [ ! -L /etc/resolv.conf ]; then ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf; fi
systemctl start systemd-resolved 2>/dev/null || true
ANS=""
CFG=/run/schulos-cfg
ARGS=(--installieren)
# Entscheidung „neustart“/„aus“ aus dem interaktiven Abschluss (apps/installer/src/abschluss.ts) – nie von einem früheren Lauf
AFTER=/run/schulos-installer/danach
rm -f "$AFTER"
[ -f /run/live/medium/schulos-install.yaml ] && ANS=/run/live/medium/schulos-install.yaml
dev=$(blkid -L SCHULOSCFG 2>/dev/null || true)
if [ -n "$dev" ]; then
  mkdir -p "$CFG"
  mountpoint -q "$CFG" || mount -o ro "$dev" "$CFG"
  [ -f "$CFG/schulos-install.yaml" ] && ANS="$CFG/schulos-install.yaml"
  # INST-06: der Abschlussbildschirm sagt „Konfigurations-Stick JETZT abziehen“ – nur, wenn SCHULOSCFG nicht auf dem Datenträger
  # liegt, von dem das Live-System läuft (z. B. als zusätzliche Partition auf dem ISO-Stick): der darf erst nach dem Neustart raus
  disk_of() { local p; p=$(lsblk -dno PKNAME "$1" 2>/dev/null); if [ -n "$p" ]; then echo "$p"; else lsblk -dno KNAME "$1" 2>/dev/null; fi; }
  live=$(findmnt -no SOURCE /run/live/medium 2>/dev/null || true)
  if [ -n "$live" ] && [ "$(disk_of "$dev")" = "$(disk_of "$live")" ]; then export SCHULOS_CFG_ORT=medium; else export SCHULOS_CFG_ORT=stick; fi
fi
flag() { grep -qw "schulos.$1" /proc/cmdline || [ -f "$CFG/$1" ]; }
# Meldungen für Tests ohne Bildschirm (QEMU -serial, B-45); auf echter Hardware ohne serielle Schnittstelle folgenlos
serial() { [ -w /dev/ttyS0 ] && echo "SCHULOS-INSTALLER: $*" > /dev/ttyS0 2>/dev/null || true; }
# INST-07: Unbeaufsichtigt installieren (Platten löschen ohne Mensch davor), Abbild bauen und alle Test-Schalter gibt es nur im
# CI-Testmodus: Kernel-Parameter schulos.testmodus (setzen nur scripts/qemu-test.sh und iso/build-qcow2.sh über
# iso/testmodus-iso.sh) UND ein Laufwerk SCHULOSCFG. Der Parameter kommt nie von einer Datei – ein Stick allein reicht nicht.
TESTMODUS=0
grep -qw "schulos.testmodus" /proc/cmdline && [ -n "$dev" ] && TESTMODUS=1
test_flag() { [ "$TESTMODUS" = 1 ] && flag "$1"; }
[ -n "$ANS" ] && ARGS+=(--antworten "$ANS")
if [ "$TESTMODUS" = 1 ]; then
  ARGS+=(--testmodus)
  # Q-4E-60: im CI-Testmodus TPM2 auch ohne Secure Boot (QEMU-Backupserver prüft das Startmenü der ISO ohne Secure Boot)
  export SCHULOS_TESTMODUS=1
  [ -n "$ANS" ] && flag unbeaufsichtigt && ARGS+=(--unbeaufsichtigt)
  [[ " ${ARGS[*]} " == *" --unbeaufsichtigt "* ]] && flag ohne-bestaetigung && ARGS+=(--ohne-bestaetigung)
  flag ueberschreiben && ARGS+=(--ueberschreiben)
  # REPO-03: Vorschau-/Haftungshinweis ohne Oberfläche nur mit dieser Datei bestätigt
  flag vorschau-verstanden && ARGS+=(--vorschau-verstanden)
  [ -f "$CFG/abbild" ] && ARGS=(--abbild "$(tr -d '[:space:]' < "$CFG/abbild")" --testmodus)
elif flag unbeaufsichtigt || flag ohne-bestaetigung || flag ueberschreiben || flag seriell-geheimnisse || [ -f "$CFG/abbild" ]; then
  # Stick (bzw. Kernel-Zeile) verlangt Test-Schalter, aber kein Testmodus: nie von selbst installieren – Hinweis, dann die Oberfläche
  # (Antworten aus schulos-install.yaml dienen als Vorbelegung, gelöscht wird erst nach Zusammenfassung und Bestätigung)
  serial "kein-testmodus: unbeaufsichtigt nur im CI-Testmodus – Oberfläche"
  clear
  echo
  echo "  Hinweis: Auf dem Laufwerk SCHULOSCFG liegen Schalter für eine unbeaufsichtigte Installation."
  echo "  Die gibt es nur im CI-Testmodus (automatische Tests der Entwicklung) – hier wird nichts ohne Rückfrage gelöscht."
  echo "  Der Installer startet mit Oberfläche; die Antworten aus schulos-install.yaml sind vorbelegt."
  echo
  read -r -t 60 -p "  Enter = weiter " _ || true
fi

# NUR Test (QEMU, Datei „seriell-geheimnisse“): der Installer gibt den Schlüssel auch unbeaufsichtigt mit Bestätigung zusätzlich
# auf stdout aus (sonst nur tty1) – der QEMU-Test tippt damit Block 8 per Tastatur ein (GATE-4f C-12)
test_flag seriell-geheimnisse && export SCHULOS_SERIELL_GEHEIMNISSE=1
serial "start ${ARGS[*]}"

# Geheimnisse (Wiederherstellungsschlüssel, Kopplungscode) für die serielle Schnittstelle schwärzen – auf echter Hardware ist das
# oft Serial-over-LAN des BMC (mitprotokolliert). Nur der QEMU-Test (Datei „seriell-geheimnisse“) braucht sie dort im Klartext.
redact() {
  if test_flag seriell-geheimnisse; then cat; return; fi
  awk '{
    if (key && NF) { print "    (nur auf dem Bildschirm)"; key = 0 }
    else if (/Kopplungscode für das Hauptsystem/) { sub(/: [0-9A-Za-z-]+[ \t]*$/, ": (nur auf dem Bildschirm)"); print }
    else if (/Bootmenü-Passwort \(GRUB/) { sub(/\): .*$/, "): (nur auf dem Bildschirm)"); print }
    else { if (/WIEDERHERSTELLUNGSSCHL/) key = 1; print }
    fflush()
  }'
}

clear
if [[ " ${ARGS[*]} " == *" --unbeaufsichtigt "* || " ${ARGS[*]} " == *" --abbild "* ]] && [ -w /dev/ttyS0 ]; then
  # ohne Oberfläche: Fortschritt auch auf die serielle Schnittstelle (Tests ohne Bildschirm), Geheimnisse dort geschwärzt
  # Herzschlag: jede Minute die letzte Zeile des Installationsprotokolls (sieht man, wo es hängt)
  ( while sleep 60; do serial "läuft: $(tail -n 1 /run/schulos-installer/installation.log 2>/dev/null | cut -c1-200)"; done ) &
  beat=$!
  exec 3>&1
  /usr/local/bin/schulos-installer "${ARGS[@]}" 2>&1 | tee /dev/fd/3 | redact > /dev/ttyS0
  rc=${PIPESTATUS[0]}
  exec 3>&-
  kill $beat 2>/dev/null
else
  /usr/local/bin/schulos-installer "${ARGS[@]}"
  rc=$?
fi
serial "ende rc=$rc"
if [ $rc -ne 0 ] && [ -f /run/schulos-installer/installation.log ] && [ -w /dev/ttyS0 ]; then tail -n 40 /run/schulos-installer/installation.log > /dev/ttyS0; fi
if [ $rc -eq 0 ]; then
  flag danach-aus && exec systemctl poweroff
  # interaktiv (INST-01): der Installer hat Schlüssel bestätigen lassen, die Startreihenfolge gesetzt und gefragt – kein
  # „Medium entfernen“, solange das Live-System davon läuft (squashfs unter /run/live/medium → I/O-Fehler); nur ein eigener
  # SCHULOSCFG-Stick wird vorher ausgehängt und abgezogen (INST-06)
  case "$(cat "$AFTER" 2>/dev/null)" in
    aus) exec systemctl poweroff ;;
    neustart) exec systemctl reboot ;;
  esac
  echo
  if [[ " ${ARGS[*]} " == *" --ohne-bestaetigung "* || " ${ARGS[*]} " == *" --abbild "* ]]; then
    # nur Test/Labor bzw. Abbild (ohne Schlüssel): von selbst weiter – sonst hat der Installer nach der Bestätigung entschieden
    echo "Fertig. Neustart in 30 Sekunden (Strg+C bricht ab)."
    sleep 30 && exec systemctl reboot
  else
    # interaktiv ohne Entscheidung (darf nach INST-05 nicht mehr vorkommen): nie von selbst neu starten – der Schlüssel bleibt stehen
    echo "Installer ohne Abschluss beendet – Wiederherstellungsschlüssel (falls oben angezeigt) jetzt abschreiben."
    echo "Das Startmedium erst bei ausgeschaltetem Rechner entfernen (das Live-System läuft davon)."
    while :; do read -r -p "a + Enter = ausschalten · n + Enter = neu starten: " x || sleep 3600
      case "$x" in a|A) exec systemctl poweroff ;; n|N) exec systemctl reboot ;; esac; done
  fi
elif [ $rc -eq 5 ]; then
  # INST-06: Zielplatte mit fertiger SchulOS-Installation, keine Zustimmung (Meldung des Installers steht darüber) – nichts
  # verändert; nie von selbst neu starten (der Stick steckt evtl. noch → wieder hier) und nie von selbst neu installieren
  echo
  echo "Nicht installiert: Auf der Zielplatte ist bereits SchulOS installiert (siehe oben) – es wurde nichts verändert."
  # vor dem Aushängen lesen: „danach-aus“ liegt auf genau diesem Stick
  aus=0; flag danach-aus && aus=1
  if [ "${SCHULOS_CFG_ORT:-}" = stick ]; then
    umount -l "$CFG" 2>/dev/null
    echo "Konfigurations-Stick (SCHULOSCFG) JETZT abziehen, dann n = neu starten: das installierte SchulOS startet von der Festplatte"
    echo "(das Installationsmedium kann dabei eingelegt bleiben)."
  elif [ "${SCHULOS_CFG_ORT:-}" = medium ]; then
    echo "SCHULOSCFG liegt auf dem Installationsmedium: a = ausschalten, dann das Medium entfernen und wieder einschalten."
  fi
  [ "$aus" = 1 ] && exec systemctl poweroff
  while :; do read -r -p "n + Enter = neu starten · a + Enter = ausschalten · i + Enter = Installer neu starten: " x || sleep 3600
    case "$x" in n|N) exec systemctl reboot ;; a|A) exec systemctl poweroff ;; i|I) exec "$0" ;; esac; done
else
  echo
  echo "Installer beendet (Code $rc). Protokoll: /run/schulos-installer/installation.log · Konsole: Alt+F2"
  flag danach-aus && exec systemctl poweroff
  read -r -p "Enter = Installer neu starten "
  exec "$0"
fi
