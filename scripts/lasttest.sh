#!/usr/bin/env bash
# Lasttest „Montag 7:40“ (B-50a): Demo-Hauptsystem aus dem qcow2-Abbild (B-46) als VM mit begrenzten Kernen/RAM, k6 von außen
# (scripts/lasttest/montag.js), dabei `vmstat` und `docker stats` in der VM und `pg_stat_user_tables` vorher/nachher.
# Je Kernzahl eine frische VM; Ergebnis: <arbeitsordner>/bericht.md (+ Rohdaten je Lauf). Auf Linux mit KVM und sudo
# (CI: Workflow lasttest.yml auf der Build-VM). Grenzen: geteilter Host, virtuelle Platte/Netz – nur relative Aussagen.
#   bash scripts/lasttest.sh <hauptsystem.qcow2> <arbeitsordner> [kerne, z. B. 2,4] [ram-mb]
# Umgebung: NUTZER (300), RAMPE (2m), DAUER (10m), K6_IMAGE (sonst Pin aus deploy/upstream/Dockerfile)
# Szenario „gemeinsam“ (Gate 3b, SZENARIO=gemeinsam): NUTZER Schüler:innen derselben Klasse (7b, bei Bedarf aufgefüllt) bearbeiten
# gleichzeitig einen Text bzw. eine Tafel – Lastgenerator scripts/lasttest/gemeinsam/run.ts (Node, liest den SSE-Strom; k6 kann
# das nicht), PHASEN (text,tafel,beide) je DAUER. Ergebnis gemeinsam.json → Bericht wie sonst (scripts/lasttest-auswertung.ts).
set -euo pipefail
if [ "$(id -u)" = 0 ] && ! command -v sudo >/dev/null; then sudo() { env "$@"; }; fi
ABBILD=$(readlink -f "$1")
W=$2
IFS=, read -r -a KERNE <<<"${3:-2,4}"
RAM=${4:-4096}
NUTZER=${NUTZER:-300}
RAMPE=${RAMPE:-2m}
DAUER=${DAUER:-10m}
SZENARIO=${SZENARIO:-montag}
PHASEN=${PHASEN:-text,tafel,beide}
case "$SZENARIO" in montag | gemeinsam) ;; *) echo "SZENARIO montag oder gemeinsam, nicht „$SZENARIO“" >&2; exit 64 ;; esac
REPO=$(cd "$(dirname "$0")/.." && pwd)
K6_IMAGE=${K6_IMAGE:-$(sh "$REPO/scripts/pin.sh" k6)}
BR=br-lasttest
TAP=tap-lasttest
IP=192.168.251.2
HOST=demo.schulos.test
VM_PID=
MON_PIDS=()
log() { echo "[$(date +%H:%M:%S)] $*"; }
cleanup() {
  for p in "${MON_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  [ -n "$VM_PID" ] && sudo kill "$VM_PID" 2>/dev/null || true
  sudo ip link del "$TAP" 2>/dev/null || true
  sudo ip link del "$BR" 2>/dev/null || true
  while sudo iptables -D FORWARD -i "$BR" -o "$BR" -j ACCEPT 2>/dev/null; do :; done
}
trap cleanup EXIT
trap 'log "ABBRUCH in Zeile $LINENO: $BASH_COMMAND"' ERR
fail() {
  log "FEHLER: $*"
  [ -f "$W/vm.serial" ] && { echo "--- serielle Ausgabe (Ende)"; tail -n 60 "$W/vm.serial"; }
  exit 1
}

log "Werkzeuge"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends qemu-system-x86 qemu-utils ovmf mtools dosfstools openssh-client iproute2 curl >/dev/null
[ -w /dev/kvm ] || sudo chmod 666 /dev/kvm
export USER=${USER:-$(id -un)}
rm -rf "$W" && mkdir -p "$W"
if [ "$SZENARIO" = montag ]; then docker pull -q "$K6_IMAGE" >/dev/null; fi

