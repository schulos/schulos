#!/usr/bin/env bash
# SchulOS-ISO bauen (B-44): Bundles und Images vorbereiten, dann iso/build.sh in einem privilegierten Debian-13-Container
# (node:24-trixie, gepinnt) ausführen. Lokal mit Docker Desktop und in der CI (.github/workflows/iso.yml) gleich.
#   bash iso/build-docker.sh [--version x.y.z] [--out <ordner>] [--rauchtest] [--behalten]
#   bash iso/build-docker.sh --release v1.2.0 [--out <ordner>] …    Release-ISO (B-49)
# --rauchtest: danach im selben Container in QEMU starten, bis der Installer läuft (iso/smoke.sh; ohne KVM einige Minuten)
# Images: aus dem ausgecheckten Stand gebaut (schulos, schulos-agent, schulos-backup) + caddy, postgres, rest-server.
# --release <tag|ordner>: Release-ISO (B-49) – statt Neubau genau die Images des GitHub-Releases (bzw. eines Ordners mit
#   release.json + release.json.sig): Manifest-Signatur gegen release/cosign.pub, eigene Images zusätzlich per cosign
#   verify, alle per Digest aus dem Manifest gezogen; Version = die des Releases. Der Arbeitsbaum muss sauber auf dem
#   Commit des Releases stehen (Installer, schulosctl, Compose und Live-System kommen von dort). Docker muss bei ghcr.io
#   angemeldet sein; cosign bekommt den Zugang aus SCHULOS_REGISTRY_USER/SCHULOS_REGISTRY_TOKEN (private Pakete).
# ~1,5–2 GB, Dauer je nach Netz 20–40 min. Daneben: schulos-<v>.stueckliste.json (B-48) und sbom-<v>/ (CycloneDX je Image).
# Reproduzierbar (B-47): Fremd-Images, Build-Container und BuildKit per Digest (deploy/upstream/Dockerfile), Debian aus
# snapshot.debian.org mit dem Datum aus iso/debian-snapshot, alle Zeitstempel = SOURCE_DATE_EPOCH (Vorgabe: Commit-Zeit).
# Prüfen: iso/repro.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
host() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
VERSION=dev
OUT=iso/out
KEEP=""
SMOKE=""
RELEASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --behalten) KEEP=1; shift ;;
    --rauchtest) SMOKE=1; shift ;;
    --release) RELEASE=$2; shift 2 ;;
    *) echo "Unbekannt: $1" >&2; exit 64 ;;
  esac
