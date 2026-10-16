#!/usr/bin/env bash
# Reproduzierbarkeit der ISO prüfen (B-47): denselben Commit zweimal bauen (eigene Images ohne BuildKit-Cache, frischer
# Build-Container, Debian-Pakete neu aus dem Snapshot) und vergleichen. Bitgleich oder nur die bekannten Abweichungen
# (Next.js-Images, siehe iso/repro-compare.sh) → Exit 0. Sonst diffoscope-Bericht <out>/diffoscope.txt und Exit 1.
#   bash iso/repro.sh [--out <ordner>] [--version <v>]
# Dauer: 2× ISO-Bau + Vergleich (~1,5 h auf der Build-VM). CI: gh workflow run iso.yml -f reproduzierbar=true
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
host() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
OUT=iso/out-repro
VERSION=repro
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    --version) VERSION=$2; shift 2 ;;
    *) echo "Unbekannt: $1" >&2; exit 64 ;;
  esac
done
mkdir -p "$OUT/a" "$OUT/b"
# beide Läufe mit derselben Zeit (Commit-Zeit), auch wenn der Arbeitsbaum zwischendurch wechselt
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}

echo "=== Bau A"
SCHULOS_ISO_CONTAINER=schulos-repro-a bash iso/build-docker.sh --version "$VERSION" --out "$OUT/a"
echo "=== Bau B"
SCHULOS_ISO_CONTAINER=schulos-repro-b bash iso/build-docker.sh --version "$VERSION" --out "$OUT/b"

ISO=schulos-$VERSION.iso
A=$(cut -d' ' -f1 "$OUT/a/$ISO.sha256")
B=$(cut -d' ' -f1 "$OUT/b/$ISO.sha256")
echo "A: $A"
echo "B: $B"
# Stückliste und SBOM liegen neben der ISO – gleich, wenn die Images gleich sind
for f in "$ISO.sha256" "schulos-$VERSION.stueckliste.json"; do
  cmp -s "$OUT/a/$f" "$OUT/b/$f" && echo "gleich: $f" || echo "VERSCHIEDEN: $f"
done
if [ "$A" = "$B" ]; then
  echo "=== Bitgleich: $ISO ($A)"
  exit 0
fi

echo "=== Verschieden – Vergleich je Datei (iso/repro-compare.sh)"
C=schulos-repro-diff
docker rm -f $C >/dev/null 2>&1 || true
trap 'docker rm -f $C >/dev/null 2>&1 || true' EXIT
# Werkzeuge vom selben Debian-Stand wie der Bau; keine Bind-Mounts (Docker Desktop + D:\)
docker run -d --name $C "$(sh scripts/pin.sh iso-build)" sleep infinity >/dev/null
docker exec $C bash -c "rm -f /etc/apt/sources.list.d/debian.sources
  echo 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/$(grep -v '^#' iso/debian-snapshot | tr -d '[:space:]') trixie main' >/etc/apt/sources.list
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends diffoscope-minimal \
    python3-libarchive-c python3-magic squashfs-tools xorriso libarchive-tools xz-utils zstd >/dev/null"
docker exec $C mkdir -p /r/a /r/b
docker cp "$(host "$OUT/a/$ISO")" $C:/r/a/
docker cp "$(host "$OUT/b/$ISO")" $C:/r/b/
docker cp iso/repro-compare.sh $C:/r/compare.sh
RC=0
docker exec $C bash /r/compare.sh /r/a/$ISO /r/b/$ISO /r/w || RC=$?
docker cp $C:/r/w/diffoscope.txt "$(host "$OUT/diffoscope.txt")" 2>/dev/null || true
exit $RC