# eigenes Netz ohne DHCP (statische Adresse aus der Antwortdatei); Docker setzt FORWARD auf DROP → für die Bridge erlauben
sudo ip link del "$BR" 2>/dev/null || true
sudo ip link del "$TAP" 2>/dev/null || true
sudo ip link add "$BR" type bridge
sudo ip addr add 192.168.251.1/24 dev "$BR"
sudo ip link set "$BR" up
sudo iptables -I FORWARD 1 -i "$BR" -o "$BR" -j ACCEPT 2>/dev/null || true
sudo ip tuntap add "$TAP" mode tap user "$USER"
sudo ip link set "$TAP" master "$BR" up

ssh-keygen -q -t ed25519 -N "" -f "$W/id" <<<y >/dev/null
SSH=(ssh -i "$W/id" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR)
WPW='Last-am-Montag-0740'
on() { "${SSH[@]}" "schulos-admin@$IP" "$@"; }
# Befehle mit Anführungszeichen als Datei in die VM und dort mit sudo ausführen (statt mehrfach verschachtelter Quotes)
run_script() { # <lokale-datei>
  on "cat > /tmp/lasttest-$(basename "$1")" <"$1"
  on "echo '$WPW' | sudo -S -p '' bash /tmp/lasttest-$(basename "$1")"
}

cat >"$W/tabellen.sh" <<'EOF'
docker compose --project-directory /opt/schulos exec -T postgres psql -U schulos -d schulos -At -c \
  "select relname, seq_scan, seq_tup_read, coalesce(idx_scan, 0) from pg_stat_user_tables order by relname"
EOF
# Abfragestatistik (B-51, nur wenn pg_stat_statements geladen ist): vor dem Lauf leeren, danach die teuersten Abfragen –
# als Wartungsrolle postgres (SEC-07: Zurücksetzen braucht Superuser-Recht, die App-Rolle sieht nur ihre eigenen Texte),
# GATE-031 S-04: Superuser-Sitzung in der Datenbank der App-Rolle nur mit festem search_path (kein Trojaner aus „schulos“)
cat >"$W/abfragen-reset.sh" <<'EOF'
docker compose --project-directory /opt/schulos exec -T -e PGOPTIONS="-c search_path=pg_catalog,pg_temp" postgres psql -U postgres -d schulos -At -c "select public.pg_stat_statements_reset()" >/dev/null 2>&1 || true
EOF
cat >"$W/abfragen.sh" <<'EOF'
docker compose --project-directory /opt/schulos exec -T -e PGOPTIONS="-c search_path=pg_catalog,pg_temp" postgres psql -U postgres -d schulos -At -F '|' -c   "select calls, round(total_exec_time::numeric, 1), round(mean_exec_time::numeric, 2), regexp_replace(query, '\s+', ' ', 'g') from public.pg_stat_statements where query not ilike '%pg_stat_statements%' order by total_exec_time desc limit 12" 2>/dev/null || true
EOF
cat >"$W/konten.sh" <<'EOF'
docker compose --project-directory /opt/schulos exec -T postgres psql -U schulos -d schulos -At -c \
  "select json_agg(json_build_object('u', username, 'r', role) order by username) from users where status = 'active' and role in ('schueler', 'lehrkraft', 'eltern')"
EOF
# Messung in der VM: Auslastung (vmstat) und CPU/Speicher je Container (docker stats) alle 5 s
# Szenario „gemeinsam“ (nur Demo-Instanz): die 7b auf NUTZER Schüler:innen auffüllen (aus anderen Klassen), einen frischen Text
# anlegen und Konten, Text und Tafel (Beispieltafel aus dem Demo-Seed) als JSON ausgeben
cat >"$W/gemeinsam-konten.sh" <<EOF
docker compose --project-directory /opt/schulos exec -T postgres psql -U schulos -d schulos -q -At -v ON_ERROR_STOP=1 <<'SQL'
with need as (
  select greatest(0, $NUTZER - count(*))::int as n from group_members gm join users u on u.id = gm.user_id
  where gm.group_id = 'g-7b' and u.status = 'active' and u.role = 'schueler'
), cand as (
  select u.id, row_number() over (order by u.username) as rn from users u
  where u.role = 'schueler' and u.status = 'active'
    and not exists (select 1 from group_members x where x.group_id = 'g-7b' and x.user_id = u.id)
)
insert into group_members (group_id, user_id) select 'g-7b', cand.id from cand, need where cand.rn <= need.n;
insert into texte_docs (id, group_id, title, mode) values ('lasttest-gemeinsam', 'g-7b', 'Lasttest gemeinsam', 'alle') on conflict (id) do nothing;
select json_build_object(
  'accounts', (select json_agg(u.username order by u.username) from group_members gm join users u on u.id = gm.user_id
               where gm.group_id = 'g-7b' and u.status = 'active' and u.role = 'schueler'),
  'text', (select id from texte_docs where id = 'lasttest-gemeinsam'),
  'tafel', (select id from file_nodes where group_id = 'g-7b' and kind = 'file' and name ilike '%.excalidraw' order by created_at limit 1));
