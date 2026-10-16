#!/usr/bin/env bash
# Stack-Test Gerätezertifikate (P4-40b, SICHERHEIT.md S27/S28) gegen den laufenden Compose-Stack – CI-Job `stack`.
# Baut mit openssl eine Test-CA (statt step-ca: so lassen sich auch abgelaufene Zertifikate erzeugen), legt ihre Wurzel ins
# Volume geraete_ca, trägt „gültig“ und „gesperrt“ in die Freigabeliste ein, startet App und Caddy mit SCHULOS_DEVICE_CERTS=an
# und prüft je Modus (keiner, alles) mit scripts/geraetezertifikat-test.mjs: gültig / gesperrt / unbekannt (richtige CA, nicht
# freigegeben) / abgelaufen / fremde CA / gefälschte Kennzeichen ohne Zertifikat. Danach wieder die Vorgaben.
# Voraussetzung: Stack läuft (Projekt „schulos“, .env mit SCHULOS_TRUSTED_PROXIES=private_ranges), Demo-Daten.
# Aufruf: bash scripts/geraetezertifikat-test.sh [basis-url]
set -euo pipefail
base="${1:-https://localhost:8443}"
dir="$(pwd)/.ci-geraete"
rm -rf "$dir"
mkdir -p "$dir"

(
  cd "$dir"
  ca() { openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.crt" -days 30 -subj "/CN=$2" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null; }
  ca ca "SchulOS Test-CA"
  ca fremd "Fremde CA"
  printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n' > leaf.ext
  leaf() {
    openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=geraet-$1" 2>/dev/null
    openssl x509 -req -in "$1.csr" -CA "$2.crt" -CAkey "$2.key" -CAcreateserial -out "$1.crt" -days 30 -extfile leaf.ext 2>/dev/null
  }
  leaf gueltig ca
  leaf gesperrt ca
  leaf unbekannt ca
  leaf fremdgeraet fremd
  # abgelaufen: feste Daten in der Vergangenheit (openssl ca kann Start/Ende setzen)
  printf '[ca]\ndefault_ca=t\n[t]\ndatabase=index.txt\nnew_certs_dir=.\nserial=serial\ndefault_md=sha256\npolicy=p\nx509_extensions=e\n[p]\ncommonName=supplied\n[e]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n' > ca.cnf
  : > index.txt
  echo 1000 > serial
  openssl req -newkey rsa:2048 -nodes -keyout abgelaufen.key -out abgelaufen.csr -subj "/CN=geraet-abgelaufen" 2>/dev/null
  openssl ca -batch -config ca.cnf -cert ca.crt -keyfile ca.key -in abgelaufen.csr -out abgelaufen.crt -startdate 20240101000000Z -enddate 20240102000000Z -notext 2>/dev/null
)
fp() { openssl x509 -in "$dir/$1.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d : | tr 'A-F' 'a-f'; }

# Wurzel der Test-CA dorthin, wo sonst step-ca sie ablegt (Caddy trust_pool; Zwischenzertifikat = dieselbe Datei)
docker run --rm -v schulos_geraete_ca:/ca -v "$dir:/t:ro" --entrypoint sh "${SCHULOS_CADDY_IMAGE:-caddy:2}" \
  -c 'cp /t/ca.crt /ca/root_ca.crt && cp /t/ca.crt /ca/intermediate_ca.crt && chmod 0644 /ca/*.crt'

psql() { docker compose exec -T postgres psql -U schulos -d schulos -v ON_ERROR_STOP=1 -qAt "$@"; }
psql -c "delete from device_certs where id like 'ci-%'"
psql -c "insert into device_certs (id, label, common_name, fingerprint, serial, not_before, not_after) values
  ('ci-gueltig', 'CI gültig', 'geraet-gueltig', '$(fp gueltig)', '01', now() - interval '1 day', now() + interval '30 days'),
  ('ci-gesperrt', 'CI gesperrt', 'geraet-gesperrt', '$(fp gesperrt)', '02', now() - interval '1 day', now() + interval '30 days')"
psql -c "update device_certs set revoked_at = now(), revoke_reason = 'verloren' where id = 'ci-gesperrt'"

status=0
for modus in keiner alles; do
  SCHULOS_DEVICE_CERTS=an SCHULOS_PUBLIC_ACCESS=$modus docker compose up -d --wait --wait-timeout 180 app caddy
  # Fehlversuche aus dem vorigen Durchlauf sollen keine Kontosperre auslösen
  psql -c "delete from auth_throttle"
  node scripts/geraetezertifikat-test.mjs "$base" "$modus" "$dir" --insecure || status=1
done

psql -c "delete from auth_throttle"
psql -c "delete from device_certs where id like 'ci-%'"
docker compose up -d --wait --wait-timeout 180 app caddy
rm -rf "$dir"
exit $status
