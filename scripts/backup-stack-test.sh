#!/usr/bin/env bash
# Stack-Test Backup (B-28, INSTALLATION.md §7 Schritte 1–3 ohne ISO): Backupserver + Hauptsystem als Compose-Stacks auf einem Host,
# Kopplung über TLS mit Caddys eigener CA (Pinning), Sicherung, Aufräumen, Prüfung und Test-Restore auf dem Backupserver.
# Aufruf aus dem Repo-Root: bash scripts/backup-stack-test.sh   (CI-Job „backup“; lokal mit Docker Desktop in Git Bash)
# Hinterlässt nichts: beide Stacks samt Volumes und das gemeinsame Netz werden am Ende entfernt.
set -euo pipefail
export MSYS_NO_PATHCONV=1

B="docker compose -p schulos-bt-backup -f compose.backup.yaml -f scripts/ci/compose.backup.test.yaml"
M="docker compose -p schulos-bt-main -f compose.yaml -f scripts/ci/compose.test.yaml"
# Der Backupserver ist im gemeinsamen Netz unter seiner Domain auf 443 erreichbar – ohne abweichenden öffentlichen Port
export SCHULOS_BACKUP_DOMAIN=backup.schulos.test SCHULOS_TLS=internal
export SCHULOS_DOMAIN=localhost POSTGRES_PASSWORD="ci-$RANDOM-$RANDOM" POSTGRES_ADMIN_PASSWORD="adm-$RANDOM-$RANDOM" RESTORE_TEST_DB_PASSWORD="rt-$RANDOM"
fail() { echo "✗ $1"; $B logs --no-color --tail 80 backup || true; $M logs --no-color --tail 80 backup-agent || true; exit 1; }
ok() { echo "✓ $1"; }

