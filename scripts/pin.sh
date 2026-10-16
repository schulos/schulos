#!/bin/sh
# Gepinntes Fremd-Image (B-47) aus deploy/upstream/Dockerfile: `sh scripts/pin.sh caddy` → caddy:2@sha256:…
# Mehrere Schlüssel → je Zeile eins. Unbekannter Schlüssel → Exit 1.
set -e
f="$(dirname "$0")/../deploy/upstream/Dockerfile"
for k in "$@"; do
  awk -v k="$k" '$1 == "FROM" && $3 == "AS" && $4 == k { print $2; found = 1 } END { exit !found }' "$f" ||
    { echo "Kein Pin „$k“ in deploy/upstream/Dockerfile" >&2; exit 1; }
done
