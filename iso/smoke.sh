#!/bin/bash
# Rauchtest der ISO (B-44): in QEMU mit UEFI (OVMF) starten und warten, bis der Installer im Live-System läuft (Meldung
# „SCHULOS-INSTALLER: start“ auf der seriellen Schnittstelle). Mit KVM in ~1 min, ohne (TCG, z. B. Docker Desktop) einige Minuten.
#   bash iso/smoke.sh <schulos.iso> [frist-sekunden]
set -euo pipefail
ISO=$1
LIMIT=${2:-900}
command -v qemu-img >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends qemu-system-x86 qemu-utils ovmf >/dev/null; }
VARS=$(mktemp)
cp /usr/share/OVMF/OVMF_VARS_4M.fd "$VARS"
LOG=$(mktemp)
ACCEL=tcg
[ -w /dev/kvm ] && ACCEL=kvm
DISK=$(mktemp --suffix=.qcow2)
qemu-img create -q -f qcow2 "$DISK" 40G
echo "== QEMU ($ACCEL), Frist ${LIMIT}s"
qemu-system-x86_64 -machine q35,accel=$ACCEL -m 2048 -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive if=pflash,format=raw,file="$VARS" \
  -drive file="$DISK",if=virtio,format=qcow2 \
  -cdrom "$ISO" -boot d \
  -display none -serial file:"$LOG" -no-reboot &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -f "$VARS" "$DISK"' EXIT
for _ in $(seq 1 "$LIMIT"); do
  if grep -q "SCHULOS-INSTALLER: start" "$LOG"; then
    grep -a "SCHULOS-INSTALLER" "$LOG"
    echo "== Rauchtest bestanden: Live-System startet, Installer läuft"
    exit 0
  fi
  kill -0 $PID 2>/dev/null || break
  sleep 1
done
echo "== Rauchtest FEHLGESCHLAGEN – letzte Zeilen der seriellen Ausgabe:"
tail -n 40 "$LOG"
exit 1
