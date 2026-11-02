#!/usr/bin/env bash
# CA-08: Systemtest „Let's Encrypt per DNS-Prüfung“ mit der ACME-Staging-Umgebung – MANUELL (INSTALLATION.md §5d.1): braucht
# eine echte Domain, deren Zone beim DNS-Anbieter liegt, und einen Zugang mit Minimalrechten. In der CI nicht möglich (keine
# Domain, keine Zugangsdaten); dort prüft scripts/caddy-dns-test.sh alles bis zur Ausstellung.
# Ablauf: Caddy (Image mit DNS-Modulen) allein in einem eigenen Compose-Projekt starten (ohne App – für die Ausstellung
# nicht nötig), Testzertifikat aus der Staging-Umgebung holen lassen, mit `schulosctl zertifikat-pruefen --staging` prüfen,
# danach alles wieder entfernen. Staging-Zertifikate sind nicht vertrauenswürdig und zählen nicht gegen die Rate-Limits.
#
# Aufruf (Rechner mit Docker, Repo-Stand):
#   bash scripts/acme-staging-test.sh <env-datei> [image] [--behalten]
# <env-datei> (Rechte 600, nie einchecken): SCHULOS_DOMAIN=…, SCHULOS_TLS=<E-Mail>, SCHULOS_TLS_DNS=<anbieter> und die
# SCHULOS_DNS_*-Zugangsdaten wie vom Installer (apps/installer/src/dns.ts). [image]: Vorgabe – frisch gebaut aus deploy/caddy-dns.
# Ports 18080/18443 auf diesem Rechner; die Prüfung läuft lokal, kein Zugang aus dem Internet nötig.
set -euo pipefail
ENVFILE=${1:?env-Datei mit SCHULOS_DOMAIN, SCHULOS_TLS, SCHULOS_TLS_DNS, SCHULOS_DNS_*}
IMG=${2:-}
KEEP=0
for a in "$@"; do [ "$a" = --behalten ] && KEEP=1; done
[ "$IMG" = --behalten ] && IMG=
cd "$(dirname "$0")/.."
[ -f "$ENVFILE" ] || { echo "$ENVFILE fehlt" >&2; exit 1; }
grep -q '^SCHULOS_TLS_DNS=[a-z0-9]' "$ENVFILE" || { echo "SCHULOS_TLS_DNS fehlt in $ENVFILE" >&2; exit 1; }
if [ -z "$IMG" ]; then
  IMG=schulos-caddy-dns:staging-test
  docker build -q -f deploy/caddy-dns/Dockerfile --build-arg "GO_IMAGE=$(sh scripts/pin.sh golang)" \
    --build-arg "CADDY_IMAGE=$(sh scripts/pin.sh caddy)" -t "$IMG" . >/dev/null
fi
npm run build -w @schulos/ctl >/dev/null

dir=$(mktemp -d)
PROJECT=schulos-acme-staging
compose() { docker compose -p "$PROJECT" --project-directory "$dir" "$@"; }
aufraeumen() {
  if [ "$KEEP" = 1 ]; then echo "Behalten: $dir (Projekt $PROJECT) – aufräumen: docker compose -p $PROJECT --project-directory $dir down -v"; return; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$dir"
}
trap aufraeumen EXIT
cp compose.yaml "$dir/compose.yaml"
# Zugangsdaten nur in der .env des Testordners (600) – nie auf der Kommandozeile oder im Protokoll
(umask 077 && { cat "$ENVFILE"; printf 'SCHULOS_CADDY_IMAGE=%s\nSCHULOS_ACME_STAGING=1\nSCHULOS_HTTP_PORT=18080\nSCHULOS_HTTPS_PORT=18443\n' "$IMG"; } >"$dir/.env")
: >"$dir/schulos.env"

echo "== Caddy mit $(sed -n 's/^SCHULOS_TLS_DNS=//p' "$ENVFILE") starten (Staging)"
compose up -d --no-deps caddy
if node apps/ctl/dist/schulosctl.mjs --dir "$dir" zertifikat-pruefen --staging --warten "${SCHULOS_ACME_WARTEN:-1500}"; then
  echo "== ACME-Staging per DNS-Prüfung: Testzertifikat ausgestellt ✓"
  rc=0
else
  # Achtung: ein falsch formatierter Cloudflare-Token stünde in der Fehlermeldung des Moduls – Ausgabe nicht weitergeben
  echo "== kein Testzertifikat – Caddy-Protokoll (Ausschnitt, nur lokal ansehen):" >&2
  compose logs --no-color caddy 2>&1 | grep -iE 'acme|dns|challenge|error|obtain' | tail -n 30 >&2 || true
  rc=1
fi
exit $rc