SQL
EOF
# Warnungen/Fehler der App während des Laufs (u. a. „… Personen bearbeiten gleichzeitig …“)
cat >"$W/applog.sh" <<'EOF'
docker compose --project-directory /opt/schulos logs --no-color --since 2h app 2>&1 | grep -aiE 'warn|error|fehler|texte|tafeln' | tail -n 200 || true
EOF
cat >"$W/vmstat.sh" <<'EOF'
exec vmstat -n 5
EOF
cat >"$W/stats.sh" <<'EOF'
while true; do
  t=$(date +%s)
  docker stats --no-stream --format "{{.Name}};{{.CPUPerc}};{{.MemUsage}}" | sed "s/^/$t;/"
  sleep 3
done
EOF

lauf() { # <kerne>
  local kerne=$1 d="$W/kerne-$1"
  mkdir -p "$d"
  chmod 777 "$d" # k6 schreibt summary.json als eigener Nutzer
  log "== $kerne Kerne, $RAM MB: VM aus $(basename "$ABBILD")"
  qemu-img create -q -f qcow2 -b "$ABBILD" -F qcow2 "$W/disk.qcow2" 48G
  cp /usr/share/OVMF/OVMF_VARS_4M.fd "$W/vars.fd"
  rm -f "$W/cidata.img"
  mkfs.vfat -n CIDATA -C "$W/cidata.img" 1024 >/dev/null
  cat >"$W/user-data" <<EOF
#cloud-config – SchulOS liest daraus schulos-install.yaml
role: main
instance: demo
network: {hostname: demo, mode: static, address: $IP/24, gateway: 192.168.251.1, dns: [192.168.251.1]}
access: {password: $WPW, ssh: true, ssh_keys: ["$(cat "$W/id.pub")"], console: serial}
admin: {first_name: Last, last_name: Test, username: last.test, password: Lange-Leitung-Kaffee-42}
web: {domain: $HOST}
backup: {mode: later}
EOF
  printf 'instance-id: lasttest-%s\n' "$kerne" >"$W/meta-data"
  mcopy -i "$W/cidata.img" "$W/user-data" ::user-data
  mcopy -i "$W/cidata.img" "$W/meta-data" ::meta-data
  : >"$W/vm.serial"
  qemu-system-x86_64 -machine q35,accel=kvm -cpu host -m "$RAM" -smp "$kerne" \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,file="$W/vars.fd" \
    -drive file="$W/disk.qcow2",if=virtio,format=qcow2,discard=unmap,detect-zeroes=unmap \
    -drive file="$W/cidata.img",if=virtio,format=raw,readonly=on \
    -netdev tap,id=n0,ifname="$TAP",script=no,downscript=no -device virtio-net-pci,netdev=n0,mac=52:54:00:00:01:02 \
    -display none -serial file:"$W/vm.serial" -no-reboot &
  VM_PID=$!

  local i
  for i in $(seq 1 240); do grep -aq "SCHULOS-EINRICHTUNG: ende rc=0" "$W/vm.serial" && break; kill -0 "$VM_PID" 2>/dev/null || fail "VM beendet"; sleep 5; done
  grep -aq "SCHULOS-EINRICHTUNG: ende rc=0" "$W/vm.serial" || fail "Einrichtung nicht fertig"
  for i in $(seq 1 240); do curl -skf --resolve "$HOST:443:$IP" "https://$HOST/api/health" >/dev/null 2>&1 && break; sleep 5; done
  for i in $(seq 1 240); do [ "$(on cat /run/schulos-erststart.status 2>/dev/null)" = fertig ] && break; sleep 5; done
  [ "$(on cat /run/schulos-erststart.status 2>/dev/null)" = fertig ] || fail "Erststart (Demo-Schule) nicht fertig"
  log "Demo-Hauptsystem bereit"
  run_script "$W/konten.sh" >"$d/konten.json"
  log "$(grep -o '"r"' "$d/konten.json" | wc -l) Konten (Schüler:innen, Lehrkräfte, Eltern)"
  # erst warmlaufen (Seiten kompilieren nicht – standalone –, aber Caches/Pool füllen), dann messen
  sleep 30
  run_script "$W/tabellen.sh" >"$d/tabellen-vorher.txt"
  run_script "$W/abfragen-reset.sh"
  run_script "$W/vmstat.sh" >"$d/vmstat.log" 2>&1 &
  MON_PIDS+=($!)
  run_script "$W/stats.sh" >"$d/stats.log" 2>&1 &
  MON_PIDS+=($!)

  local k6rc=0
  if [ "$SZENARIO" = gemeinsam ]; then
    run_script "$W/gemeinsam-konten.sh" >"$d/gemeinsam-konten.json"
    log "gemeinsam: $NUTZER Personen, Phasen $PHASEN je $DAUER – $(head -c 400 "$d/gemeinsam-konten.json")"
    (cd "$REPO" && BASE_URL="https://$HOST" ZIEL_IP="$IP" KONTEN="$d/gemeinsam-konten.json" PERSONEN="$NUTZER" PHASEN="$PHASEN" \
      DAUER="$DAUER" AUSGABE="$d/gemeinsam.json" npx tsx scripts/lasttest/gemeinsam/run.ts) 2>&1 | tee "$d/generator.log" || k6rc=$?
  else
    log "k6: $NUTZER Nutzer, Rampe $RAMPE, Dauer $DAUER"
    docker run --rm --network host --add-host "$HOST:$IP" -v "$REPO/scripts/lasttest:/scripts:ro" -v "$d:/out" \
      -e BASE_URL="https://$HOST" -e KONTEN=/out/konten.json -e NUTZER="$NUTZER" -e RAMPE="$RAMPE" -e DAUER="$DAUER" \
      "$K6_IMAGE" run -q /scripts/montag.js || k6rc=$?
  fi
  for p in "${MON_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  MON_PIDS=()
  on "echo '$WPW' | sudo -S -p '' sh -c 'pkill -f \"lasttest-(stats)[.]sh\"; pkill -x vmstat'" || true
  run_script "$W/tabellen.sh" >"$d/tabellen-nachher.txt"
  run_script "$W/abfragen.sh" >"$d/abfragen.txt"
  if [ "$SZENARIO" = gemeinsam ]; then run_script "$W/applog.sh" >"$d/app.log" || true; fi
  sudo kill "$VM_PID" 2>/dev/null || true
  wait "$VM_PID" 2>/dev/null || true
  VM_PID=
  rm -f "$W/disk.qcow2"
  if [ "$SZENARIO" = gemeinsam ]; then
    [ -s "$d/gemeinsam.json" ] || fail "Lastgenerator ohne Ergebnis (rc=$k6rc)"
  else
    [ -s "$d/summary.json" ] || fail "k6 ohne Ergebnis (rc=$k6rc)"
  fi
  (cd "$REPO" && npx tsx scripts/lasttest-auswertung.ts "$d" "$kerne" "$RAM" "$NUTZER") >>"$W/bericht.md"
  log "$kerne Kerne fertig (k6 rc=$k6rc – Grenzen überschritten zählt als Befund, nicht als Abbruch)"
}

for k in "${KERNE[@]}"; do lauf "$k"; done
log "Bericht: $W/bericht.md"
cat "$W/bericht.md"
