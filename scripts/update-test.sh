#!/usr/bin/env bash
# Update-Test N−1 → N (B-39, INSTALLATION.md §7 ohne ISO): Hauptsystem mit der vorigen Version starten, mit schulosctl auf den
# aktuellen Stand aktualisieren (signiertes Test-Release, Probelauf auf einer Kopie, Löschnachweis), danach ein Release, dessen
# Backup-Agent nicht startet → schulosctl muss zurück auf N (alte Images + Datenstand von vor dem Update).
#   bash scripts/update-test.sh [N−1-ref]     (Vorgabe: neuester Release-Tag mit schulosctl-Unterstützung, sonst HEAD~1)
# CI-Job „update“ (von Hand und vor Releases). Hinterlässt nichts: Stack, Registry, Images und .env werden entfernt.
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=schulos-ut
REG=localhost:5599
WORK=$(mktemp -d)
CTL="node apps/ctl/dist/schulosctl.mjs --dir ."
fail() { echo "✗ $1"; docker compose logs --no-color --tail 60 app backup-agent || true; exit 1; }
ok() { echo "✓ $1"; }
# status endet mit 1, weil das Backup hier nicht gekoppelt ist – geprüft wird der Text
status() { $CTL status 2>&1 || true; }

if [ -e .env ] || [ -e schulos.env ]; then echo "Abbruch: .env/schulos.env existiert – der Test braucht ein sauberes Repo"; exit 1; fi
cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f schulos-ut-registry >/dev/null 2>&1 || true
  git worktree remove --force "$WORK/alt" >/dev/null 2>&1 || true
  rm -rf "$WORK" .env schulos.env updates
}
trap cleanup EXIT

# N−1: neuester Release-Tag, der schulosctl schon kennt (src/cli.ts), sonst der vorige Commit
FROM_REF=${1:-}
if [ -z "$FROM_REF" ]; then
  for t in $(git tag -l 'v*' --sort=-v:refname); do
    if git cat-file -e "$t:src/cli.ts" 2>/dev/null; then FROM_REF=$t; break; fi
  done
  FROM_REF=${FROM_REF:-HEAD~1}
fi
echo "N−1 = $FROM_REF ($(git rev-parse --short "$FROM_REF")), N = $(git rev-parse --short HEAD)"
git worktree add --detach "$WORK/alt" "$FROM_REF" >/dev/null

docker run -d --name schulos-ut-registry -p 5599:5000 registry:2 >/dev/null
digest() {
  curl -sI -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" \
    "http://$REG/v2/$1/manifests/$2" | awk 'tolower($1)=="docker-content-digest:" {print $2}' | tr -d '\r'
}
build() { # <kontext> <version>
  docker build -q --build-arg SCHULOS_VERSION="$2" -t "$REG/schulos:$2" "$1" >/dev/null
  docker build -q --build-arg SCHULOS_VERSION="$2" -f "$1/apps/agent/Dockerfile" -t "$REG/schulos-agent:$2" "$1" >/dev/null
  docker push -q "$REG/schulos:$2" >/dev/null && docker push -q "$REG/schulos-agent:$2" >/dev/null
}
build "$WORK/alt" 1.0.0 || fail "Images N−1 bauen"
build . 1.0.1 || fail "Images N bauen"
# 1.0.2: App in Ordnung (besteht den Probelauf), aber der Backup-Agent stürzt sofort ab – der echte Stack startet nicht
docker build -q --build-arg SCHULOS_VERSION=1.0.2 -t "$REG/schulos:1.0.2" . >/dev/null && docker push -q "$REG/schulos:1.0.2" >/dev/null
printf 'FROM %s/schulos-agent:1.0.1\nCMD ["node", "-e", "process.exit(3)"]\n' "$REG" | docker build -q -t "$REG/schulos-agent:kaputt" - >/dev/null
docker push -q "$REG/schulos-agent:kaputt" >/dev/null
A0="$REG/schulos@$(digest schulos 1.0.0)"; G0="$REG/schulos-agent@$(digest schulos-agent 1.0.0)"
A1="$REG/schulos@$(digest schulos 1.0.1)"; G1="$REG/schulos-agent@$(digest schulos-agent 1.0.1)"
A2="$REG/schulos@$(digest schulos 1.0.2)"; GX="$REG/schulos-agent@$(digest schulos-agent kaputt)"
ok "Images N−1 (1.0.0), N (1.0.1), 1.0.2 mit kaputtem Agent in der lokalen Registry"

npx tsx scripts/ci/test-release.ts --keys "$WORK/keys" --out "$WORK/gut/v1.0.1" --version 1.0.1 --app "$A1" --agent "$G1"
npx tsx scripts/ci/test-release.ts --keys "$WORK/keys" --out "$WORK/kaputt/v1.0.2" --version 1.0.2 --app "$A2" --agent "$GX"
export SCHULOS_RELEASE_KEY="$WORK/keys/test.pub"
[ -f apps/ctl/dist/schulosctl.mjs ] || npm run build -w @schulos/ctl >/dev/null

printf 'POSTGRES_PASSWORD=ut-%s\nSCHULOS_DOMAIN=localhost\nSCHULOS_HTTP_PORT=8080\nSCHULOS_HTTPS_PORT=8443\nSCHULOS_PUBLIC_PORT=:8443\nSCHULOS_IMAGE=%s\nSCHULOS_AGENT_IMAGE=%s\n' \
  "$RANDOM$RANDOM" "$A0" "$G0" > .env