done
NAME=${SCHULOS_ISO_CONTAINER:-schulos-iso-build}
IN=$(mktemp -d)
trap 'rm -rf "$IN"; [ -n "$KEEP" ] || docker rm -f $NAME >/dev/null 2>&1 || true' EXIT
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo 0000000)
SNAPSHOT=$(grep -v '^#' iso/debian-snapshot | tr -d '[:space:]')
export SCHULOS_DEBIAN_MIRROR=${SCHULOS_DEBIAN_MIRROR:-https://snapshot.debian.org/archive/debian/$SNAPSHOT}
export SCHULOS_DEBIAN_SECURITY=${SCHULOS_DEBIAN_SECURITY:-https://snapshot.debian.org/archive/debian-security/$SNAPSHOT}
pin() { sh scripts/pin.sh "$1"; }

if [ -n "$RELEASE" ]; then
  echo "== Release $RELEASE (B-49)"
  REL="$IN/release"
  mkdir -p "$REL"
  if [ -d "$RELEASE" ]; then cp "$RELEASE/release.json" "$RELEASE/release.json.sig" "$REL/"
  else gh release download "$RELEASE" --pattern release.json --pattern release.json.sig --dir "$(host "$REL")"; fi
  # prüft die Signatur, erst dann wird das Manifest gelesen; schreibt images.txt, images.env, release.env
  npx --no-install tsx scripts/release-manifest.ts --iso "$(host "$REL")"
  VERSION=$(sed -n 's/^VERSION=//p' "$REL/release.env")
  RELEASE_COMMIT=$(sed -n 's/^COMMIT=//p' "$REL/release.env")
  [ "$COMMIT" = "$RELEASE_COMMIT" ] ||
    { echo "Arbeitsbaum steht auf $COMMIT, das Release $VERSION auf $RELEASE_COMMIT – erst: git checkout $RELEASE_COMMIT" >&2; exit 1; }
  git diff --quiet HEAD -- || { echo "Arbeitsbaum hat Änderungen – eine Release-ISO nur aus dem sauberen Release-Stand" >&2; exit 1; }
fi
echo "== Stand $COMMIT, SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH, Debian $SCHULOS_DEBIAN_MIRROR"

echo "== Bundles"
SCHULOS_VERSION=$VERSION npm run build -w @schulos/installer >/dev/null 2>&1
SCHULOS_VERSION=$VERSION npm run build -w @schulos/ctl >/dev/null 2>&1
mkdir -p "$IN/medium/images"
cp apps/installer/dist/schulos-installer.mjs "$IN/"
cp compose.yaml compose.backup.yaml apps/ctl/dist/schulosctl.mjs "$IN/medium/"
cp -r deploy/systemd deploy/grub.d "$IN/medium/"
cp -r iso/live "$IN/live"

save() { # <archivname> <image>
  # docker save setzt Zeitstempel (Ordner, index.json) auf „jetzt“ → Archiv mit fester Reihenfolge und Zeit neu packen;
  # die Blobs (Layer, Config) bleiben bytegleich, der Digest also auch
  local d="${IN:?}/save-${1:?}"
  mkdir -p "$d" && docker save "$2" | tar -xf - -C "$d"
  tar -cf - -C "$d" --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' . |
    gzip -n -1 >"$IN/medium/images/$1.tar.gz"
  digest_of "$2" "$d/index.json"
}
# SEC-08: Digest je Archiv (index.json – so legt `docker load` mit containerd-Speicher das Image ab); images.env nennt danach
# name:tag@sha256:… statt nur den Tag (scripts/release-manifest.ts --pin-images)
: >"$IN/digests.txt"
digest_of() { # <tag> <index.json>
  local f
  f="$IN/index-$(echo "$1" | tr '/:@' '___').json"
  [ -s "$2" ] || { echo "SEC-08: $1 – Archiv ohne index.json (Docker ab 25 nötig)" >&2; exit 1; }
  cp "$2" "$f"
  echo "$1 $(host "$f")" >>"$IN/digests.txt"
}
if [ -n "$RELEASE" ]; then
  echo "== Images aus dem Release $VERSION (per Digest, eigene mit cosign geprüft)"
  COSIGN=(docker run --rm -e COSIGN_PUBLIC_KEY="$(cat release/cosign.pub)" "$(pin cosign)" verify --key env://COSIGN_PUBLIC_KEY
    --insecure-ignore-tlog=true)
  [ -z "${SCHULOS_REGISTRY_TOKEN:-}" ] ||
    COSIGN+=(--registry-username "${SCHULOS_REGISTRY_USER:?SCHULOS_REGISTRY_USER fehlt}" --registry-password "$SCHULOS_REGISTRY_TOKEN")
  REFS=()
  while read -r file ref tag signed; do
    if [ "$signed" = 1 ]; then "${COSIGN[@]}" "$ref" </dev/null >/dev/null || { echo "cosign: Signatur von $ref ungültig" >&2; exit 1; }; fi
    # per Digest aus dem signierten Manifest – docker pull prüft den Inhalt dagegen; der Tag zeigt dann genau darauf
    docker pull -q "$ref" >/dev/null && docker tag "$ref" "$tag"
    save "$file" "$tag"
    REFS+=("$tag")
    echo "  $tag  ←  $ref"
  done <"$REL/images.txt"
  cp "$REL/images.env" "$IN/medium/images/images.env"
  sed -i "1i # Images auf dem Startmedium (Release $VERSION, Digests in STUECKLISTE.json)" "$IN/medium/images/images.env"
else
echo "== Images ($VERSION)"
# Eigene Images: BuildKit in festem Container (docker-container-Treiber, Version aus den Pins), Basis-Images per Digest,
# Image-Archiv (type=docker: OCI-Layout + manifest.json, lädt auch ohne containerd-Speicher) mit Zeitstempeln =
# SOURCE_DATE_EPOCH, ohne Provenance (enthielte Bauzeit/Host) → gleiche Bytes je Commit.
# Das Archiv kommt so aufs Medium; docker load nur für Stückliste und SBOM.
BUILDER=schulos-repro-$(pin buildkit | sed 's/.*sha256:\(.\{12\}\).*/\1/')
docker buildx inspect "$BUILDER" >/dev/null 2>&1 ||
  docker buildx create --name "$BUILDER" --driver docker-container --driver-opt "image=$(pin buildkit)" >/dev/null
ARGS=(--build-arg "SCHULOS_VERSION=$VERSION" --build-arg "SCHULOS_BUILD_ID=$COMMIT" --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
  --build-arg "NODE_IMAGE=$(pin node)" --build-arg "RESTIC_IMAGE=$(pin restic)" --build-arg "RCLONE_IMAGE=$(pin rclone)")
# immer ohne Cache: gecachte Layer tragen die Zeitstempel eines früheren Baus (anderes SOURCE_DATE_EPOCH, nur nach oben
# begrenzt) – mit Cache wären die Bytes vom Zustand des Builders abhängig
ARGS+=(--no-cache)
own() { # <name> <dockerfile>
  local tar="${IN:?}/${1:?}.image.tar"
  docker buildx build --builder "$BUILDER" -q --provenance=false --sbom=false "${ARGS[@]}" -f "$2" \
    --output "type=docker,dest=$tar,name=$1:$VERSION,rewrite-timestamp=true" . >/dev/null
  gzip -n -1 <"$tar" >"$IN/medium/images/$1.tar.gz"
  tar -xOf "$tar" index.json >"$IN/$1.index.json" 2>/dev/null || true
  digest_of "$1:$VERSION" "$IN/$1.index.json"
  docker load -q -i "$tar" >/dev/null
}
own schulos Dockerfile
own schulos-agent apps/agent/Dockerfile
own schulos-backup apps/backup/Dockerfile
# Cache des Builders wird nie wiederverwendet (--no-cache) – sonst wächst er mit jedem Bau um einige GB (die Build-VM lief voll)
docker buildx prune --builder "$BUILDER" -af >/dev/null
# Fremd-Images per Digest ziehen, unter dem Tag ablegen (images.env, Compose) – der Digest steht in der Stückliste
# gzip: docker save schreibt ohne containerd-Speicher (CI-Runner) unkomprimiert – 1,5 GB statt ~0,5 GB; docker load liest gzip direkt
upstream() { # <name> <pin-schlüssel>
  local ref; ref=$(pin "$2")
  docker pull -q "$ref" >/dev/null && docker tag "$ref" "${ref%@*}"
  save "$1" "${ref%@*}"
  echo "${ref%@*}"
}
CADDY=$(upstream caddy caddy)
POSTGRES=$(upstream postgres postgres)
REST=$(upstream rest-server rest-server)
cat >"$IN/medium/images/images.env" <<EOF
# Images auf dem Startmedium (ISO $VERSION)
SCHULOS_IMAGE=schulos:$VERSION
SCHULOS_AGENT_IMAGE=schulos-agent:$VERSION
SCHULOS_BACKUP_IMAGE=schulos-backup:$VERSION
SCHULOS_CADDY_IMAGE=$CADDY
SCHULOS_POSTGRES_IMAGE=$POSTGRES
SCHULOS_REST_IMAGE=$REST
SCHULOS_CLAMAV_IMAGE=$(pin clamav)
SCHULOS_CROWDSEC_IMAGE=$(pin crowdsec)
SCHULOS_STEP_CA_IMAGE=$(pin step-ca)
EOF
REFS=(schulos:$VERSION schulos-agent:$VERSION schulos-backup:$VERSION "$CADDY" "$POSTGRES" "$REST")
fi
# SEC-08: Tags → name:tag@sha256:… (Digest aus dem jeweiligen Archiv)
npx --no-install tsx scripts/release-manifest.ts --pin-images "$(host "$IN/medium/images/images.env")" --digests "$(host "$IN/digests.txt")"
cat "$IN/medium/images/images.env"
du -sh "$IN/medium/images"

echo "== Stückliste: Commit, Images, CycloneDX je Image (B-48)"
echo "$COMMIT" >"$IN/commit"
(IFS=,; echo "${REFS[*]}") >"$IN/images-refs"
docker image inspect "${REFS[@]}" >"$IN/images-inspect.json"
# Inhalt der Images (OS- und npm-Pakete) – liegt neben der ISO, nicht auf dem Medium
SYFT_IMAGE=${SYFT_IMAGE:-$(pin syft)}
mkdir -p "$IN/sbom"
for r in "${REFS[@]}"; do
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$SYFT_IMAGE" -q "$r" -o cyclonedx-json >"$IN/sbom/$(echo "$r" | tr '/:' '__').cdx.json"
done
ls "$IN/sbom"

echo "== ISO im Container"
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME --privileged "$(pin iso-build)" sleep infinity >/dev/null
docker exec $NAME mkdir -p /work
docker cp "$(host "$IN")" $NAME:/work/in
docker cp iso/build.sh $NAME:/work/build.sh
docker cp iso/smoke.sh $NAME:/work/smoke.sh
docker exec -e SCHULOS_VERSION=$VERSION -e SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH -e SCHULOS_DEBIAN_MIRROR -e SCHULOS_DEBIAN_SECURITY   $NAME bash /work/build.sh
[ -z "$SMOKE" ] || docker exec $NAME bash /work/smoke.sh /work/out/schulos-$VERSION.iso
mkdir -p "$OUT"
docker cp $NAME:/work/out/. "$(host "$OUT")"
mkdir -p "$OUT/sbom-$VERSION" && cp "$IN"/sbom/*.cdx.json "$OUT/sbom-$VERSION/"
ls -la "$OUT"
