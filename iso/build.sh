#!/bin/bash
# SchulOS-ISO bauen (B-44, INSTALLATION.md §2) – läuft als root in einem privilegierten Debian-13-Container (iso/build-docker.sh,
# CI: .github/workflows/iso.yml). Erwartet unter $IN (Vorgabe /work/in), vorbereitet vom Aufrufer:
#   schulos-installer.mjs               gebündelter Installer (apps/installer)
#   commit, images-refs, images-inspect.json   für die Stückliste (B-48)
#   medium/                             SchulOS-Dateien für /run/live/medium/schulos: compose.yaml, compose.backup.yaml,
#                                       schulosctl.mjs, systemd/, grub.d/, images/*.tar.gz + images/images.env
#   live/                               live-build-Konfiguration (iso/live)
# Ergebnis: $OUT/schulos-$VERSION.iso + .sha256
#
# Aufbau des Mediums: /schulos (s. o., dazu node/ = Node 24), /debian = Offline-Paketquelle für debootstrap + apt mit genau den
# Paketen, die der Installer braucht (Liste aus `schulos-installer --paketliste`, Abhängigkeiten aufgelöst wie bei der Installation).
set -euo pipefail
IN=${IN:-/work/in}
OUT=${OUT:-/work/out}
WORK=${WORK:-/work/build}
VERSION=${SCHULOS_VERSION:-dev}
MIRROR=${SCHULOS_DEBIAN_MIRROR:-http://deb.debian.org/debian}
SECURITY=${SCHULOS_DEBIAN_SECURITY:-http://deb.debian.org/debian-security}
# Reproduzierbar (B-47): alle Zeitstempel (live-build, mksquashfs, xorriso, eigene Dateien) = SOURCE_DATE_EPOCH
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(date +%s)}
# Node für das Live-System und das Zielsystem: dieselbe Version wie im Build-Container (node:24-trixie), sonst NODE_VERSION
NODE_VERSION=${NODE_VERSION:-$(node -p process.versions.node)}
export DEBIAN_FRONTEND=noninteractive

step() { echo; echo "== $*"; }

step "Werkzeuge (aus $MIRROR)"
# auch die Werkzeuge (live-build, xorriso, squashfs-tools …) vom festen Stand – sie bestimmen die Bytes der ISO mit.
# check-valid-until=no: ältere Snapshots haben abgelaufene Release-Dateien (debian-security: Gültigkeit ~1 Woche)
rm -f /etc/apt/sources.list.d/debian.sources
echo "deb [check-valid-until=no] $MIRROR trixie main" > /etc/apt/sources.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends live-build debootstrap apt-utils xorriso squashfs-tools mtools dosfstools \
  grub-efi-amd64-bin grub-pc-bin curl ca-certificates xz-utils gnupg >/dev/null

rm -rf "$WORK"; mkdir -p "$WORK" "$OUT"
read -r -a DEB_PKGS < <(node "$IN/schulos-installer.mjs" --paketliste | sed -n 1p)
read -r -a APT_PKGS < <(node "$IN/schulos-installer.mjs" --paketliste | sed -n 2p)

step "Offline-Paketquelle: debootstrap ${#DEB_PKGS[@]} Pakete, danach apt ${#APT_PKGS[@]} Pakete (mit Abhängigkeiten)"
R="$WORK/repo-chroot"
debootstrap --arch=amd64 --components=main --include="$(IFS=,; echo "${DEB_PKGS[*]}")" trixie "$R" "$MIRROR" >/dev/null
echo "deb [check-valid-until=no] $MIRROR trixie main" > "$R/etc/apt/sources.list"
chroot "$R" apt-get update -qq
chroot "$R" apt-get install -y -qq --download-only --no-install-recommends "${APT_PKGS[@]}" >/dev/null
POOL="$WORK/medium/debian/pool/main"
mkdir -p "$POOL" "$WORK/medium/debian/dists/trixie/main/binary-amd64"
# debootstrap lässt seine Pakete im Cache des Ziels liegen, apt --download-only legt sie daneben
cp "$R"/var/cache/apt/archives/*.deb "$POOL/"
echo "$(ls "$POOL" | wc -l) Pakete, $(du -sh "$POOL" | cut -f1)"
(
  cd "$WORK/medium/debian"
  # Reihenfolge der Einträge nach Dateiname (apt-ftparchive folgt sonst der Verzeichnisreihenfolge des Dateisystems)
  # (über eine Datei: Node von stdin aus der Pipe stürzte im Container ab)
  apt-ftparchive packages pool > "$WORK/Packages.unsortiert"
  node -e '
    const fs = require("fs");
    const t = fs.readFileSync(process.argv[1], "utf8").split(/\n\n+/).filter((x) => x.trim());
    const key = (x) => /^Filename: (.+)$/m.exec(x)[1];
    fs.writeFileSync(process.argv[2], t.sort((a, b) => (key(a) < key(b) ? -1 : 1)).join("\n\n") + "\n\n");
  ' "$WORK/Packages.unsortiert" dists/trixie/main/binary-amd64/Packages
  gzip -9nkf dists/trixie/main/binary-amd64/Packages
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=SchulOS -o APT::FTPArchive::Release::Label=SchulOS \
    -o APT::FTPArchive::Release::Suite=trixie -o APT::FTPArchive::Release::Codename=trixie \
    -o APT::FTPArchive::Release::Architectures=amd64 -o APT::FTPArchive::Release::Components=main \
    release dists/trixie > "$WORK/Release"
  # erst außerhalb schreiben: sonst nimmt apt-ftparchive die halb geschriebene Release-Datei in die Prüfsummen auf
  mv "$WORK/Release" dists/trixie/Release
  # Datum der Paketquelle = Stand des Builds (die Prüfsummen darin betreffen nur Packages*)
  sed -i "s/^Date: .*/Date: $(LC_ALL=C date -u -d "@$SOURCE_DATE_EPOCH" '+%a, %d %b %Y %H:%M:%S UTC')/" dists/trixie/Release
)

