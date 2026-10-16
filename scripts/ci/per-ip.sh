#!/usr/bin/env bash
# INST-10: Aufruf über die IP-Adresse bzw. einen fremden Namen (z. B. Rechnername.local) muss bei der App landen –
# erkennbar an der Weiterleitung zur Anmeldung. Vorher passte der Host-Header auf keinen Caddy-Block und Caddy antwortete
# mit „200“ ohne Inhalt (weiße Seite); INST-04 hatte nur den TLS-Handshake geprüft.
# Aufruf: bash scripts/ci/per-ip.sh <https-port>   (Hauptsystem und Backupserver, beide leiten ohne Sitzung auf /login)
set -euo pipefail
PORT=${1:?Port fehlt}

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