cleanup() {
  $M down -v --remove-orphans >/dev/null 2>&1 || true
  $B down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm schulos-verbund >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create schulos-verbund >/dev/null

# Stacks: getrennte Ports, damit beide auf einem Host laufen
SCHULOS_HTTP_PORT=9080 SCHULOS_HTTPS_PORT=9443 $B up -d --build --wait --wait-timeout 300 || fail "Backupserver startet"
ok "Backupserver läuft"
SCHULOS_HTTP_PORT=8080 SCHULOS_HTTPS_PORT=8443 SCHULOS_PUBLIC_PORT=:8443 $M up -d --build --wait --wait-timeout 300 app postgres backup-agent ||
  fail "Hauptsystem startet"
ok "Hauptsystem läuft (App, PostgreSQL, Backup-Agent)"
# SEC-13: Härtung am laufenden Stack (Caddy bleibt root, nur mit NET_BIND_SERVICE)
bash scripts/haertung-pruefen.sh schulos-bt-backup --root caddy --cap caddy=NET_BIND_SERVICE --rw caddy || fail "Container-Härtung Backupserver"
bash scripts/haertung-pruefen.sh schulos-bt-main --rw postgres || fail "Container-Härtung Hauptsystem"
ok "Container-Härtung (SEC-13)"

# Kopplung wie im Installer: über TLS mit Caddys eigener CA (Fingerabdruck wird gepinnt)
run_agent() { $M run --rm -T backup-agent node /opt/schulos-agent/agent.mjs "$@"; }
for i in $(seq 1 30); do $B exec -T backup test -r /ca/root.crt && break; sleep 2; done
# laufenden Agenten anhalten, bis die Wiederholung geprüft ist: seine erste Meldung beim Backupserver schließt das
# Wiederholungsfenster (SEC-06) – sonst hinge der Test davon ab, ob er gerade dazwischen tickt
$M stop backup-agent >/dev/null
FIRST=$(run_agent koppeln https://backup.schulos.test K7Q2-9MXA-4RT1 "CI-Schule" 2>&1) || fail "Kopplung: $FIRST"
INSTANCE=$(echo "$FIRST" | grep -oE 'Instanz [0-9a-f-]{36}' | head -1)
[ -n "$INSTANCE" ] || fail "Kopplung meldet keine Instanz: $FIRST"
ok "gekoppelt (CA gepinnt)"
# zweiter Versuch mit leerer Konfiguration (Antwort „verloren“): der Backupserver liefert in den ersten 15 Minuten dieselbe
# Instanz statt einer zweiten (B-55b); dass der Code danach abgelehnt wird, prüfen die Unit-Tests
OUT=$($M run --rm -T -v /srv/schulos/config backup-agent node /opt/schulos-agent/agent.mjs koppeln https://backup.schulos.test K7Q2-9MXA-4RT1 x 2>&1 || true)
echo "$OUT" | grep -q "$INSTANCE" || fail "Wiederholung mit demselben Code muss dieselbe Instanz liefern: $OUT"
[ "$($B exec -T backup node cli.mjs instanzen | grep -c '"name":')" = 1 ] || fail "Wiederholung hat eine zweite Instanz angelegt"
ok "Wiederholung der Kopplung liefert dieselbe Instanz"

# Kommandozeile im Backup-Container (B-45): Instanzen, neuer Code, Ersatz-Code – ohne Web-UI, nur von innen
$B exec -T backup node cli.mjs instanzen | grep -q '"name": "CI-Schule"' || fail "cli.mjs instanzen"
CODE=$($B exec -T backup node cli.mjs kopplungscode --ersatz CI-Schule 2>/dev/null)
echo "$CODE" | grep -Eq '^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$' || fail "cli.mjs kopplungscode --ersatz: $CODE"
$B exec -T backup node cli.mjs kopplungscode --ersatz gibt-es-nicht >/dev/null 2>&1 && fail "Ersatz-Code für unbekannte Instanz"
# von außen (über Caddy) ist die interne API zu
STATUS=$(curl -sk -o /dev/null -w '%{http_code}' --resolve backup.schulos.test:${BACKUP_HTTPS_PORT:-9443}:127.0.0.1 -X POST https://backup.schulos.test:${BACKUP_HTTPS_PORT:-9443}/api/intern/kopplungscode || true)
[ "$STATUS" = 403 ] || fail "interne API von außen erreichbar (HTTP $STATUS)"
ok "Kommandozeile: Instanzen, Ersatz-Kopplungscode; interne API von außen gesperrt"
# INST-04/INST-10: Aufruf über die IP-Adresse (kein SNI) bzw. einen fremden Namen → Zertifikat der Domain und die App
# (Weiterleitung zur Anmeldung) statt TLS-Fehler oder Caddys leerer 200-Antwort
bash scripts/ci/per-ip.sh "${BACKUP_HTTPS_PORT:-9443}" || fail "Backupserver per IP bzw. fremdem Namen"
# INST-10: die interne API bleibt auch über den Catch-all zu – „Host: 127.0.0.1“ von außen erreicht sie nicht
STATUS=$(curl -sk -o /dev/null -w '%{http_code}' -X POST https://127.0.0.1:${BACKUP_HTTPS_PORT:-9443}/api/intern/kopplungscode || true)
[ "$STATUS" = 403 ] || fail "interne API per IP von außen erreichbar (HTTP $STATUS)"
ok "Backupserver per IP und fremdem Namen aufrufbar, interne API per IP gesperrt"

# Sicherung (wartet beim ersten Zugriff, bis der rest-server den neuen Zugang kennt)
# Zeitlimit: restic wiederholt Serverfehler sonst bis zu 15 min
timeout 300 $M run --rm -T backup-agent node /opt/schulos-agent/agent.mjs sichern || fail "Sicherung"
ok "gesichert"
# Agent wieder starten (erst nach „sichern“: sein erster Takt holt den fälligen Termin nach und sperrt so lange weitere Läufe)
$M start backup-agent >/dev/null

# Test-Restore mit App-Start (B-32): schulosctl holt den neuesten Stand in eine Wegwerf-Datenbank, startet die App darauf,
# Rauchtest mit technischem Konto, danach Löschnachweis. schulosctl spricht den Stack wie compose selbst über die Umgebung an.
[ -f apps/ctl/dist/schulosctl.mjs ] || npm run build -w @schulos/ctl >/dev/null
OUT=$(COMPOSE_PROJECT_NAME=schulos-bt-main COMPOSE_FILE=compose.yaml:scripts/ci/compose.test.yaml COMPOSE_PATH_SEPARATOR=: \
  timeout 600 node apps/ctl/dist/schulosctl.mjs --dir . test-restore 2>&1) || fail "Test-Restore mit App-Start: $OUT"
echo "$OUT" | grep -q '"seiten":{"/":200,"/stundenplan":200}' || fail "Test-Restore: Rauchtest $OUT"
echo "$OUT" | grep -q "✓ loeschnachweis" || fail "Test-Restore: Löschnachweis $OUT"
ok "Test-Restore mit App-Start (Stand vom Backupserver, App gestartet, Rauchtest, Prüfdatenbank gelöscht)"

# Wartung auf dem Backupserver einschalten – Aufräumen, Prüfung, Test-Restore sind sofort fällig (Takt jede Minute)
TEST_JOBS=1 SCHULOS_HTTP_PORT=9080 SCHULOS_HTTPS_PORT=9443 $B up -d --wait backup || fail "Backupserver mit Wartung"
for i in $(seq 1 60); do $B logs --no-color backup 2>/dev/null | grep -q "Test-Restore" && break; sleep 5; done
LOGS=$($B logs --no-color backup)
echo "$LOGS" | grep -E "aufgeräumt|geprüft|Prüfung|Test-Restore" || true
echo "$LOGS" | grep -q "aufgeräumt CI-Schule" || fail "Aufräumen"
echo "$LOGS" | grep -q "geprüft CI-Schule: ok" || fail "Prüfung (restic check)"
echo "$LOGS" | grep -qE "Test-Restore CI-Schule: ok .*\"tabellen\":[1-9]" || fail "Test-Restore mit eingespielter Datenbank"
ok "Aufräumen, Prüfung und Test-Restore auf dem Backupserver"

# SEC-06: Der Agent hat sich inzwischen mit seinem Token gemeldet → keine Wiederholung der Kopplung mehr (auch innerhalb 15 min)
OUT=$($M run --rm -T -v /srv/schulos/config backup-agent node /opt/schulos-agent/agent.mjs koppeln https://backup.schulos.test K7Q2-9MXA-4RT1 x 2>&1) &&
  fail "Kopplungscode nach der ersten Meldung des Agenten noch einmal einlösbar: $OUT"
ok "Wiederholungsfenster nach der ersten Meldung des Agenten geschlossen"

# append-only: der Zugang des Hauptsystems darf nichts löschen
$M run --rm -T --entrypoint sh backup-agent -c '
  P=/srv/schulos/config/backup-pairing.json
  U=$(node -e "const p=require(\"$P\");const u=new URL(p.repoUrl);u.username=p.restUser;u.password=p.restPassword;console.log(\"rest:\"+u)")
  printf "%s" "$(node -e "console.log(require(\"$P\").caPem)")" > /tmp/ca.pem
  export RESTIC_REPOSITORY=$U RESTIC_PASSWORD=$(node -e "console.log(require(\"$P\").repoPassword)") RESTIC_CACERT=/tmp/ca.pem
  # einen vorhandenen Stand ausdrücklich löschen wollen – „forget --keep-last 1“ hätte bei nur einem Stand nichts zu tun
  ID=$(restic snapshots --json --no-lock | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>console.log(JSON.parse(s)[0].id))")
  [ -n "$ID" ] || { echo "kein Stand im Repository"; exit 1; }
  if OUT=$(restic forget "$ID" 2>&1); then echo "Löschen ging durch: $OUT"; exit 1; fi
  echo "abgelehnt: $(echo "$OUT" | grep -m1 -iE "fatal|denied|forbidden|error" || echo "$OUT" | head -n 1)"
  restic snapshots --json --no-lock | grep -q "$ID" || { echo "Stand $ID ist weg"; exit 1; }' || fail "append-only"
ok "append-only: Löschen mit dem Zugang des Hauptsystems scheitert"
echo "Stack-Test Backup bestanden."