step "SchulOS-Dateien und Node $NODE_VERSION"
cp -a "$IN/medium" "$WORK/medium/schulos"
NODE_TAR="node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSL -o "$WORK/$NODE_TAR" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TAR"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $NODE_TAR\$" | (cd "$WORK" && sha256sum -c -)
mkdir -p "$WORK/medium/schulos/node"
tar -xJf "$WORK/$NODE_TAR" -C "$WORK/medium/schulos/node" --strip-components=1
ls "$WORK/medium/schulos/images/"*.tar* >/dev/null || { echo "Keine Images unter medium/images" >&2; exit 1; }
[ -f "$WORK/medium/schulos/images/images.env" ] || { echo "medium/images/images.env fehlt" >&2; exit 1; }
echo "$VERSION" > "$WORK/medium/schulos/VERSION"

step "Stückliste (B-48): Pakete der Offline-Quelle, Images, Node, Commit"
stueckliste() { # [zusätzliche Angaben]
  node "$IN/schulos-installer.mjs" --stueckliste --version "$VERSION" --commit "$(cat "$IN/commit")" --quelle "$MIRROR" \
    --pakete "$PKGS" --images "$IN/images-inspect.json" --refs "$(cat "$IN/images-refs")" "$@"
}
# Kopie des Paketindex: medium/ wandert gleich in den live-build-Baum (zweiter Aufruf nach lb build)
PKGS="$WORK/pakete-zielsystem"
cp "$WORK/medium/debian/dists/trixie/main/binary-amd64/Packages" "$PKGS"
# auf dem Medium – der Installer legt sie ins Zielsystem (/usr/share/doc/schulos/stueckliste.json)
stueckliste --ausgabe "$WORK/medium/schulos/STUECKLISTE.json"

