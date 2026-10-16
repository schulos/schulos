#!/usr/bin/env bash
# qcow2-Abbild je Rolle aus der ISO bauen (B-46, INSTALLATION.md §2 „Abbild für Proxmox/QEMU“): die ISO startet in QEMU mit
# einem Laufwerk SCHULOSCFG, darauf „abbild“ (Rolle) und „danach-aus“ → `schulos-installer --abbild <rolle>` richtet die einzige
# Platte ohne Antworten und ohne Verschlüsselung ein (Debian, Docker, Images, Stack-Dateien) und schaltet aus. Danach wird
# das Abbild komprimiert. Kein Internet nötig (Offline-Paketquelle der ISO).
#   bash iso/build-qcow2.sh <schulos.iso> [ausgabeordner] [main] [backup]
# Ergebnis: <ausgabe>/schulos-<version>-hauptsystem.qcow2 bzw. -backupserver.qcow2 (+ .sha256), virtuell 32 GB – die Wurzel
# wächst beim Start auf die Größe der VM-Platte. Braucht qemu-system-x86, qemu-utils, ovmf, mtools, dosfstools; ohne KVM mit
# QEMU_ACCEL=tcg (sehr langsam); xorriso für die Test-Kopie der ISO (INST-07, iso/testmodus-iso.sh).
set -euo pipefail
ISO=$(readlink -f "$1")
OUT=${2:-iso/out}
shift $(($# < 2 ? $# : 2))
ROLES=("$@")
[ ${#ROLES[@]} -gt 0 ] || ROLES=(main backup)
ACCEL=${QEMU_ACCEL:-kvm}
VERSION=${SCHULOS_VERSION:-$(basename "$ISO" .iso | sed 's/^schulos-//')}
mkdir -p "$OUT"
# Arbeitsordner neben der Ausgabe statt in /tmp: Test-Kopie der ISO (~2 GB) und das wachsende Abbild brauchen Platz – lief der
# Platz aus, hielt QEMU die VM bei ENOSPC still an (Standard werror=enospc) und der Bau hing ohne Meldung bis zum Zeitlimit
W=$(mktemp -d "$(readlink -f "$OUT")/.abbild-bau.XXXXXX")
trap 'rm -rf "$W"' EXIT
log() { echo "[$(date +%H:%M:%S)] $*"; }
platz() { df -h "$W" | tail -n 1; }
# Diagnose bei Abbruch: Ende des seriellen Mitschnitts und freier Platz
fehlschlag() { # <name> <rolle> <meldung>
  echo "--- serieller Mitschnitt $1 (Ende)"
  tail -n 80 "$W/$2.serial" 2>/dev/null || true
  echo "--- freier Platz: $(platz)"
  echo "$1: $3" >&2
  exit 1
}
# INST-07: --abbild löscht die einzige Platte – nur im CI-Testmodus (Kernel-Parameter schulos.testmodus); dafür eine Test-Kopie
# der ISO (nur das Bootmenü geändert, das Abbild entsteht aus dem unveränderten Medium)
bash "$(dirname "$0")/testmodus-iso.sh" "$ISO" "$W/testmodus.iso"
ISO="$W/testmodus.iso"

for role in "${ROLES[@]}"; do
  case "$role" in main) name=hauptsystem ;; backup) name=backupserver ;; *) echo "Rolle main oder backup, nicht „$role“" >&2; exit 64 ;; esac
  # mindestens 8 GB frei (Abbild bis ~5 GB, dazu die Kompression) – sonst gleich mit klarer Meldung statt einer stehenden VM
  frei=$(df -Pk "$W" | awk 'NR == 2 { print $4 }')
  [ "$frei" -ge $((8 * 1024 * 1024)) ] || { echo "$name: zu wenig Platz für den Abbild-Bau: $(platz)" >&2; exit 1; }
  log "$name: Abbild aus $(basename "$ISO") bauen ($(platz))"
  qemu-img create -q -f qcow2 "$W/$role.qcow2" 32G
  mkfs.vfat -n SCHULOSCFG -C "$W/$role-cfg.img" 1024 >/dev/null
  echo "$role" >"$W/abbild"
  : >"$W/danach-aus"
  mcopy -i "$W/$role-cfg.img" "$W/abbild" "$W/danach-aus" ::
  cp /usr/share/OVMF/OVMF_VARS_4M.fd "$W/$role-vars.fd"
  cpu=host
  [ "$ACCEL" = kvm ] || cpu=max
  # Netz nur, damit network-online nicht wartet – nach außen gesperrt (restrict=on); detect-zeroes/discard: freie Blöcke bleiben frei
  timeout 3600 nice -n 15 qemu-system-x86_64 -machine q35,accel="$ACCEL" -cpu "$cpu" -m 3072 -smp 2 \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,file="$W/$role-vars.fd" \
    -drive file="$W/$role.qcow2",if=virtio,format=qcow2,discard=unmap,detect-zeroes=unmap,werror=report,rerror=report \
    -drive file="$ISO",media=cdrom,readonly=on -boot d \
    -drive file="$W/$role-cfg.img",if=virtio,format=raw,readonly=on \
    -nic user,model=virtio-net-pci,restrict=on \
    -display none -serial file:"$W/$role.serial" -no-reboot || fehlschlag "$name" "$role" "QEMU abgebrochen (Zeitlimit 60 min bzw. Fehler)"
  grep -aE "SCHULOS-INSTALLER: (start|ende)" "$W/$role.serial" | sed "s/^/  [$name] /"
  grep -aq "SCHULOS-INSTALLER: ende rc=0" "$W/$role.serial" || fehlschlag "$name" "$role" "Abbild nicht gebaut"
  f="schulos-$VERSION-$name.qcow2"
  qemu-img convert -c -O qcow2 "$W/$role.qcow2" "$OUT/$f"
  (cd "$OUT" && sha256sum "$f" >"$f.sha256")
  # unkomprimiertes Arbeitsabbild gleich löschen – Platz für die nächste Rolle
  rm -f "$W/$role.qcow2"
  log "$name: $OUT/$f ($(du -h "$OUT/$f" | cut -f1))"
done
