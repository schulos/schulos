#!/usr/bin/env bash
# INST-10: Aufruf über die IP-Adresse bzw. einen fremden Namen (z. B. Rechnername.local) muss bei der App landen –
# erkennbar an der Weiterleitung zur Anmeldung. Vorher passte der Host-Header auf keinen Caddy-Block und Caddy antwortete
# mit „200“ ohne Inhalt (weiße Seite); INST-04 hatte nur den TLS-Handshake geprüft.
# Aufruf: bash scripts/ci/per-ip.sh <https-port> [<http-port> <domain>]   (Hauptsystem und Backupserver, beide leiten ohne
# Sitzung auf /login). Mit HTTP-Port (nur Hauptsystem): http://<IP> zeigt im Schulnetz die Hinweisseite (ZERTIFIKATE.md
# Teil A), die Domain und Aufrufe von außen werden weiter auf https umgeleitet.
set -euo pipefail
PORT=${1:?Port fehlt}
HTTP_PORT=${2:-}
DOMAIN=${3:-localhost}

pruefen() {
  local name=$1
  shift
  local out code loc
  out=$(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 "$@" || true)
  code=${out%% *}
  loc=${out#* }
  case "$code" in
    3??) ;;
    *)
      echo "✗ $name: HTTP $code statt Weiterleitung zur Anmeldung"
      # Ursache sichtbar machen (TLS-Fehler, Verbindung abgewiesen, Zeitüberschreitung)
      curl -skv -o /dev/null --max-time 20 "$@" 2>&1 | grep -E '^\* |^< HTTP' | tail -n 15 || true
      exit 1
      ;;
  esac
  case "$loc" in */login*) ;; *) echo "✗ $name: Weiterleitung nach „$loc“ statt /login"; exit 1 ;; esac
  echo "✓ $name → $loc"
}

pruefen "per IP (ohne SNI)" "https://127.0.0.1:$PORT/"
pruefen "fremder Name (unbekannte SNI)" --resolve "fremd.local:$PORT:127.0.0.1" "https://fremd.local:$PORT/"


[ -n "$HTTP_PORT" ] || exit 0

# Antwort holen: Inhalt in $TMP_BODY, Status als Ausgabe
TMP_BODY=$(mktemp)
trap 'rm -f "$TMP_BODY"' EXIT
holen() { curl -s -o "$TMP_BODY" -w '%{http_code}' --max-time 20 "$@" || true; }

# Hinweisseite: 200, nennt die Domain, Link zum Schul-Zertifikat (eigene CA ist die Vorgabe), Host-Header maskiert
code=$(holen -H 'Host: x&y' "http://127.0.0.1:$HTTP_PORT/irgendwo")
[ "$code" = 200 ] || { echo "✗ http per IP: HTTP $code statt Hinweisseite"; head -c 400 "$TMP_BODY"; exit 1; }
grep -q "Bitte über die Schuladresse aufrufen" "$TMP_BODY" || { echo "✗ http per IP: keine Hinweisseite"; head -c 400 "$TMP_BODY"; exit 1; }
grep -q "https://$DOMAIN" "$TMP_BODY" || { echo "✗ Hinweisseite ohne Link auf https://$DOMAIN"; exit 1; }
grep -q 'href="/ca.crt"' "$TMP_BODY" || { echo "✗ Hinweisseite ohne Link zum Schul-Zertifikat"; exit 1; }
if grep -q 'x&y' "$TMP_BODY"; then echo "✗ Hinweisseite gibt den Host-Header unmaskiert aus"; exit 1; fi
grep -q 'x&amp;y' "$TMP_BODY" || { echo "✗ Hinweisseite: aufgerufener Name fehlt"; exit 1; }
echo "✓ http per IP → Hinweisseite"

umleitung() {
  local name=$1
  shift
  local out
  out=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 "$@" || true)
  case "$out" in
    30[178]" https://"*) echo "✓ $name → ${out#* }" ;;
    *) echo "✗ $name: „$out“ statt Weiterleitung auf https"; exit 1 ;;
  esac
}
umleitung "http mit der Domain" -H "Host: $DOMAIN" "http://127.0.0.1:$HTTP_PORT/login"
# von außen (X-Forwarded-For; im CI-Stack gilt der Docker-Gateway als Proxy) keine Hinweisseite, nur die Weiterleitung
umleitung "http per IP von außen" -H 'X-Forwarded-For: 203.0.113.9' "http://127.0.0.1:$HTTP_PORT/"

# /ca.crt über http per IP geht an die App (ohne abgelegte Root 404, mit Root das Zertifikat) – nie die Hinweisseite
code=$(holen "http://127.0.0.1:$HTTP_PORT/ca.crt")
case "$code" in
  200) grep -q "BEGIN CERTIFICATE" "$TMP_BODY" || { echo "✗ /ca.crt: 200 ohne Zertifikat"; exit 1; } ;;
  404) ;;
  *) echo "✗ /ca.crt über http: HTTP $code"; exit 1 ;;
esac
if grep -q "Schuladresse" "$TMP_BODY"; then echo "✗ /ca.crt liefert die Hinweisseite"; exit 1; fi
echo "✓ /ca.crt über http per IP → App ($code)"
