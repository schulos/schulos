#!/usr/bin/env bash
# Systemschritte des Installers (B-42) echt ausführen – ohne QEMU: privilegierter Debian-13-Container mit Loop-Geräten als
# Platten, debootstrap aus einem Netz-Spiegel, SchulOS-Dateien (Node, Compose, schulosctl, Units) wie auf dem Startmedium
# aus dem Repo nachgebaut – ohne echte Images. Danach wird das installierte System von außen geprüft.
#   spiegel  – Backupserver: zwei Platten als Spiegel (mdadm) + LUKS-Passphrase (braucht md und dm-crypt im Kernel:
#              GitHub-Runner ja, Docker Desktop/LinuxKit nein)
#   einfach  – Demo-Hauptsystem: eine Platte ohne Verschlüsselung
# Ohne Angabe: „spiegel“, wenn der Kernel md und device-mapper kann, sonst „einfach“. TPM2 und der echte Start: QEMU (B-45).
#   bash scripts/installer-system-test.sh [spiegel|einfach] [--behalten]
set -euo pipefail
cd "$(dirname "$0")/.."
# Git Bash: Container-Pfade (/dev, /opt …) nicht in Windows-Pfade verbiegen; lokale Pfade explizit umwandeln
export MSYS_NO_PATHCONV=1
host() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
VARIANT=""
KEEP=""
for a in "$@"; do case "$a" in spiegel | einfach) VARIANT=$a ;; --behalten) KEEP=1 ;; *) echo "Unbekannt: $a" >&2; exit 64 ;; esac; done
NAME=schulos-installer-test
MIRROR=${SCHULOS_DEBIAN_MIRROR:-http://deb.debian.org/debian}
PASS='Platte-im-Keller-2026'

npm run build -w @schulos/installer >/dev/null 2>&1
npm run build -w @schulos/ctl >/dev/null 2>&1
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; [ -n "$KEEP" ] || docker rm -f $NAME >/dev/null 2>&1 || true' EXIT

docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME --privileged -v /dev:/dev node:24-trixie sleep infinity >/dev/null
if [ -z "$VARIANT" ]; then
  if docker exec $NAME sh -c 'modprobe md_mod 2>/dev/null; modprobe dm_crypt 2>/dev/null; [ -e /proc/mdstat ] && grep -q device-mapper /proc/devices'; then VARIANT=spiegel; else VARIANT=einfach; fi
fi
echo "== Variante: $VARIANT"

if [ $VARIANT = spiegel ]; then
  DISKS="[/dev/loop40, /dev/loop41]"
  ROLE="role: backup
admin: {first_name: Ina, last_name: Tech, username: ina.tech, password: Lange-Leitung-Kaffee-42}"
  CRYPT="encryption: passphrase
  passphrase: $PASS"
else
  DISKS="[/dev/loop40]"
  ROLE="role: main
instance: demo"
  CRYPT="encryption: none"
fi
cat >"$WORK/answers.yaml" <<EOF
$ROLE
disk:
  devices: $DISKS
  $CRYPT
network:
  hostname: schulos-test
access:
  password: Wartung-im-Keller-2026
  ssh: true
  ssh_keys: [ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJsIDXR/63YbcH3XVTQfw1nDgH+dRYjXxKh6YShsVxjT test@schulos]
web:
  domain: schulos.schule.test
EOF
# Plan außerhalb des Containers erzeugen; die Loop-Geräte gibt es dort (noch) nicht
SCHULOS_INSTALLER_PLATTEN_UNGEPRUEFT=1 node apps/installer/dist/schulos-installer.mjs --antworten "$(host "$WORK/answers.yaml")" --unbeaufsichtigt --ausgabe "$(host "$WORK/plan")" >/dev/null

docker exec $NAME mkdir -p /opt/i
docker cp apps/installer/dist/schulos-installer.mjs $NAME:/opt/i/
docker cp "$(host "$WORK/plan/plan.json")" $NAME:/opt/i/plan.json
# „Startmedium“: wie /run/live/medium/schulos der ISO (B-44), Images nur als Platzhalter
docker exec $NAME mkdir -p /opt/medium/images
docker cp compose.yaml $NAME:/opt/medium/compose.yaml
docker cp compose.backup.yaml $NAME:/opt/medium/compose.backup.yaml
docker cp apps/ctl/dist/schulosctl.mjs $NAME:/opt/medium/schulosctl.mjs
docker cp deploy/systemd $NAME:/opt/medium/systemd
docker cp deploy/grub.d $NAME:/opt/medium/grub.d
docker exec $NAME sh -c 'cp -a /usr/local /opt/medium/node && echo SCHULOS_IMAGE=schulos:test > /opt/medium/images/images.env && : > /opt/medium/images/platzhalter.tar'

docker exec -i -e VARIANT=$VARIANT -e MIRROR="$MIRROR" $NAME bash -s <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq gdisk parted dosfstools e2fsprogs mdadm cryptsetup btrfs-progs debootstrap udev systemd-cryptsetup zstd cpio >/dev/null
n_disks=1; [ "$VARIANT" = spiegel ] && n_disks=2
for i in $(seq 0 $((n_disks - 1))); do
  n=$((40 + i))
  [ -e /dev/loop$n ] || mknod /dev/loop$n b 7 $n
  losetup -d /dev/loop$n 2>/dev/null || true
  rm -f /var/tmp/disk$n.img; truncate -s 8G /var/tmp/disk$n.img
  losetup -P /dev/loop$n /var/tmp/disk$n.img
done
# /target legt der Installer selbst an
node /opt/i/schulos-installer.mjs --plan /opt/i/plan.json --quelle "$MIRROR" --ausgabe /run/si --medium /opt/medium
EOF

echo "== Installiertes System prüfen"
docker exec -i -e VARIANT=$VARIANT -e PASS="$PASS" $NAME bash -s <<'EOF'
set -euo pipefail
fail() { echo "FEHLER: $*"; exit 1; }
if [ "$VARIANT" = spiegel ]; then
  mdadm --assemble /dev/md/schulos /dev/loop40p3 /dev/loop41p3 >/dev/null 2>&1 || true
  mdadm --assemble /dev/md/schulos-boot /dev/loop40p2 /dev/loop41p2 >/dev/null 2>&1 || true
  [ "$(grep -c 'active raid1' /proc/mdstat)" -ge 2 ] || fail "Spiegel für /boot und System nicht beide aktiv"
  BOOT=/dev/md/schulos-boot
  grep -q 'active raid1' /proc/mdstat || fail "Spiegel nicht aktiv"
  printf '%s' "$PASS" | cryptsetup open --key-file=- /dev/md/schulos pruefung || fail "Passphrase öffnet die Platte nicht"
  ROOT=/dev/mapper/pruefung
else
  ROOT=/dev/loop40p3
  BOOT=/dev/loop40p2
fi
mkdir -p /mnt/p /mnt/top /mnt/efi /mnt/efi2
mount -o subvol=@ "$ROOT" /mnt/p
# /boot ist unverschlüsselt und eigenständig (GRUB liest Kernel und Initramfs dort)
[ "$(blkid -s TYPE -o value "$BOOT")" = ext4 ] || fail "/boot ist kein ext4"
mount "$BOOT" /mnt/p/boot
mount "$ROOT" /mnt/top
mount /dev/loop40p1 /mnt/efi
for sv in @ @srv @snapshots; do [ -d "/mnt/top/$sv" ] || fail "Subvolume $sv fehlt"; done
grep -q '^LABEL=schulos  /srv' /mnt/p/etc/fstab || fail fstab
grep -q '^LABEL=schulos-boot  /boot' /mnt/p/etc/fstab || fail "fstab ohne /boot"
[ "$(cat /mnt/p/etc/hostname)" = schulos-test ] || fail hostname
grep -q '^schulos-admin:\$' /mnt/p/etc/shadow || fail "Passwort Wartungskonto"
grep -q '^root:!' /mnt/p/etc/shadow || fail "root nicht gesperrt"
grep -q 'test@schulos' /mnt/p/home/schulos-admin/.ssh/authorized_keys || fail ssh-key
[ -f /mnt/efi/EFI/BOOT/BOOTX64.EFI ] || fail "Bootloader fehlt"
# shim als BOOTX64.EFI, signiertes GRUB daneben – dieselbe Startkette wie die ISO (PCR 7 für TPM2)
[ -f /mnt/efi/EFI/BOOT/grubx64.efi ] || fail "kein shim/signiertes GRUB (grubx64.efi fehlt)"
grep -q 'vmlinuz' /mnt/p/boot/grub/grub.cfg || fail "grub.cfg ohne Kernel"
INITRD=$(ls /mnt/p/boot/initrd.img-* 2>/dev/null | head -1)
[ -n "$INITRD" ] || fail "Initramfs fehlt"
mount --bind /dev /mnt/p/dev; mount -t proc proc /mnt/p/proc
LIST=$(chroot /mnt/p lsinitrd -k "$(basename "$INITRD" | sed 's/^initrd.img-//')" 2>/dev/null || true)
umount /mnt/p/proc /mnt/p/dev
grep -q 'btrfs' <<<"$LIST" || fail "Initramfs ohne btrfs"
if [ "$VARIANT" = spiegel ]; then
  mount /dev/loop41p1 /mnt/efi2
  [ -f /mnt/efi2/EFI/BOOT/BOOTX64.EFI ] || fail "Bootloader nicht auf der zweiten Platte"
  grep -q '^schulos-root /dev/md/schulos none luks,discard$' /mnt/p/etc/crypttab || fail crypttab
  # genau zwei: doppelte ARRAY-Zeilen (mkconf des Pakets + unsere) lassen mdadm im Initramfs scheitern
  [ "$(grep -c '^ARRAY' /mnt/p/etc/mdadm/mdadm.conf)" = 2 ] || fail "mdadm.conf nicht genau beide Spiegel: $(grep '^ARRAY' /mnt/p/etc/mdadm/mdadm.conf)"
  grep -q 'mdraid1x' /mnt/p/boot/grub/grub.cfg || fail "GRUB lädt mdraid1x nicht (/boot auf dem Spiegel)"
  [ "$(grep -o 'rd.md.uuid=[^ ]*' /mnt/p/boot/grub/grub.cfg | sort -u | wc -l)" -ge 2 ] || fail "Kernel-Zeile ohne rd.md.uuid für beide Spiegel"
  ! grep -q 'cryptomount' /mnt/p/boot/grub/grub.cfg || fail "GRUB will die Verschlüsselung selbst öffnen"
  grep -q 'mdadm' <<<"$LIST" || fail "Initramfs ohne mdadm"
  grep -q 'systemd-cryptsetup' <<<"$LIST" || fail "Initramfs ohne systemd-cryptsetup"
  grep -q 'etc/crypttab' <<<"$LIST" || fail "Initramfs ohne crypttab"
  umount /mnt/efi2
fi
# SchulOS-Teil
chroot /mnt/p node --version | grep -q '^v24\.' || fail "Node 24 fehlt"
chroot /mnt/p docker --version >/dev/null || fail "Docker fehlt"
[ -x /mnt/p/usr/libexec/docker/cli-plugins/docker-compose ] || fail "Compose-Plugin fehlt"
grep -q '"containerd-snapshotter": true' /mnt/p/etc/docker/daemon.json || fail daemon.json
grep -q '"data-root": "/srv/docker"' /mnt/p/etc/docker/daemon.json || fail "Docker-Daten nicht unter /srv"
grep -q '"userland-proxy": false' /mnt/p/etc/docker/daemon.json || fail "Docker mit Userland-Proxy (IPv6 erscheint als Schulnetz)"
[ -L /mnt/p/etc/systemd/system/multi-user.target.wants/schulos-erststart.service ] || fail "Erststart nicht eingeschaltet"
[ -L /mnt/p/etc/systemd/system/multi-user.target.wants/schulos-konsole.service ] || fail "Konsole nicht eingeschaltet"
[ "$(stat -c %a /mnt/p/etc/schulos/erststart.env)" = 600 ] || fail "erststart.env nicht 0600"
bash -n /mnt/p/usr/local/lib/schulos/erststart.sh || fail "erststart.sh"
bash -n /mnt/p/usr/local/lib/schulos/konsole.sh || fail "konsole.sh"
ls /mnt/top/@srv/schulos-images/*.tar* >/dev/null || fail "Images nicht unter /srv"
grep -q '^docker:.*schulos-admin' /mnt/p/etc/group || fail "Wartungskonto nicht in der Gruppe docker"
if [ "$VARIANT" = spiegel ]; then STACK=/opt/schulos-backup; else STACK=/opt/schulos; fi
[ -f /mnt/p$STACK/compose.yaml ] || fail "compose.yaml fehlt"
grep -q '^SCHULOS_IMAGE=schulos:test$' /mnt/p$STACK/.env || fail "Image-Angaben nicht in .env"
[ "$(stat -c %a /mnt/p$STACK/.env)" = 600 ] || fail ".env nicht 0600"
if [ "$VARIANT" = einfach ]; then
  grep -q '^SCHULOS_INSTANCE=demo$' /mnt/p/opt/schulos/schulos.env || fail schulos.env
  [ -L /mnt/p/etc/systemd/system/timers.target.wants/schulos-wartung.timer ] || fail "Wartungs-Timer nicht eingeschaltet"
  grep -q 'OnCalendar=\*-\*-\* 02:30:00' /mnt/p/etc/systemd/system/schulos-wartung.timer.d/fenster.conf || fail Wartungsfenster
  chroot /mnt/p node /opt/schulos/schulosctl.mjs help | grep -q os-upgrade || fail "schulosctl startet nicht bzw. kennt os-upgrade nicht"
  [ -x /mnt/p/etc/grub.d/41_schulos-rueckweg ] || fail "Bootmenü-Rückweg fehlt"
  [ -L /mnt/p/etc/systemd/system/multi-user.target.wants/schulos-os-upgrade-pruefen.service ] || fail "Prüfdienst Versionswechsel nicht eingeschaltet"
else
  grep -q '^SCHULOS_INITIAL_PAIRING_CODE=' /mnt/p/opt/schulos-backup/backup.env || fail backup.env
  # Q5-18: Passphrase → kein automatischer Neustart (der Backupserver hinge nachts an der Eingabe)
  [ ! -e /mnt/p/etc/systemd/system/timers.target.wants/schulos-neustart.timer ] || fail "Neustart-Timer trotz Passphrase eingeschaltet"
fi
# Debian-Updates (B-43): unattended-upgrades, needrestart, snapper – snapper legt in der chroot wirklich einen Schnappschuss an
grep -q 'Automatic-Reboot "false"' /mnt/p/etc/apt/apt.conf.d/52schulos-unattended || fail unattended-upgrades
[ -x /mnt/p/usr/bin/unattended-upgrade ] || fail "unattended-upgrades fehlt"
grep -q "restart} = 'a'" /mnt/p/etc/needrestart/conf.d/schulos.conf || fail needrestart
mount -o subvol=@snapshots "$ROOT" /mnt/p/.snapshots
mount --bind /dev /mnt/p/dev; mount -t proc proc /mnt/p/proc; mount -t sysfs sys /mnt/p/sys
chroot /mnt/p snapper --no-dbus -c root create -d installer-test || fail "snapper kann keinen Schnappschuss anlegen"
chroot /mnt/p snapper --no-dbus -c root list | grep -q installer-test || fail "snapper-Schnappschuss fehlt"
umount /mnt/p/sys /mnt/p/proc /mnt/p/dev /mnt/p/.snapshots
echo "Geprüft ($VARIANT): Subvolumes, fstab, Konto, SSH-Schlüssel, Bootloader, grub.cfg, Initramfs$([ "$VARIANT" = spiegel ] && echo ', Spiegel, LUKS, crypttab, mdadm.conf, zweite EFI-Partition'), Node 24, Docker (containerd, /srv), Stack, Erststart, Konsole, Debian-Updates (unattended-upgrades, needrestart, snapper)"
umount /mnt/efi /mnt/top /mnt/p/boot /mnt/p
[ "$VARIANT" = spiegel ] && cryptsetup close pruefung && mdadm --stop /dev/md/schulos /dev/md/schulos-boot >/dev/null
for n in 40 41; do losetup -d /dev/loop$n 2>/dev/null || true; done
EOF
echo "== Systemschritte-Test bestanden ($VARIANT)"
