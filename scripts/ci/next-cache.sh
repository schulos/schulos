#!/usr/bin/env bash
# CI-01: Next-Build-Cache (webpack) auf der Build-VM zwischen Läufen behalten – der Checkout leert .next jedes Mal.
# Liegt lokal unter ~/.cache/schulos-next statt in actions/cache (kein Hoch-/Herunterladen über GitHub). Auf der VM läuft
# verify nur auf dem einen schweren Runner, also nie zwei Läufe gleichzeitig. platz.sh löscht ihn, wenn Platz knapp wird.
#   bash scripts/ci/next-cache.sh holen|sichern
set -euo pipefail
LAGER=${NEXT_CACHE_LAGER:-$HOME/.cache/schulos-next}
ziele=(".next/cache" "apps/backup/.next/cache")

case "${1:-}" in
  holen)
    for z in "${ziele[@]}"; do
      q="$LAGER/${z//\//_}"
      if [ -d "$q" ]; then mkdir -p "$z" && cp -a "$q/." "$z/" && echo "$z: aus Lager ($(du -sh "$q" | cut -f1))"; else echo "$z: noch kein Lager"; fi
    done ;;
  sichern)
    mkdir -p "$LAGER"
    for z in "${ziele[@]}"; do
      q="$LAGER/${z//\//_}"
      [ -d "$z" ] || continue
      rm -rf "$q.neu" && cp -a "$z" "$q.neu" && rm -rf "$q" && mv "$q.neu" "$q" && echo "$z: gesichert ($(du -sh "$q" | cut -f1))"
    done ;;
  *) echo "Aufruf: bash scripts/ci/next-cache.sh holen|sichern"; exit 2 ;;
esac