step "Live-System (live-build)"
L="$WORK/live"
cp -a "$IN/live" "$L"
mkdir -p "$L/config/includes.chroot/opt" "$L/config/includes.chroot/usr/local/bin" "$L/config/includes.binary"
cp -a "$WORK/medium/schulos/node" "$L/config/includes.chroot/opt/schulos-node"
install -m 0755 "$IN/schulos-installer.mjs" "$L/config/includes.chroot/usr/local/bin/schulos-installer"
chmod 0755 "$L/auto/config" "$L"/config/hooks/normal/*.hook.chroot "$L/config/includes.chroot/usr/local/lib/schulos/start-installer.sh"
# Medium-Inhalt landet im Wurzelverzeichnis der ISO = /run/live/medium im Live-System
mv "$WORK/medium/schulos" "$WORK/medium/debian" "$L/config/includes.binary/"
(
  cd "$L"
  # eigene Dateien (Medium, includes) auf SOURCE_DATE_EPOCH – Pakete bringen ihre Zeitstempel mit
  find "$L/config" -newermt "@$SOURCE_DATE_EPOCH" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
  SCHULOS_DEBIAN_MIRROR="$MIRROR" SCHULOS_DEBIAN_SECURITY="$SECURITY" lb config >/dev/null
  # Stufen statt `lb build`: zwischen chroot und binary den apt-Cache löschen – live-build erzeugt pkgcache.bin nach den
  # Hooks neu, und die Datei ist je Bau anders (B-47)
  { lb bootstrap && lb chroot; } 2>&1 | tail -n 20
  rm -f chroot/var/cache/apt/pkgcache.bin chroot/var/cache/apt/srcpkgcache.bin
  # Konsolenschrift aus dem Hook (INST-02) – Halbblöcke für das Logo der Oberfläche
  [ -f chroot/usr/local/share/schulos/konsolenschrift/schulos-8x16.psf ] || { echo "Konsolenschrift fehlt (Hook 9000-schulos)" >&2; exit 1; }
  lb binary 2>&1 | tail -n 20
)
ISO="$OUT/schulos-$VERSION.iso"
mv "$L"/live-image-amd64.hybrid.iso "$ISO"
# neben der ISO: dazu die Pakete des Live-Systems (Liste von live-build, sonst aus der chroot)
if [ -f "$L/live-image-amd64.packages" ]; then cp "$L/live-image-amd64.packages" "$WORK/live-pakete.txt"
else chroot "$L/chroot" dpkg-query -W -f '${Package}\t${Version}\t${Architecture}\n' >"$WORK/live-pakete.txt"; fi
stueckliste --live "$WORK/live-pakete.txt" --ausgabe "$OUT/schulos-$VERSION.stueckliste.json"

step "ISO prüfen"
check() { xorriso -indev "$ISO" -find "$1" 2>/dev/null | grep -q . || { echo "fehlt in der ISO: $1" >&2; exit 1; }; }
for p in /schulos/node/bin/node /schulos/schulosctl.mjs /schulos/STUECKLISTE.json /schulos/compose.yaml /schulos/images/images.env /schulos/grub.d/41_schulos-rueckweg \
  /debian/dists/trixie/Release /live/filesystem.squashfs /EFI/boot/bootx64.efi; do check "$p"; done
xorriso -indev "$ISO" -osirrox on -extract /boot/grub/grub.cfg "$WORK/grub.cfg" >/dev/null 2>&1
# GATE-4f C-03/C-04: Platte nur über die Markierung, Spiegel (mdraid1x) lesbar
grep -q 'menuentry "SchulOS installieren"' "$WORK/grub.cfg" && ! grep -q '@KERNEL_LIVE@' "$WORK/grub.cfg" && grep -q 'console=ttyS0' "$WORK/grub.cfg" &&
  grep -q 'search --no-floppy --file /grub/schulos-installiert' "$WORK/grub.cfg" && grep -q 'insmod mdraid1x' "$WORK/grub.cfg" ||
  { echo "Bootmenü nicht wie erwartet:" >&2; cat "$WORK/grub.cfg" >&2; exit 1; }
# INST-07: den CI-Testmodus setzt nur die Test-Kopie (iso/testmodus-iso.sh) – nie die gebaute ISO selbst
if grep -qE '^[[:space:]]*linux[[:space:]].*schulos\.testmodus|schulos_kernel=".*schulos\.testmodus' "$WORK/grub.cfg"; then
  echo "Bootmenü trägt schulos.testmodus – das gehört nur in die Test-Kopie:" >&2; cat "$WORK/grub.cfg" >&2; exit 1
fi
echo "Inhalt und Bootmenü in Ordnung"
(cd "$OUT" && sha256sum "$(basename "$ISO")" > "$(basename "$ISO").sha256")
step "Fertig: $ISO ($(du -h "$ISO" | cut -f1))"