echo "SCHULOS_INSTANCE=demo" > schulos.env
# N−1 mit seiner eigenen Compose-Datei (so liegt sie auf installierten Servern; ab v0.3.2 tauscht `update` sie aus, wenn das
# Release sie mitbringt – die Test-Releases hier haben keine Host-Dateien, das prüft host-files.test.ts). Vor SEC-07
# war dort „schulos“ der Superuser; dann kennt die alte .env auch kein POSTGRES_ADMIN_PASSWORD.
ALT_ROLLE=nein
if grep -q POSTGRES_ADMIN_PASSWORD "$WORK/alt/compose.yaml"; then
  echo "POSTGRES_ADMIN_PASSWORD=ut-adm-$RANDOM$RANDOM" >> .env
else
  ALT_ROLLE=ja
fi
docker compose -f "$WORK/alt/compose.yaml" --project-directory . up -d --wait --wait-timeout 300 >/dev/null 2>&1 || fail "Stack N−1 startet"
status | grep -q "SchulOS 1.0.0 · Instanz demo" || fail "N−1 meldet sich nicht als 1.0.0"
docker compose exec -T postgres psql -U schulos -d schulos -qc "insert into app_settings (key, value) values ('update-test', '\"vorher\"')" || fail "Markierung"
if [ $ALT_ROLLE = ja ]; then
  test "$(docker compose exec -T postgres psql -U schulos -d schulos -tAc "select rolsuper from pg_roles where rolname = 'schulos'")" = t || fail "N−1: schulos sollte Superuser sein"
fi
ok "Hauptsystem N−1 läuft (Demo, PostgreSQL, alte Datenbankrolle: $ALT_ROLLE), Markierung gesetzt"

OUT=$($CTL update --quelle "$WORK/gut" --ohne-backup 2>&1) || fail "Update N−1 → N: $OUT"
echo "$OUT" | grep -E "✓|✗" | sed 's/^/  /'
echo "$OUT" | grep -q "✓ probelauf 1.0.0 → 1.0.1" || fail "Probelauf fehlt"
echo "$OUT" | grep -q "✓ loeschnachweis" || fail "Löschnachweis fehlt"
status | grep -q "SchulOS 1.0.1 · Instanz demo" || fail "läuft nicht als 1.0.1"
docker compose exec -T postgres psql -U schulos -d schulos -tAc "select value from app_settings where key = 'update-test'" | grep -q vorher || fail "Daten nach dem Update weg"
node scripts/smoke.mjs https://localhost:8443 --insecure >/dev/null || fail "Smoketest nach dem Update"
ok "Update N−1 → N: Probelauf, Löschnachweis, Daten erhalten, Smoketest"

# SEC-07: App-Rolle ohne Superuser, Wartungsrolle postgres mit Passwort aus .env, Eigentum bei schulos; zweiter Lauf ändert nichts
pq() { docker compose exec -T postgres psql -U postgres -d schulos -tAc "$1"; }
if [ $ALT_ROLLE = ja ]; then echo "$OUT" | grep -q "✓ db-rolle" || fail "Umstellung der Datenbankrolle fehlt im Protokoll"; fi
grep -q '^POSTGRES_ADMIN_PASSWORD=.' .env || fail "POSTGRES_ADMIN_PASSWORD fehlt in .env"
test "$(pq "select rolsuper from pg_roles where rolname = 'schulos'")" = f || fail "schulos ist noch Superuser"
test "$(pq "select rolsuper from pg_roles where rolname = 'postgres'")" = t || fail "Wartungsrolle postgres fehlt"
test "$(pq "select count(*) from pg_roles where rolname = 'schulos_sec07'")" = 0 || fail "Hilfsrolle nicht entfernt"
test "$(pq "select pg_get_userbyid(datdba) from pg_database where datname = 'schulos'")" = schulos || fail "Datenbank gehört nicht schulos"
test "$(pq "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'S', 'v') and pg_get_userbyid(c.relowner) <> 'schulos' and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')")" = 0 \
  || fail "Objekte gehören nicht schulos"
ADM=$(sed -n 's/^POSTGRES_ADMIN_PASSWORD=//p' .env)
docker compose exec -T -e PGPASSWORD="$ADM" postgres psql -h 127.0.0.1 -U postgres -d schulos -tAc "select 1" | grep -q 1 || fail "Passwort der Wartungsrolle passt nicht"
OUT2=$($CTL db-rolle 2>&1) || fail "db-rolle: $OUT2"
echo "$OUT2" | grep -q "nichts zu tun" || fail "db-rolle nicht idempotent: $OUT2"
ok "SEC-07: schulos ohne Superuser, Wartungsrolle postgres, Eigentum geprüft, zweiter Lauf ohne Änderung"

OUT=$($CTL update --quelle "$WORK/kaputt" --ohne-backup 2>&1) && fail "Update mit kaputtem Agent hätte scheitern müssen: $OUT"
echo "$OUT" | grep -E "✓|✗|zurückgerollt" | sed 's/^/  /'
echo "$OUT" | grep -q "zurückgerollt" || fail "kein Rückweg: $OUT"
grep -q "SCHULOS_AGENT_IMAGE=$G1" .env || fail ".env nicht zurückgesetzt"
status | grep -q "SchulOS 1.0.1 · Instanz demo" || fail "nach dem Rückweg nicht 1.0.1"
docker compose exec -T postgres psql -U schulos -d schulos -tAc "select value from app_settings where key = 'update-test'" | grep -q vorher || fail "Daten nach dem Rückweg weg"
node scripts/smoke.mjs https://localhost:8443 --insecure >/dev/null || fail "Smoketest nach dem Rückweg"
ok "Rückweg: Stack startet mit 1.0.2 nicht → zurück auf 1.0.1 mit dem Datenstand von vorher"
echo "Update-Test bestanden."
