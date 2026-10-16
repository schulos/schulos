#!/usr/bin/env bash
# OWASP-ZAP-Baseline gegen einen laufenden SchulOS-Stack (B-54, docs/SICHERHEIT.md S14): passiv (Spider + passive Regeln,
# keine Angriffe) – einmal ohne Anmeldung, einmal als Lehrkraft (Sitzungs-Cookie über die Anmelde-API, nur Demo-Instanz).
#   bash scripts/zap-scan.sh https://localhost:8443 [ausgabeordner] [benutzer] [passwort]
# Ergebnis: <ausgabe>/zap-{anonym,angemeldet}.{html,json}, Zusammenfassung auf stdout. Bricht ab, wenn eine Regel auf FAIL
# steht (.zap/regeln.tsv); WARN nur im Bericht.
set -euo pipefail
URL=${1:?Adresse}
OUT=$(readlink -f "${2:-zap}")
USER_NAME=${3:-jana.brandt}
PASS=${4:-schulos}
IMAGE=${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}
mkdir -p "$OUT"
chmod 777 "$OUT" # ZAP läuft im Container als Benutzer zap
cp .zap/regeln.tsv "$OUT/regeln.tsv"
host=$(echo "$URL" | sed -E 's#^https?://([^/:]+).*#\1#')

zap() { # <name> [zusätzliche ZAP-Optionen]
  local name=$1
  shift
  # --network host: der Stack lauscht auf dem Runner; -I: WARN bricht nicht ab, nur FAIL (regeln.tsv)
  docker run --rm --network host -v "$OUT:/zap/wrk:rw" "$IMAGE" zap-baseline.py -t "$URL" -c regeln.tsv -I -j \
    -r "zap-$name.html" -J "zap-$name.json" "$@" && rc=0 || rc=$?
  [ -f "$OUT/zap-$name.json" ] || { echo "ZAP $name: kein Bericht (Exit $rc) – Ausgabe oben" >&2; return 1; }
  node -e '
    const r = require(process.argv[1]);
    const alerts = (r.site ?? []).flatMap((s) => s.alerts ?? []);
    const risk = ["Info", "Niedrig", "Mittel", "Hoch"];
    console.log(`ZAP ${process.argv[2]}: ${alerts.length} Hinweise`);
    for (const a of alerts.sort((x, y) => y.riskcode - x.riskcode)) console.log(`  [${risk[a.riskcode] ?? a.riskcode}] ${a.pluginid} ${a.name} (${a.count}×)`);
  ' "$OUT/zap-$name.json" "$name"
  return $rc
}

status=0
zap anonym || status=$?

# Sitzung holen wie ein Browser (Origin-Prüfung von Better-Auth), Cookie an jede Anfrage von ZAP hängen – nur das
# Sitzungs-Cookie: ZAP trennt -config-Werte an Leerzeichen
cookie=$(curl -sk -c - -o /dev/null -H 'content-type: application/json' -H "origin: $URL" \
  -d "{\"username\":\"$USER_NAME\",\"password\":\"$PASS\"}" "$URL/api/auth/sign-in/username" |
  awk '$6 ~ /session_token$/ {printf "%s=%s", $6, $7; exit}')
[ -n "$cookie" ] || { echo "Anmeldung als $USER_NAME für ZAP fehlgeschlagen" >&2; exit 1; }
zap angemeldet -z "-config replacer.full_list(0).description=sitzung -config replacer.full_list(0).enabled=true \
-config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=Cookie -config replacer.full_list(0).regex=false \
-config replacer.full_list(0).replacement=$cookie" || status=$?
echo "Berichte: $OUT (Host $host)"
exit $status
