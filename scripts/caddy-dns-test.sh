#!/usr/bin/env bash
# CA-07/CA-08: Caddy mit DNS-Modulen prüfen, so weit es ohne echte Domain geht (CI-Job „stack“, laufender Stack nötig):
#   1. das Image kennt jeden Anbieter aus apps/installer/src/dns.ts (dns.providers.<name>)
#   2. das echte Caddyfile des Stacks (aus dem Container) lässt sich je Anbieter und mit/ohne ACME-Staging umwandeln und
#      validieren; die Zugangsdaten stehen dabei nie in der umgewandelten Konfiguration (Laufzeit-Platzhalter {env.…})
#   3. das Standard-Image bricht beim Start mit DNS-Prüfung verständlich ab (caddy-start)
#   4. das Image ersetzt caddy:2 im laufenden Stack ohne Unterschied (gleiche Pfade, Smoketest) – danach wieder caddy:2
# Was hier nicht geht: ein echtes Zertifikat per DNS-Prüfung (braucht Domain + Zugang beim Anbieter) →
# scripts/acme-staging-test.sh von Hand (INSTALLATION.md §5d.1, manuelle Prüfung).
# Aufruf: bash scripts/caddy-dns-test.sh <image> [https-url für den Smoketest]
set -euo pipefail
IMG=${1:?Image mit DNS-Modulen, z. B. schulos-caddy-dns:ci}
URL=${2:-https://localhost:8443}
cd "$(dirname "$0")/.."
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

providers=$(sed -n 's/^ *{ value: "\([a-z0-9]*\)", label:.*/\1/p' apps/installer/src/dns.ts)
[ -n "$providers" ] || { echo "Keine Anbieter in apps/installer/src/dns.ts gefunden" >&2; exit 1; }

echo "== 1. Module im Image $IMG"
mods=$(docker run --rm --entrypoint caddy "$IMG" list-modules)
for p in $providers; do
  grep -qx "dns.providers.$p" <<<"$mods" || { echo "dns.providers.$p fehlt im Image" >&2; exit 1; }
  echo "  dns.providers.$p ✓"
done
docker run --rm --entrypoint caddy "$IMG" version

echo "== 2. Caddyfile des Stacks je Anbieter"
docker compose exec -T caddy cat /etc/caddy/Caddyfile >"$dir/Caddyfile"
docker compose exec -T caddy cat /etc/schulos/caddy-start.sh >"$dir/caddy-start.sh"
# Platzhalter-Zugang, je Lauf zufällig (Cloudflare prüft das Format beim Start: 35–50 Zeichen)
TOKEN=ci$(od -An -N19 -tx1 /dev/urandom | tr -d ' \n')
SECRET=ci$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
for p in $providers; do
  for staging in 0 1; do
    args=(--rm --entrypoint caddy -v "$dir/Caddyfile:/etc/caddy/Caddyfile:ro"
      -e SCHULOS_DOMAIN=schulos.example.org -e SCHULOS_TLS=ci@example.org -e "SCHULOS_TLS_DNS=$p" -e "SCHULOS_ACME_STAGING=$staging"
      -e "SCHULOS_DNS_TOKEN=$TOKEN" -e SCHULOS_DNS_USER=12345 -e "SCHULOS_DNS_SECRET=$SECRET" -e SCHULOS_DNS_SERVER=ns1.example.org:53
      -e SCHULOS_DNS_KEY_ALG=hmac-sha256 -e "SCHULOS_DNS_RESOLVERS=9.9.9.9 1.1.1.1")
    json=$(docker run "${args[@]}" "$IMG" adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null)
    grep -q "\"name\":\"$p\"" <<<"$json" || { echo "$p: keine DNS-Prüfung in der Konfiguration" >&2; exit 1; }
    grep -q '"resolvers":\["9.9.9.9","1.1.1.1"\]' <<<"$json" || { echo "$p: resolvers fehlen" >&2; exit 1; }
    if grep -q -e "$TOKEN" -e "$SECRET" <<<"$json"; then echo "$p: Zugangsdaten stehen in der Konfiguration" >&2; exit 1; fi
    if [ "$staging" = 1 ]; then grep -q acme-staging-v02 <<<"$json" || { echo "$p: Staging fehlt" >&2; exit 1; }
    elif grep -q acme-staging <<<"$json"; then echo "$p: Staging ohne SCHULOS_ACME_STAGING" >&2; exit 1; fi
    docker run "${args[@]}" "$IMG" validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>"$dir/validate.log" ||
      { tail -n 5 "$dir/validate.log" | sed "s/$TOKEN/<token>/g; s/$SECRET/<secret>/g" >&2; echo "$p: validate fehlgeschlagen" >&2; exit 1; }
  done
  echo "  $p: umgewandelt + validiert (mit und ohne Staging), Zugang nur als Platzhalter ✓"
done

echo "== 3. Standard-Image mit DNS-Prüfung bricht verständlich ab"
std=$(docker compose config --images | grep -m1 '^caddy:' || echo caddy:2)
if out=$(docker run --rm --entrypoint sh -e SCHULOS_TLS_DNS=cloudflare -e SCHULOS_TLS=ci@example.org \
  -v "$dir/caddy-start.sh:/start.sh:ro" "$std" /start.sh 2>&1); then
  echo "Standard-Image ($std) startete trotz SCHULOS_TLS_DNS" >&2; exit 1
fi
grep -q SCHULOS_CADDY_DNS_IMAGE <<<"$out" || { echo "Meldung ohne Hinweis: $out" >&2; exit 1; }
echo "  $std: $out ✓"

echo "== 4. Image im laufenden Stack statt caddy:2 (eigene CA)"
SCHULOS_CADDY_IMAGE=$IMG docker compose up -d --wait --wait-timeout 120 caddy
node scripts/smoke.mjs "$URL" --insecure
docker compose up -d --wait --wait-timeout 120 caddy
echo "Caddy mit DNS-Modulen geprüft ✓"
