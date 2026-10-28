#!/usr/bin/env bash
# Platzwächter für die Build-VM (self-hosted Runner „schulos-iso“) – läuft am Anfang jedes Jobs dort
# (.github/actions/platz). Anlass: die VM lief voll (Build-Cache ~26 GB), der Runner stürzte mitten im Job ab und war offline.
# Stufen:
#   1. immer: verwaiste Images, Cache der ISO-Builder „schulos-repro-*“ (Bau ist --no-cache), Build-Cache älter als 3 Tage,
#      liegen gebliebene Bau-Container
#   2. unter PLATZ_AUFRAEUMEN_GB frei (Vorgabe 30): ganzer Build-Cache, Images älter als 7 Tage, alte Abbilder im ISO-Lager
#   3. unter PLATZ_MINDEST_GB frei (Vorgabe 15): Job bricht mit klarer Meldung ab – besser als ein Absturz mitten im Lauf
# Gezogene Basis-Images der letzten Tage und die letzte ISO bleiben (Caches der VM).
set -uo pipefail
AUFRAEUMEN_GB=${PLATZ_AUFRAEUMEN_GB:-30}
MINDEST_GB=${PLATZ_MINDEST_GB:-15}
LAGER=${ISO_LAGER:-$HOME/schulos-iso}
frei() { df -BG --output=avail / | tail -n 1 | tr -dc '0-9'; }

echo "Frei vorher: $(frei) GB"
for b in $(docker buildx ls 2>/dev/null | awk '/^schulos-repro-/ { print $1 }'); do
  docker buildx prune --builder "$b" -af >/dev/null 2>&1 || true
done
docker rm -f schulos-iso-build schulos-repro-a schulos-repro-b schulos-repro-diff >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -af --filter until=72h >/dev/null 2>&1 || true

if [ "$(frei)" -lt "$AUFRAEUMEN_GB" ]; then
  echo "::warning::Build-VM: nur $(frei) GB frei (< $AUFRAEUMEN_GB) – räume gründlich auf"
  docker builder prune -af >/dev/null 2>&1 || true
  docker image prune -af --filter until=168h >/dev/null 2>&1 || true
  rm -rf "$HOME/.cache/schulos-next"  # Next-Build-Cache (scripts/ci/next-cache.sh), entsteht beim nächsten e2e-Job neu
  # Abbilder (qcow2) und Rückstände im ISO-Lager älter als 7 Tage; die letzte ISO bleibt
  [ -d "$LAGER" ] && find "$LAGER" -maxdepth 1 -type f ! -name 'letzte.*' -mtime +7 -print -delete
fi

docker system df 2>/dev/null || true
F=$(frei)
echo "Frei nachher: $F GB"
if [ "$F" -lt "$MINDEST_GB" ]; then
  echo "::error::Build-VM: nur $F GB frei (< $MINDEST_GB) – bitte aufräumen (docker system df, $LAGER), Job bricht ab"
  exit 1
fi
