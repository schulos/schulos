#!/usr/bin/env bash
# QEMU-Tests der ISO (B-45, INSTALLATION.md §7) – auf einem Linux-Rechner mit KVM und sudo (CI: Workflow iso.yml):
#   0. INST-07: die ISO selbst mit Stick „unbeaufsichtigt“ installiert nicht (kein schulos.testmodus) – danach läuft alles mit
#      der Test-Kopie aus iso/testmodus-iso.sh (Kernel-Parameter schulos.testmodus; Datei „vorschau-verstanden“ für REPO-03)
#   1. Backupserver unbeaufsichtigt installieren (zwei Platten gespiegelt, LUKS mit TPM2 über swtpm), Kopplungscode übernehmen
#   2. Hauptsystem (Produktiv) installieren und dabei koppeln → /api/health, Anmeldung mit dem Installer-Admin, Datenbank leer
#      bis auf das Admin-Konto
#   3. Sicherung → Test-Restore mit App-Start grün
#   4. Hauptsystem (Demo) installieren → Playwright-Suite `@iso` (e2e/iso-demo.spec.ts) gegen die VM
#   6. neues Hauptsystem „aus Backup wiederherstellen“ (Ersatz-Kopplungscode über cli.mjs) → Daten wie vorher
# Netz: Bridge 192.168.250.0/24 mit dnsmasq (DHCP fürs Live-System, Namen backup/schulos/demo.schulos.test). Kein Internet nötig
# (außer einmal für die Playwright-Browser).
# INST-05/GATE-4f: Backupserver (Spiegel) startet danach mit weiter eingelegtem Medium – das Startmenü der ISO muss die fertige
# Installation erkennen (Markierung, mdraid1x) und von der Platte starten; das Demo-System endet ohne Test-Schalter
# „ohne-bestaetigung“: Block 8 des Wiederherstellungsschlüssels wird über den QEMU-Monitor (sendkey) auf tty1 eingetippt.
# INST-06: danach startet die Demo mit Medium und SCHULOSCFG-Stick neu – der Installer muss die fertige Installation schützen.
# Noch nicht hier: §7 Schritt 5 (Update N−1 → N, läuft ohne ISO in scripts/update-test.sh).
# Mit --qcow2 stattdessen die Abbilder (B-46): beide aus der ISO bauen (iso/build-qcow2.sh), Backupserver und Hauptsystem daraus
# mit Cloud-Init-Laufwerk (NoCloud) starten – eingerichtet, Wurzel gewachsen, gekoppelt, Sicherung + Test-Restore.
#   bash scripts/qemu-test.sh <schulos.iso> [arbeitsordner] [--qcow2]
set -euo pipefail
# als root (privilegierter Container) ohne sudo; ohne KVM mit TCG (sehr langsam – nur zum Zusehen/Fehlersuchen)
if [ "$(id -u)" = 0 ] && ! command -v sudo >/dev/null; then sudo() { env "$@"; }; fi
ACCEL=${QEMU_ACCEL:-kvm}
ISO=$(readlink -f "$1")
W=${2:-$(mktemp -d)}
MODE=iso
[ "${3:-}" = --qcow2 ] && MODE=qcow2
mkdir -p "$W"
BR=br-schulos
PIDS=()
log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() {
  log "FEHLER: $*"
  for f in "$W"/*.serial; do echo "--- $f (Ende)"; tail -n 60 "$f" || true; done
  # laufende Maschinen: Erststart-Protokoll und Container (Ursache z. B. einer gescheiterten Kopplung)
  if [ -n "${SSH:-}" ]; then
    for ip in 192.168.250.2 192.168.250.3 192.168.250.4; do
      echo "--- $ip: /var/log/schulos-erststart.log (Ende) und Container"
      timeout 30 "${SSH[@]}" "schulos-admin@$ip" "echo '$WPW' | sudo -S -p '' sh -c 'tail -n 50 /var/log/schulos-erststart.log; docker ps -a --format \"{{.Names}} {{.Status}}\"'" 2>&1 || true
    done
  fi
  # Fehlersuche von Hand: VMs laufen lassen (QEMU_HALTEN=<sekunden>), Zugang: ssh -i $W/id schulos-admin@192.168.250.x
  if [ -n "${QEMU_HALTEN:-}" ]; then log "VMs bleiben $QEMU_HALTEN s an (ssh -i $W/id schulos-admin@192.168.250.2/.3)"; sleep "$QEMU_HALTEN"; fi
  exit 1
}
cleanup() {
  for p in "${PIDS[@]:-}"; do sudo kill "$p" 2>/dev/null || true; done
  sudo pkill -f "dnsmasq --conf-file=$W/dnsmasq.conf" 2>/dev/null || true
  sudo ip link del "$BR" 2>/dev/null || true
  for t in tap-backup tap-main tap-demo tap-neu tap-ohne-test; do sudo ip link del "$t" 2>/dev/null || true; done
  while sudo iptables -D FORWARD -i "$BR" -o "$BR" -j ACCEPT 2>/dev/null; do :; done
  for f in "$W"/*-tpm.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
}
trap cleanup EXIT
# unerwartete Abbrüche (set -e) nicht stumm: Zeile und Befehl ausgeben
trap 'log "ABBRUCH in Zeile $LINENO: $BASH_COMMAND"' ERR

log "Werkzeuge"
sudo apt-get update -qq
export USER=${USER:-$(id -un)}
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools dnsmasq-base mtools dosfstools openssh-client iproute2 curl socat xorriso >/dev/null
if [ "$ACCEL" = kvm ]; then [ -w /dev/kvm ] || sudo chmod 666 /dev/kvm; fi

log "Netz $BR 192.168.250.1/24 mit dnsmasq"
# Reste eines abgebrochenen Laufs (Build-VM läuft dauerhaft)
sudo pkill -f "dnsmasq --conf-file=.*/dnsmasq.conf" 2>/dev/null || true
sudo ip link del "$BR" 2>/dev/null || true
for t in tap-backup tap-main tap-demo tap-neu; do sudo ip link del "$t" 2>/dev/null || true; done
pkill -f "swtpm socket" 2>/dev/null || true
case "$W" in */qemu|/tmp/*) rm -rf "$W"; mkdir -p "$W" ;; *) [ -z "$(ls -A "$W")" ] || { echo "Arbeitsordner $W nicht leer – bitte einen leeren oder …/qemu angeben" >&2; exit 1; } ;; esac
sudo ip link add "$BR" type bridge
sudo ip addr add 192.168.250.1/24 dev "$BR"
sudo ip link set "$BR" up
# Docker lädt br_netfilter und setzt FORWARD auf DROP – dann verwirft der Host den Verkehr zwischen den VMs auf der Bridge
# (Build-VM); ausdrücklich erlauben, beim Aufräumen wieder entfernen
while sudo iptables -D FORWARD -i "$BR" -o "$BR" -j ACCEPT 2>/dev/null; do :; done
sudo iptables -I FORWARD 1 -i "$BR" -o "$BR" -j ACCEPT 2>/dev/null || true
cat >"$W/dnsmasq.conf" <<EOF
interface=$BR
bind-interfaces
no-resolv
# zuständig für schulos.test + host-record: AAAA bekommt „keine Daten“ (NOERROR) – mit address= käme REFUSED bzw. mit local= NXDOMAIN; musl (Alpine-Images)
# fragt A und AAAA zugleich und meldet bei REFUSED EAI_AGAIN, bei NXDOMAIN ENOTFOUND – dann scheitert die Kopplung im Agent
local=/schulos.test/
dhcp-range=192.168.250.100,192.168.250.150,1h
host-record=backup.schulos.test,192.168.250.2
host-record=schulos.schulos.test,192.168.250.3
host-record=demo.schulos.test,192.168.250.4
EOF
sudo dnsmasq --conf-file="$W/dnsmasq.conf" --pid-file="$W/dnsmasq.pid"
# SEC-09: Secure Boot (OVMF mit Microsoft-Schlüsseln, SMM) für das Hauptsystem – gezielt für Schritt 2b (TPM2 an PCR 7+8+9,
# Neu-Binden nach Initramfs-Update); es startet nach der Installation ohne Medium von der Platte. INST-08: auch der
# Backupserver (Spiegel) – er startet mit eingelegtem Medium, das Startmenü der ISO muss die Installation unter Secure Boot
# erkennen (Markierung auf der EFI-Partition) und den shim der Platte starten (Q-4E-60). Demo (Überschreibschutz, Installer
# mit Medium) und Ersatz-Hauptsystem (Schritt 6) wie vor 4e ohne Secure Boot. Ohne Secure Boot erlaubt der Installer TPM2
# nur im CI-Testmodus.
OVMF_CODE=${OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.secboot.fd}
OVMF_VARS=${OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.ms.fd}
OVMF_CODE_PLAIN=${OVMF_CODE_PLAIN:-/usr/share/OVMF/OVMF_CODE_4M.fd}
OVMF_VARS_PLAIN=${OVMF_VARS_PLAIN:-/usr/share/OVMF/OVMF_VARS_4M.fd}
[ -f "$OVMF_CODE" ] && [ -f "$OVMF_VARS" ] || fail "OVMF mit Secure Boot fehlt ($OVMF_CODE, $OVMF_VARS)"
secure_boot_for() { [ "$1" = main ] || [ "$1" = backup ]; }
ssh-keygen -q -t ed25519 -N "" -f "$W/id" <<<y >/dev/null
PUB=$(cat "$W/id.pub")
SSH=(ssh -i "$W/id" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR)
WPW='Wartung-im-Keller-2026'
APW='Lange-Leitung-Kaffee-42'

# Antworten-Laufwerk SCHULOSCFG (wie ein zweiter USB-Stick): schulos-install.yaml + unbeaufsichtigt + danach-aus
# + seriell-geheimnisse (Kopplungscode und Wiederherstellungsschlüssel ungeschwärzt auf ttyS0 – nur für diesen Test)
# + ohne-bestaetigung (Ende ohne Bestätigung von Block 8 – nur für Tests)
cfgdisk() { # <name> <yaml> [bestaetigen]
  local img="$W/$1-cfg.img"
  rm -f "$img"
  mkfs.vfat -n SCHULOSCFG -C "$img" 4096 >/dev/null
  printf '%s\n' "$2" >"$W/$1.yaml"
  : >"$W/leer"
  mcopy -i "$img" "$W/$1.yaml" ::schulos-install.yaml
  mcopy -i "$img" "$W/leer" ::unbeaufsichtigt
  mcopy -i "$img" "$W/leer" ::seriell-geheimnisse
  # REPO-03: Vorschau-/Haftungshinweis ohne Oberfläche bestätigt (wirkt nur im Testmodus)
  mcopy -i "$img" "$W/leer" ::vorschau-verstanden
  # „bestaetigen“ (GATE-4f C-12): Ende wie im Betrieb – Block 8 an der Konsole, Entscheidung über die Datei „danach“
  if [ "${3:-}" != bestaetigen ]; then
    mcopy -i "$img" "$W/leer" ::danach-aus
    # NUR Test (INST-05): sonst wartet auch unbeaufsichtigt tty1 auf Block 8 des Wiederherstellungsschlüssels
    mcopy -i "$img" "$W/leer" ::ohne-bestaetigung
  fi
  echo "$img"
}

tpm() { # <name> – swtpm je Maschine (Zustand bleibt zwischen den Starts erhalten)
  mkdir -p "$W/$1-tpm"
  # der swtpm des vorigen Starts läuft womöglich noch (hält die Sperre auf den Zustand) – erst beenden
  if [ -f "$W/$1-tpm.pid" ]; then kill "$(cat "$W/$1-tpm.pid")" 2>/dev/null || true; sleep 1; fi
  rm -f "$W/$1-tpm/sock"
  swtpm socket --tpmstate dir="$W/$1-tpm" --ctrl type=unixio,path="$W/$1-tpm/sock" --tpm2 --daemon --terminate --pid file="$W/$1-tpm.pid"
  for _ in $(seq 1 50); do [ -S "$W/$1-tpm/sock" ] && return; sleep 0.1; done
  fail "swtpm $1"
}

# vm <name> <mac> <iso|platte|platte+iso> [cfg-img] – startet im Hintergrund, serielle Ausgabe nach $W/<name>.serial, Monitor
# (Tastatur per sendkey) unter $W/<name>.mon; „platte+iso“: installierte Platte, das Medium bleibt eingelegt und kommt zuerst dran
vm() {
  local name=$1 mac=$2 mode=$3 cfg=${4:-}
  local tap="tap-$name"
  sudo ip tuntap add "$tap" mode tap user "$USER" 2>/dev/null || true
  sudo ip link set "$tap" master "$BR" up
  local code=$OVMF_CODE vars=$OVMF_VARS
  secure_boot_for "$name" || { code=$OVMF_CODE_PLAIN; vars=$OVMF_VARS_PLAIN; }
  [ -f "$W/$name-vars.fd" ] || cp "$vars" "$W/$name-vars.fd"
  tpm "$name"
  # Speicher: Backupserver 2 GB, Hauptsysteme je 3 GB; in Schritt 4 laufen drei VMs (8 GB) – auf der Build-VM (12 GB) ok, auf dem
  # GitHub-Runner (7 GB) knapp (das alte Hauptsystem ist aus, wenn „neu“ läuft)
  local mem=3072
  [ "$name" = backup ] && mem=2048
  local cpu=host
  [ "$ACCEL" = kvm ] || cpu=max
  local machine=(-machine q35,smm=on,accel="$ACCEL" -global driver=cfi.pflash01,property=secure,value=on)
  secure_boot_for "$name" || machine=(-machine q35,accel="$ACCEL")
  local args=("${machine[@]}" -cpu "$cpu" -m "$mem" -smp 2
    -drive if=pflash,format=raw,readonly=on,file="$code"
    -drive if=pflash,format=raw,file="$W/$name-vars.fd"
    -chardev socket,id=chrtpm,path="$W/$name-tpm/sock" -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0
    -netdev tap,id=n0,ifname="$tap",script=no,downscript=no -device virtio-net-pci,netdev=n0,mac="$mac"
    -display none -serial file:"$W/$name.serial" -monitor unix:"$W/$name.mon",server,nowait -no-reboot)
  # detect-zeroes=unmap: mdadm synchronisiert einen neuen Spiegel komplett (liest Nullen, schreibt Nullen) – ohne das würde
  # jede qcow2-Datei auf volle Größe wachsen und die Platte des Runners volllaufen (Abbruch „No space left on device“)
  # platte+iso: die Platten brauchen einen bootindex hinter dem Medium – gibt QEMU eine Startreihenfolge vor, verbindet OVMF nur
  # die dort genannten Geräte; ohne ihn sähe die GRUB des Mediums die Platten (und /grub/schulos-installiert) gar nicht
  local i=0 di
  for d in "$W/$name"-disk*.qcow2; do
    i=$((i + 1))
    if [ "$mode" = platte+iso ]; then
      di="disk$i"
      args+=(-drive if=none,id="$di",file="$d",format=qcow2,discard=unmap,detect-zeroes=unmap -device virtio-blk-pci,drive="$di",bootindex="$i")
    else
      args+=(-drive file="$d",if=virtio,format=qcow2,discard=unmap,detect-zeroes=unmap)
    fi
  done
  if [ "$mode" = iso ]; then args+=(-drive file="$ISO",media=cdrom,readonly=on -boot d); fi
  # Medium als erstes Startgerät (bootindex → Startreihenfolge von OVMF über fw_cfg, vor den NVRAM-Einträgen)
  if [ "$mode" = platte+iso ]; then args+=(-drive if=none,id=cd0,file="$ISO",media=cdrom,readonly=on -device ide-cd,drive=cd0,bootindex=0); fi
  # platte+iso: auch das Antworten-Laufwerk braucht einen bootindex, sonst verbindet OVMF es nicht und die GRUB des Mediums sieht
  # SCHULOSCFG nicht (dann startete sie die Platte statt des Installers – INST-06 Schritt 4b)
  if [ -n "$cfg" ] && [ "$mode" = platte+iso ]; then
    args+=(-drive if=none,id=cfg0,file="$cfg",format=raw,readonly=on -device virtio-blk-pci,drive=cfg0,bootindex=$((i + 1)))
  elif [ -n "$cfg" ]; then
    args+=(-drive file="$cfg",if=virtio,format=raw,readonly=on)
  fi
  : >"$W/$name.serial"
  # nice: der Runner hat nur 2 Kerne – sein Agent darf nicht verhungern (sonst bricht GitHub den Job ab)
  nice -n 15 qemu-system-x86_64 "${args[@]}" &
  PIDS+=($!)
  echo $! >"$W/$name.pid"
}
wait_exit() { # <name> <sekunden> – zeigt dabei neue Installer-Meldungen (Herzschlag) im Protokoll
  local pid seen=0 n; pid=$(cat "$W/$1.pid")
  for i in $(seq 1 "$2"); do
    kill -0 "$pid" 2>/dev/null || return 0
    if [ $((i % 30)) = 0 ]; then
      n=$(grep -ac "SCHULOS-INSTALLER" "$W/$1.serial" || true)
      if [ "$n" -gt "$seen" ]; then grep -a "SCHULOS-INSTALLER" "$W/$1.serial" | tail -n $((n - seen)) | cut -c1-200 | sed "s/^/  [$1] /"; seen=$n; fi
    fi
    if [ $((i % 300)) = 0 ]; then echo "  [$1] frei: $(df -h --output=avail "$W" | tail -n 1 | tr -d ' '), VM-Platten: $(du -ch "$W/$1"-disk*.qcow2 | tail -n 1 | cut -f1)"; fi
    sleep 1
  done
  fail "$1 nicht in $2 s fertig"
}
# Startfehler früh erkennen statt die ganze Frist abzuwarten (Notfallmodus, Kernel-Panik, Passphrase-Abfrage ohne Eingabe)
BOOT_FAIL='emergency mode|Kernel panic|Please enter passphrase|Please enter recovery key|Give root password|Failed to start .*Cryptography|Timed out waiting for device|Enter username:'
boot_failed() { grep -aqE "$BOOT_FAIL" "$W"/*.serial 2>/dev/null; }
wait_for() { # <beschreibung> <sekunden> <befehl…>
  local what=$1 secs=$2; shift 2
  for _ in $(seq 1 $((secs / 5))); do
    "$@" >/dev/null 2>&1 && return 0
    if boot_failed; then grep -ahE "$BOOT_FAIL" "$W"/*.serial | head -n 5; fail "$what: Startfehler"; fi
    sleep 5
  done
  fail "$what (nach $secs s)"
}
keys() { # <name> <text> – tippt auf tty1 (QEMU-Monitor sendkey), danach Enter; nur a–z, A–Z (Umschalt) und 0–9
  local name=$1 text=$2 i c
  for ((i = 0; i < ${#text}; i++)); do
    c=${text:i:1}
    [[ $c == [[:upper:]] ]] && c="shift-${c,,}"
    echo "sendkey $c" | socat - UNIX-CONNECT:"$W/$name.mon" >/dev/null
    sleep 0.2
  done
  echo "sendkey ret" | socat - UNIX-CONNECT:"$W/$name.mon" >/dev/null
}
confirm_at_console() { # <name> – INST-05 ohne Test-Schalter: Block 8 eintippen, Bootmenü-Passwort (INST-12), dann „a“ (ausschalten)
  local name=$1 pid key grubpw
  pid=$(cat "$W/$name.pid")
  log "$name: warte auf die Bestätigung an der Konsole (tty1)"
  for _ in $(seq 1 3600); do
    grep -aq "Warte an der Konsole (tty1)" "$W/$name.serial" && break
    grep -aq "SCHULOS-INSTALLER: ende" "$W/$name.serial" && fail "$name: Installer ohne Bestätigung beendet (INST-05)"
    kill -0 "$pid" 2>/dev/null || fail "$name: VM ohne Bestätigung beendet (INST-05)"
    sleep 1
  done
  grep -aq "Warte an der Konsole (tty1)" "$W/$name.serial" || fail "$name: keine Bestätigung an der Konsole angefordert"
  key=$(grep -aoE '[cbdefghijklnrtuv]{8}(-[cbdefghijklnrtuv]{8}){7}' "$W/$name.serial" | tail -n1 || true)
  [ -n "$key" ] || fail "$name: Wiederherstellungsschlüssel nicht auf der seriellen Schnittstelle (seriell-geheimnisse)"
  # ohne Eingabe geht es nicht weiter: kein Neustart, kein Ausschalten
  sleep 20
  kill -0 "$pid" 2>/dev/null || fail "$name: ohne Bestätigung beendet (INST-05)"
  grep -aq "SCHULOS-INSTALLER: ende" "$W/$name.serial" && fail "$name: Installer vor der Bestätigung beendet"
  keys "$name" "${key##*-}"
  sleep 5
  # INST-12: Bootmenü-Passwort eigens bestätigen – letzte 4 Zeichen (steht mit seriell-geheimnisse im Klartext auf der Schnittstelle)
  grubpw=$(grep -aoE 'Bootmenü-Passwort \(GRUB, Benutzer schulos\): [A-Za-z0-9 ]+' "$W/$name.serial" | tail -n1 | sed 's/.*): //; s/ //g' || true)
  if [ -n "$grubpw" ]; then
    keys "$name" "${grubpw: -4}"
    sleep 5
  fi
  keys "$name" a
  # sendkey verliert gelegentlich das Enter nach „a“ (Nachstellung auf der Build-VM: „a“ steht in der Zeile, die VM wartet) –
  # dann Enter nachschicken, bis sie aus ist
  for _ in 1 2 3; do
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
    log "$name: noch an – Enter erneut"
    echo "sendkey ret" | socat - UNIX-CONNECT:"$W/$name.mon" >/dev/null
  done
}
install() { # <name> <mac> <yaml> <plattenzahl> [bestaetigen] [platte+iso]
  local name=$1
  for i in $(seq 1 "$4"); do qemu-img create -q -f qcow2 "$W/$name-disk$i.qcow2" 40G; done
  log "$name: Installation aus der ISO (unbeaufsichtigt${5:+, Bestätigung an der Konsole})"
  vm "$name" "$2" iso "$(cfgdisk "$name" "$3" "${5:-}")"
  if [ "${5:-}" = bestaetigen ]; then confirm_at_console "$name"; fi
  wait_exit "$name" 3600
  grep -q "SCHULOS-INSTALLER: ende rc=0" "$W/$name.serial" || fail "$name: Installer nicht erfolgreich"
  grep -q "WIEDERHERSTELLUNGSSCHLÜSSEL" "$W/$name.serial" || fail "$name: kein Wiederherstellungsschlüssel (TPM2) angezeigt"
  # Ausgabe der Installation aufheben – der Start von der Platte beginnt eine neue serielle Datei
  cp "$W/$name.serial" "$W/$name-install.serial"
  if [ "${6:-}" = platte+iso ]; then
    log "$name: installiert, Medium bleibt eingelegt – das Startmenü der ISO muss die Platte starten (Markierung, Spiegel)"
    vm "$name" "$2" platte+iso
  else
    log "$name: installiert, starte von der Platte (TPM2 entsperrt ohne Eingabe)"
    vm "$name" "$2" platte
  fi
}
# INST-06: Medium UND SCHULOSCFG-Stick stecken noch, die Firmware startet vom Medium → das Startmenü wählt (Stick) den Installer,
# der erkennt die fertige Installation (Markierung) und bricht ohne Schalter „ueberschreiben“ ab: nichts gelöscht, Meldung,
# ausgeschaltet über danach-aus – kein Neustart-Kreislauf
reinstall_refused() { # <name> <mac> <yaml>
  local name=$1
  log "$name: Neustart mit eingelegtem Medium und SCHULOSCFG-Stick – Überschreibschutz"
  vm "$name" "$2" platte+iso "$(cfgdisk "$name-erneut" "$3")"
  wait_exit "$name" 900
  grep -aq "SCHULOS-INSTALLER: ende rc=5" "$W/$name.serial" || fail "$name: fertige Installation nicht geschützt (erwartet Installer-Code 5)"
  grep -aq "bereits SchulOS installiert" "$W/$name.serial" || fail "$name: keine Meldung zum Überschreibschutz"
  if grep -aq "Installation läuft" "$W/$name.serial"; then fail "$name: Installation trotz Markierung begonnen"; fi
}
# GATE-4f C-03/C-04: im Startmenü der ISO „Von der Festplatte starten“ erkannt und gewählt (nicht wieder der Installer)
iso_bootet_platte() { # <name>
  grep -aq "Von der Festplatte starten" "$W/$1.serial" || fail "$1: Startmenü der ISO bot die Platte nicht an (Markierung auf der EFI-Partition, INST-08)"
  if grep -aq "SCHULOS-INSTALLER: start" "$W/$1.serial"; then fail "$1: mit eingelegtem Medium wieder im Installer gelandet"; fi
}
https_ok() { curl -skf --resolve "$1:443:$2" "https://$1$3"; }
on() { local ip=$1; shift; "${SSH[@]}" "schulos-admin@$ip" "$@"; }
sudo_on() { local ip=$1; shift; "${SSH[@]}" "schulos-admin@$ip" "echo '$WPW' | sudo -S -p '' $*"; }
erststart_fertig() { [ "$(on "$1" cat /run/schulos-erststart.status 2>/dev/null)" = fertig ]; }

common() { # <hostname> <ip>
  cat <<EOF
network: {hostname: $1, mode: static, address: $2/24, gateway: 192.168.250.1, dns: [192.168.250.1], internal_nets: [192.168.250.0/24]}
access: {password: $WPW, ssh: true, ssh_keys: ["$PUB"], console: serial}
admin: {first_name: Ina, last_name: Tech, username: ina.tech, password: $APW}
EOF
}

if [ "$MODE" = qcow2 ]; then
  # ---------- qcow2 (B-46): Abbilder bauen, Backupserver + Hauptsystem daraus, koppeln, sichern ----------
  log "Abbilder aus der ISO bauen"
  bash "$(dirname "$0")/../iso/build-qcow2.sh" "$ISO" "$W/abbild" main backup
  cidata() { # <name> <yaml> – NoCloud-Laufwerk wie von Proxmox (cidata, user-data + meta-data)
    local img="$W/$1-cidata.img"
    rm -f "$img"
    mkfs.vfat -n CIDATA -C "$img" 1024 >/dev/null
    printf '%s\n' "#cloud-config – SchulOS liest daraus schulos-install.yaml" "$2" >"$W/$1-user-data"
    printf 'instance-id: %s\n' "$1" >"$W/$1-meta-data"
    mcopy -i "$img" "$W/$1-user-data" ::user-data
    mcopy -i "$img" "$W/$1-meta-data" ::meta-data
    echo "$img"
  }
  from_image() { # <name> <mac> <abbild> <yaml> – VM-Platte 48 GB über dem Abbild (32 GB): die Wurzel muss wachsen
    local name=$1
    qemu-img create -q -f qcow2 -b "$3" -F qcow2 "$W/$name-disk1.qcow2" 48G
    log "$name: Start aus $(basename "$3") mit Cloud-Init-Laufwerk"
    vm "$name" "$2" platte "$(cidata "$name" "$4")"
  }
  eingerichtet() { grep -aq "SCHULOS-EINRICHTUNG: ende rc=0" "$W/$1.serial"; }
  root_gb() { on "$1" df -BG --output=size / | tail -n1 | tr -dc 0-9; }
  VER=$(basename "$ISO" .iso | sed 's/^schulos-//')

  from_image backup 52:54:00:00:00:02 "$W/abbild/schulos-$VER-backupserver.qcow2" "role: backup
$(common schulos-backup 192.168.250.2)
web: {domain: backup.schulos.test}"
  wait_for "Backupserver eingerichtet" 600 eingerichtet backup
  wait_for "Backupserver erreichbar" 900 https_ok backup.schulos.test 192.168.250.2 /api/health
  wait_for "Backupserver Erststart" 300 erststart_fertig 192.168.250.2
  [ "$(on 192.168.250.2 hostname)" = schulos-backup ] || fail "Hostname nicht aus der Antwortdatei"
  [ "$(root_gb 192.168.250.2)" -ge 45 ] || fail "Wurzel nicht gewachsen: $(root_gb 192.168.250.2) GB"
  sudo_on 192.168.250.2 cryptsetup status schulos-root >/dev/null 2>&1 && fail "Abbild unerwartet verschlüsselt"
  CODE=$(sudo_on 192.168.250.2 cat /run/schulos-kopplungscode)
  echo "$CODE" | grep -Eq '^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$' || fail "Kopplungscode für die Konsole: $CODE"
  log "Q1 ✓ Backupserver aus dem Abbild: eingerichtet, Wurzel $(root_gb 192.168.250.2) GB, Kopplungscode $CODE"

  from_image main 52:54:00:00:00:03 "$W/abbild/schulos-$VER-hauptsystem.qcow2" "role: main
instance: production
$(common schulos 192.168.250.3)
school: {name: QEMU-Gesamtschule, number: '123456'}
web: {domain: schulos.schulos.test}
backup: {mode: pair, url: 'https://backup.schulos.test', code: $CODE}"
  wait_for "Hauptsystem eingerichtet" 600 eingerichtet main
  wait_for "Hauptsystem erreichbar" 900 https_ok schulos.schulos.test 192.168.250.3 /api/health
  wait_for "Hauptsystem Erststart" 600 erststart_fertig 192.168.250.3
  [ "$(on 192.168.250.3 cat /etc/machine-id)" != "$(on 192.168.250.2 cat /etc/machine-id)" ] || fail "gleiche machine-id"
  INFO=$(sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T app node cli.mjs info)
  echo "$INFO" | grep -q '"instance":"production"' || fail "kein Produktivsystem: $INFO"
  LOGIN=$(curl -sk --resolve schulos.schulos.test:443:192.168.250.3 -H 'content-type: application/json' -H 'origin: https://schulos.schulos.test' \
    -d "{\"username\":\"ina.tech\",\"password\":\"$APW\"}" -o /dev/null -w '%{http_code}' https://schulos.schulos.test/api/auth/sign-in/username)
  [ "$LOGIN" = 200 ] || fail "Anmeldung mit dem Admin aus der Antwortdatei ($LOGIN)"
  sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T backup-agent test -f /srv/schulos/config/backup-pairing.json || fail "nicht gekoppelt"
  log "Q2 ✓ Hauptsystem aus dem Abbild: health, Anmeldung, gekoppelt"
  sudo_on 192.168.250.3 schulosctl backup now || fail "Sicherung"
  sudo_on 192.168.250.3 schulosctl test-restore || fail "Test-Restore mit App-Start"
  log "Q3 ✓ gesichert, Test-Restore mit App-Start grün"
  log "QEMU-Test qcow2 bestanden (Abbilder unter $W/abbild)"
  exit 0
fi

# ---------- 0. INST-07: Stick ohne Testmodus installiert nie ----------
# Release-ISO (ohne schulos.testmodus) + SCHULOSCFG mit „unbeaufsichtigt“: Hinweis, dann die Oberfläche – keine Installation.
# Alle weiteren Schritte laufen mit der Test-Kopie der ISO (iso/testmodus-iso.sh: Kernel-Parameter schulos.testmodus).
ISO_ORIG=$ISO
qemu-img create -q -f qcow2 "$W/ohne-test-disk1.qcow2" 40G
log "0: ISO ohne Testmodus, Stick mit „unbeaufsichtigt“ – darf nicht installieren"
vm ohne-test 52:54:00:00:00:09 iso "$(cfgdisk ohne-test "role: main
instance: demo
$(common demo 192.168.250.9)
disk: {devices: [/dev/vda], encryption: tpm2}
web: {domain: demo.schulos.test}")"
for _ in $(seq 1 600); do grep -aq "SCHULOS-INSTALLER: start" "$W/ohne-test.serial" && break; sleep 1; done
grep -aq "SCHULOS-INSTALLER: kein-testmodus" "$W/ohne-test.serial" || fail "0: kein Hinweis „kein-testmodus“"
START=$(grep -a "SCHULOS-INSTALLER: start" "$W/ohne-test.serial" | head -n1)
[ -n "$START" ] || fail "0: Installer nicht gestartet"
case "$START" in *--unbeaufsichtigt* | *--testmodus*) fail "0: ohne Testmodus unbeaufsichtigt gestartet: $START" ;; esac
sleep 20
if grep -aq "Installation läuft" "$W/ohne-test.serial"; then fail "0: Installation ohne Testmodus begonnen"; fi
sudo kill "$(cat "$W/ohne-test.pid")" 2>/dev/null || true; sleep 2
rm -f "$W"/ohne-test-disk*.qcow2
log "0 ✓ Stick ohne Kernel-Parameter: Hinweis + Oberfläche, nichts installiert"
bash "$(dirname "$0")/../iso/testmodus-iso.sh" "$ISO_ORIG" "$W/schulos-testmodus.iso"
ISO="$W/schulos-testmodus.iso"

# ---------- 1. Backupserver ----------
install backup 52:54:00:00:00:02 "role: backup
$(common schulos-backup 192.168.250.2)
disk: {devices: [/dev/vda, /dev/vdb], encryption: tpm2}
web: {domain: backup.schulos.test}" 2 "" platte+iso
CODE=$(grep -ao 'Kopplungscode für das Hauptsystem (24 h gültig): [0-9A-Z-]*' "$W/backup-install.serial" | head -n1 | awk '{print $NF}' || true)
[ -n "$CODE" ] || fail "Kopplungscode des Backupservers nicht gefunden"
wait_for "Backupserver erreichbar" 900 https_ok backup.schulos.test 192.168.250.2 /api/health
wait_for "Backupserver Erststart" 300 erststart_fertig 192.168.250.2
iso_bootet_platte backup
log "1 ✓ Backupserver läuft (Spiegel, TPM2, Medium eingelegt → Platte), Kopplungscode $CODE"

# ---------- 2. Hauptsystem, Produktiv, gekoppelt ----------
MAIN_YAML="role: main
instance: production
$(common schulos 192.168.250.3)
disk: {devices: [/dev/vda], encryption: tpm2}
school: {name: QEMU-Gesamtschule, number: '123456'}
web: {domain: schulos.schulos.test}
backup: {mode: pair, url: 'https://backup.schulos.test', code: $CODE}"
install main 52:54:00:00:00:03 "$MAIN_YAML" 1
wait_for "Hauptsystem erreichbar" 900 https_ok schulos.schulos.test 192.168.250.3 /api/health
wait_for "Hauptsystem Erststart" 600 erststart_fertig 192.168.250.3
INFO=$(sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T app node cli.mjs info)
echo "$INFO"
echo "$INFO" | grep -q '"instance":"production"' || fail "kein Produktivsystem"
# cli info zählt alle Rollen (auch mit 0) – genau ein Admin, keine anderen Konten
ACC=$(echo "$INFO" | grep -o '"accounts":{[^}]*}')
echo "$ACC" | grep -q '"admin":1[,}]' && ! echo "$ACC" | grep -oE '"[a-z]+":[1-9][0-9]*' | grep -qv '^"admin":1$' ||
  fail "Datenbank nicht leer bis auf das Admin-Konto: $ACC"
LOGIN=$(curl -sk --resolve schulos.schulos.test:443:192.168.250.3 -H 'content-type: application/json' -H 'origin: https://schulos.schulos.test' \
  -d "{\"username\":\"ina.tech\",\"password\":\"$APW\"}" -w '\n%{http_code}' https://schulos.schulos.test/api/auth/sign-in/username)
[ "$(echo "$LOGIN" | tail -n1)" = 200 ] || fail "Anmeldung mit dem Installer-Admin: $LOGIN"
sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T backup-agent test -f /srv/schulos/config/backup-pairing.json || fail "nicht gekoppelt"
# SEC-08: Images per Digest (name:tag@sha256:…) aus der .env – offline aufgelöst, Container laufen genau damit
# G4E-O10: auch die Profil-Images (ClamAV, CrowdSec, step-ca) per Digest
for v in SCHULOS_IMAGE SCHULOS_AGENT_IMAGE SCHULOS_CADDY_IMAGE SCHULOS_POSTGRES_IMAGE SCHULOS_CLAMAV_IMAGE SCHULOS_CROWDSEC_IMAGE SCHULOS_STEP_CA_IMAGE; do
  sudo_on 192.168.250.3 grep -qE "'^$v=[^ ]+@sha256:[0-9a-f]{64}$'" /opt/schulos/.env || fail "SEC-08: $v ohne Digest in /opt/schulos/.env"
done
for v in SCHULOS_BACKUP_IMAGE SCHULOS_CADDY_IMAGE SCHULOS_POSTGRES_IMAGE SCHULOS_REST_IMAGE; do
  sudo_on 192.168.250.2 grep -qE "'^$v=[^ ]+@sha256:[0-9a-f]{64}$'" /opt/schulos-backup/.env || fail "SEC-08: $v ohne Digest in /opt/schulos-backup/.env"
done
IMG=$(sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos config --images | tr '\n' ' ')
case "$IMG" in *schulos*@sha256:*) ;; *) fail "SEC-08: compose nutzt keine Digests: $IMG" ;; esac
log "2 ✓ Hauptsystem: health, Anmeldung, leer bis auf Admin, gekoppelt, Images per Digest (SEC-08)"

# ---------- 2b. SEC-09: GRUB-Superuser, TPM2 an PCR 7+8+9, Neu-Binden nach einem Initramfs-Update ----------
LUKS=/dev/disk/by-partlabel/schulos-system
tpm_tokens() { sudo_on 192.168.250.3 cryptsetup luksDump --dump-json-metadata "$LUKS" | grep -o '"type":"systemd-tpm2"' | wc -l; }
tpm_bound() { sudo_on 192.168.250.3 cryptsetup luksDump --dump-json-metadata "$LUKS" | tr -d ' \n' | grep -q '"tpm2-pcrs":\[7,8,9\]'; }
# Markierung nur mit sudo prüfen: /var/lib/schulos/tpm ist 0700 root – ohne sudo meldete `test -e` immer „fehlt“
# (Abbruch „geändertes Initramfs ohne Übergang“, obwohl der Übergangsschlüssel angelegt war)
tpm_fertig() { [ "$(on 192.168.250.3 systemctl is-active schulos-tpm.service 2>/dev/null)" = active ] && ! sudo_on 192.168.250.3 test -e /var/lib/schulos/tpm/neu-binden; }
wait_for "TPM2 beim ersten Start gebunden" 120 tpm_fertig
tpm_bound || fail "SEC-09: TPM2 nicht an PCR 7+8+9 gebunden"
[ "$(tpm_tokens)" = 1 ] || fail "SEC-09: Übergangsschlüssel (PCR 7) nicht gelöscht – $(tpm_tokens) TPM2-Plätze"
sudo_on 192.168.250.3 grep -q "'^password_pbkdf2 schulos grub.pbkdf2.sha512.'" /boot/grub/grub.cfg || fail "SEC-09: kein GRUB-Superuser"
sudo_on 192.168.250.3 grep -q "\"menuentry 'SchulOS' --unrestricted\"" /boot/grub/grub.cfg || fail "SEC-09: Standardeintrag nicht --unrestricted"
# Kernel-Update nachstellen: neues Initramfs → Übergangsschlüssel an PCR 7, Neustart ohne Eingabe, danach wieder 7+8+9
sudo_on 192.168.250.3 dracut --force --regenerate-all >/dev/null 2>&1 || fail "SEC-09: dracut"
sudo_on 192.168.250.3 /usr/local/lib/schulos/tpm-binden.sh pruefen || fail "SEC-09: tpm-binden.sh pruefen"
sudo_on 192.168.250.3 test -e /var/lib/schulos/tpm/neu-binden || fail "SEC-09: geändertes Initramfs ohne Übergang"
[ "$(tpm_tokens)" = 2 ] || fail "SEC-09: kein Übergangsschlüssel neben der Bindung"
log "2b: Neustart nach Initramfs-Änderung (TPM2 muss ohne Eingabe entsperren)"
sudo_on 192.168.250.3 systemctl reboot || true
wait_exit main 300
vm main 52:54:00:00:00:03 platte
wait_for "Hauptsystem nach Neustart erreichbar" 900 https_ok schulos.schulos.test 192.168.250.3 /api/health
wait_for "TPM2 nach dem Neustart neu gebunden" 120 tpm_fertig
tpm_bound && [ "$(tpm_tokens)" = 1 ] || fail "SEC-09: nach dem Neustart nicht neu an PCR 7+8+9 gebunden"
log "2b ✓ GRUB-Superuser (Standardeintrag ohne Passwort), TPM2 an PCR 7+8+9, Neu-Binden nach Initramfs-Update ohne Eingabe"

# ---------- 2b'. G4E-O01: sicherheit-nachruesten auf dem schon gebundenen System (neues Bootmenü-Passwort → neue grub.cfg) ----------
# Vorher legte der Befehl nur die Erstbindungs-Markierung an – nach dem Neustart passte kein TPM2-Platz mehr (Wiederherstellungsschlüssel).
HASH_ALT=$(sudo_on 192.168.250.3 grep -o "'grub.pbkdf2.sha512.[^ ]*'" /boot/grub/grub.cfg | head -n 1)
sudo_on 192.168.250.3 "sh -c 'echo abcdefghjkmn2345 | schulosctl sicherheit-nachruesten --yes --passwort-stdin'" || fail "G4E-O01: sicherheit-nachruesten"
HASH_NEU=$(sudo_on 192.168.250.3 grep -o "'grub.pbkdf2.sha512.[^ ]*'" /boot/grub/grub.cfg | head -n 1)
[ -n "$HASH_NEU" ] && [ "$HASH_NEU" != "$HASH_ALT" ] || fail "G4E-O01: grub.cfg ohne neuen Passwort-Hash"
sudo_on 192.168.250.3 test -e /var/lib/schulos/tpm/neu-binden || fail "G4E-O01: kein Übergang nach dem Nachrüsten"
[ "$(tpm_tokens)" = 2 ] || fail "G4E-O01: kein Übergangsschlüssel (PCR 7) neben der Bindung"
# eigenes Passwort mit y/z bzw. Sonderzeichen wird abgelehnt (US-Tastatur am Bootmenü, G4E-O05)
! sudo_on 192.168.250.3 "sh -c 'echo Wartung-im-Keller-2026 | schulosctl sicherheit-nachruesten --yes --passwort-stdin'" 2>/dev/null ||
  fail "G4E-O05: Passwort mit Sonderzeichen angenommen"
log "2b': Neustart nach dem Nachrüsten (TPM2 muss ohne Eingabe entsperren)"
sudo_on 192.168.250.3 systemctl reboot || true
wait_exit main 300
vm main 52:54:00:00:00:03 platte
wait_for "Hauptsystem nach Neustart erreichbar" 900 https_ok schulos.schulos.test 192.168.250.3 /api/health
wait_for "TPM2 nach dem Nachrüsten neu gebunden" 120 tpm_fertig
tpm_bound && [ "$(tpm_tokens)" = 1 ] || fail "G4E-O01: nach dem Neustart nicht neu an PCR 7+8+9 gebunden"
# G4E-O03: Überwachung meldet die Bindung als vollständig (Verwaltung → System, Alarm)
sudo_on 192.168.250.3 schulosctl system-sync >/dev/null || fail "system-sync"
sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T app cat /srv/schulos/config/system-status.json | tr -d ' \n' |
  grep -q '"tpm":{"problems":\[\]}' || fail "G4E-O03: TPM-Bindung in system-status.json nicht als vollständig gemeldet"
log "2b' ✓ Nachrüsten auf gebundenem System: Übergang angelegt, Neustart ohne Eingabe, neu gebunden, Überwachung grün"

# ---------- 2c. SEC-12: SSH nur aus dem Schulnetz (Schulnetz-Bereiche 192.168.250.0/24) ----------
# „außen“ = Absenderadresse 10.250.0.1 auf der Bridge (die Antwort läuft über das Gateway 192.168.250.1 = dieser Rechner zurück)
sudo ip addr add 10.250.0.1/32 dev "$BR" 2>/dev/null || true
banner() { echo | timeout 10 socat -T5 - "TCP:$1:22,bind=$2,connect-timeout=5" 2>/dev/null | head -c 7; }
[ "$(banner 192.168.250.3 192.168.250.1)" = SSH-2.0 ] || fail "SEC-12: SSH aus dem Schulnetz nicht erreichbar"
[ -z "$(banner 192.168.250.3 10.250.0.1)" ] || fail "SEC-12: SSH von außen (10.250.0.1) erreichbar"
on 192.168.250.3 systemctl is-active schulos-ssh-netz.service >/dev/null || fail "SEC-12: Firewall-Dienst nicht aktiv"
# G4E-O06: fail closed – ssh.service braucht die Regel; Host-Bits werden abgelehnt
on 192.168.250.3 systemctl show -p Requires ssh.service | grep -q schulos-ssh-netz.service || fail "G4E-O06: ssh.service hängt nicht an der Firewall-Regel"
! sudo_on 192.168.250.3 schulosctl ssh-netze 192.168.250.5/24 2>/dev/null || fail "G4E-O06: Netz mit Host-Bits angenommen"
# G4E-O17: schulosctl ssh-netze setzt Firewall + sshd (hier dieselben Netze – prüft nft -c, sshd -t, Neustart der Regel)
sudo_on 192.168.250.3 schulosctl ssh-netze 192.168.250.0/24 || fail "G4E-O17: schulosctl ssh-netze"
# sshd wird neu eingelesen (reload) – darf nicht ausbleiben; kurz warten, bis neue Verbindungen wieder gehen
ssh_ok() { on 192.168.250.3 true; }
wait_for "SSH nach ssh-netze wieder erreichbar" 30 ssh_ok
sudo_on 192.168.250.3 schulosctl ssh-netze | grep -q "Firewall: SSH nur aus 192.168.250.0/24" || fail "G4E-O17: ssh-netze zeigt die Netze nicht"
[ "$(banner 192.168.250.3 192.168.250.1)" = SSH-2.0 ] || fail "G4E-O17: SSH aus dem Schulnetz nach ssh-netze nicht erreichbar"
[ -z "$(banner 192.168.250.3 10.250.0.1)" ] || fail "G4E-O17: SSH von außen nach ssh-netze erreichbar"
log "2c ✓ SSH nur aus dem Schulnetz – von außen ist Port 22 zu (nftables), sshd nimmt das Wartungskonto nur von dort an"

# ---------- 3. Sicherung + Test-Restore ----------
sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T app sh -c "'echo qemu-marke > /srv/schulos/files/qemu-marke'"
sudo_on 192.168.250.3 schulosctl backup now || fail "Sicherung"
sudo_on 192.168.250.3 schulosctl test-restore || fail "Test-Restore mit App-Start"
log "3 ✓ gesichert, Test-Restore mit App-Start grün"

# ---------- 4. Demo-Hauptsystem + Playwright ----------
DEMO_YAML="role: main
instance: demo
$(common demo 192.168.250.4)
disk: {devices: [/dev/vda], encryption: tpm2}
web: {domain: demo.schulos.test}"
install demo 52:54:00:00:00:05 "$DEMO_YAML" 1 bestaetigen
log "4a ✓ Demo: Abschluss mit Bestätigung von Block 8 an der Konsole, ausgeschaltet über die Entscheidung „a“"
wait_for "Demo erreichbar" 900 https_ok demo.schulos.test 192.168.250.4 /api/health
wait_for "Demo Erststart" 600 erststart_fertig 192.168.250.4
sudo_on 192.168.250.4 docker compose --project-directory /opt/schulos exec -T app node cli.mjs info | grep -q '"instance":"demo"' || fail "kein Demo-System"
log "Playwright-Browser"
npx playwright install --with-deps chromium >"$W/playwright-install.log" 2>&1 ||
  { tail -n 30 "$W/playwright-install.log"; fail "Playwright-Browser installieren (node: $(command -v node || echo fehlt))"; }
SCHULOS_E2E_URL=https://demo.schulos.test SCHULOS_E2E_RESOLVE="demo.schulos.test 192.168.250.4" npx playwright test --grep @iso --reporter=list ||
  fail "Playwright @iso gegen die Demo"
log "4 ✓ Demo-Hauptsystem aus der ISO: Playwright @iso grün"
sudo kill "$(cat "$W/demo.pid")"; sleep 3
reinstall_refused demo 52:54:00:00:00:05 "$DEMO_YAML"
log "4b ✓ Demo: mit Medium + SCHULOSCFG-Stick neu gestartet – Überschreibschutz greift (rc=5, nichts gelöscht, ausgeschaltet)"

# ---------- 6. Wiederherstellung auf neuer Hardware ----------
ERSATZ=$(sudo_on 192.168.250.2 docker compose --project-directory /opt/schulos-backup exec -T backup node cli.mjs kopplungscode --ersatz QEMU-Gesamtschule 2>/dev/null | tail -n1)
echo "$ERSATZ" | grep -Eq '^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$' || fail "Ersatz-Kopplungscode: $ERSATZ"
log "altes Hauptsystem aus (Hardware „defekt“)"
sudo kill "$(cat "$W/main.pid")"; sleep 3
install neu 52:54:00:00:00:04 "role: main
instance: restore-backup
$(common schulos 192.168.250.3 | grep -v '^admin:')
disk: {devices: [/dev/vda], encryption: tpm2}
web: {domain: schulos.schulos.test}
backup: {url: 'https://backup.schulos.test', code: $ERSATZ}" 1
wait_for "neues Hauptsystem erreichbar" 900 https_ok schulos.schulos.test 192.168.250.3 /api/health
wait_for "neues Hauptsystem Erststart" 900 erststart_fertig 192.168.250.3
INFO2=$(sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T app node cli.mjs info)
[ "$(echo "$INFO2" | grep -o '"accounts":{[^}]*}')" = "$(echo "$INFO" | grep -o '"accounts":{[^}]*}')" ] || fail "Konten nach der Wiederherstellung anders: $INFO2"
sudo_on 192.168.250.3 docker compose --project-directory /opt/schulos exec -T app cat /srv/schulos/files/qemu-marke | grep -q qemu-marke || fail "Datei aus der Sicherung fehlt"
LOGIN2=$(curl -sk --resolve schulos.schulos.test:443:192.168.250.3 -H 'content-type: application/json' -H 'origin: https://schulos.schulos.test' \
  -d "{\"username\":\"ina.tech\",\"password\":\"$APW\"}" -o /dev/null -w '%{http_code}' https://schulos.schulos.test/api/auth/sign-in/username)
[ "$LOGIN2" = 200 ] || fail "Anmeldung nach der Wiederherstellung ($LOGIN2)"
log "6 ✓ neues Hauptsystem aus Backup: Konten, Dateien und Anmeldung wie vorher"
log "QEMU-Tests bestanden (§7 Schritte 1, 2, 3, 4, 6)"
