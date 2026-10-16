#!/bin/bash
# Zwei ISOs dateiweise vergleichen (B-47, aufgerufen von iso/repro.sh im Container): ISO und Live-System (squashfs)
# entpacken, Prüfsummen je Datei vergleichen. Erlaubt sind nur die bekannten Abweichungen (ERLAUBT); für alle anderen
# Dateien schreibt diffoscope einen Bericht. Exit 0 = nur erlaubte Abweichungen, 1 = sonst.
#   bash repro-compare.sh <a.iso> <b.iso> <arbeitsordner>
set -euo pipefail
A=$1 B=$2 W=$3
# Next.js baut nicht bitgleich (Chunk-/Action-IDs, Zufallsschlüssel für Vorschau und Server Actions, die geheim bleiben
# müssen) → App- und Backup-Image unterscheiden sich, damit auch deren Image-ID in der Stückliste. Fällt mit B-49 weg
# (ISO aus den signierten Release-Images). sha256sum.txt (Prüfsummenliste von live-build) folgt nur aus den übrigen Dateien,
# die einzeln verglichen werden – die squashfs unten als Ganzes und Datei für Datei.
ERLAUBT='^(schulos/images/schulos\.tar\.gz|schulos/images/schulos-backup\.tar\.gz|schulos/STUECKLISTE\.json|sha256sum\.txt)$'

mkdir -p "$W"
for s in a b; do
  iso=$A; [ $s = a ] || iso=$B
  rm -rf "${W:?}/$s"; mkdir -p "$W/$s/iso"
  xorriso -osirrox on -indev "$iso" -extract / "$W/$s/iso" >/dev/null 2>&1
  chmod -R u+w "$W/$s/iso"
  unsquashfs -q -no-progress -d "$W/$s/live" "$W/$s/iso/live/filesystem.squashfs" >/dev/null
  (cd "$W/$s/iso" && find . -type f ! -path ./live/filesystem.squashfs -printf '%P\0' | sort -z | xargs -0 sha256sum) >"$W/$s.iso.sums"
  (cd "$W/$s/live" && find . \( -type f -o -type l \) -printf '%P\0' | sort -z |
    xargs -0 -I{} sh -c 'if [ -L "$1" ]; then echo "link:$(readlink "$1")  $1"; else sha256sum "$1"; fi' _ {}) >"$W/$s.live.sums"
done

# Pfade, deren Prüfsumme (oder Existenz) abweicht
differ() { { diff <(sort -k2 "$W/a.$1.sums") <(sort -k2 "$W/b.$1.sums") || true; } | sed -n 's/^[<>] [^ ]*  //p' | sort -u; }
ISO_DIFF=$(differ iso)
LIVE_DIFF=$(differ live)
cmp -s "$W/a/iso/live/filesystem.squashfs" "$W/b/iso/live/filesystem.squashfs" && SQ=gleich || SQ=verschieden
echo "ISO: $(wc -l <"$W/a.iso.sums") Dateien, $(printf '%s' "$ISO_DIFF" | grep -c . || true) verschieden"
echo "Live-System: $(wc -l <"$W/a.live.sums") Dateien, $(printf '%s' "$LIVE_DIFF" | grep -c . || true) verschieden (squashfs als Ganzes: $SQ)"
ERLAUBT_HIER=$(printf '%s\n' "$ISO_DIFF" | grep -E "$ERLAUBT" || true)
REST_ISO=$(printf '%s\n' "$ISO_DIFF" | grep -vE "$ERLAUBT" | grep . || true)
[ -z "$ERLAUBT_HIER" ] || { echo "-- erlaubt (Next.js, B-49):"; printf '  %s\n' $ERLAUBT_HIER; }

FAIL=""
: >"$W/diffoscope.txt"
report() { # <a> <b> <name>
  echo "######## $3" >>"$W/diffoscope.txt"
  timeout 1800 diffoscope --text - --max-report-size 1048576 --max-diff-block-lines 100 "$1" "$2" >>"$W/diffoscope.txt" 2>&1 || true
}
if [ -n "$REST_ISO" ]; then
  FAIL=1; echo "-- VERSCHIEDEN auf dem Medium:"; printf '  %s\n' $REST_ISO
  for p in $REST_ISO; do [ -f "$W/a/iso/$p" ] && [ -f "$W/b/iso/$p" ] && report "$W/a/iso/$p" "$W/b/iso/$p" "$p"; done
fi
if [ -n "$LIVE_DIFF" ]; then
  FAIL=1; echo "-- VERSCHIEDEN im Live-System:"; printf '  %s\n' $LIVE_DIFF | head -n 100
  for p in $(printf '%s\n' "$LIVE_DIFF" | head -n 30); do [ -f "$W/a/live/$p" ] && [ -f "$W/b/live/$p" ] && report "$W/a/live/$p" "$W/b/live/$p" "live/$p"; done
elif [ $SQ = verschieden ]; then
  # gleicher Inhalt, andere Bytes → Metadaten (Zeitstempel, Rechte, Reihenfolge)
  FAIL=1; echo "-- squashfs: gleicher Inhalt, andere Metadaten"
  report "$W/a/iso/live/filesystem.squashfs" "$W/b/iso/live/filesystem.squashfs" live/filesystem.squashfs
fi
[ -z "$FAIL" ] && echo "=== Reproduzierbar (bis auf die erlaubten Next.js-Images)" || echo "=== NICHT reproduzierbar – Bericht: diffoscope.txt"
[ -z "$FAIL" ]
