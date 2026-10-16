#!/usr/bin/env bash
# INST-07: Test-Kopie der ISO für die CI – identisch bis auf den Kernel-Parameter `schulos.testmodus` im Eintrag
# „SchulOS installieren“. Das Startmenü bleibt sonst gleich: Installer als Vorgabe nur mit Laufwerk SCHULOSCFG, sonst startet eine
# fertige Installation von der Platte (der Parameter darf das nicht ändern – Lauf 3 der Gate-Prüfung: Backupserver landete wieder
# im Installer).
# Nur mit diesem Parameter installiert start-installer.sh unbeaufsichtigt bzw. baut ein Abbild; ein Stick SCHULOSCFG allein
# reicht nie. Aufrufer: scripts/qemu-test.sh, iso/build-qcow2.sh. Die Release-ISO bleibt unverändert (iso/build.sh prüft, dass
# sie den Parameter nicht trägt).
#   bash iso/testmodus-iso.sh <schulos.iso> <test.iso>
# Braucht xorriso (≥ 1.4.8, `-boot_image any replay` übernimmt El Torito, EFI-Abbild und Hybrid-MBR/GPT der Vorlage).
set -euo pipefail
IN=$(readlink -f "$1")
OUT=$2
command -v xorriso >/dev/null || { echo "testmodus-iso: xorriso fehlt (apt-get install xorriso)" >&2; exit 1; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
xorriso -osirrox on -indev "$IN" -extract /boot/grub/grub.cfg "$T/grub.cfg" >/dev/null 2>&1
# nur der Eintrag „SchulOS installieren“ (nicht „Startmedium prüfen“, nicht schulos_kernel fürs Startmenü)
awk '
  /menuentry "SchulOS installieren"/ { e = 1 }
  e && /^[ \t]*linux[ \t]/ { $0 = $0 " schulos.testmodus"; e = 0 }
  { print }
' "$T/grub.cfg" >"$T/grub-test.cfg"
[ "$(grep -c 'schulos\.testmodus' "$T/grub-test.cfg")" = 1 ] || { echo "testmodus-iso: Bootmenü nicht wie erwartet:" >&2; cat "$T/grub.cfg" >&2; exit 1; }
rm -f "$OUT"
xorriso -indev "$IN" -outdev "$OUT" -boot_image any replay -map "$T/grub-test.cfg" /boot/grub/grub.cfg >"$T/xorriso.log" 2>&1 ||
  { cat "$T/xorriso.log" >&2; echo "testmodus-iso: xorriso fehlgeschlagen" >&2; exit 1; }
echo "Test-ISO (schulos.testmodus): $OUT"
