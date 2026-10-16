#!/usr/bin/env bash
# SEC-13: Container-Härtung am laufenden Stack prüfen (CI-Job „stack“, scripts/backup-stack-test.sh) – je Container des
# Compose-Projekts: nicht root (Ausnahmen: --root <dienst>), Image-Dateisystem nur lesbar, alle Capabilities entfernt (zusätzlich
# erlaubt nur, was --cap <dienst>=<CAP> nennt), no-new-privileges, kein docker.sock eingebunden; G4E-O14: nicht privilegiert,
# keine Namensräume des Hosts (pid/ipc/net/uts/userns), keine Geräte.
#   bash scripts/haertung-pruefen.sh <compose-projekt> [--root <dienst>]… [--cap <dienst>=<CAP>]… [--rw <dienst>]…
# --ohne-nnp: Dienste, deren Programm eine Datei-Capability trägt (step-ca) – no-new-privileges verhinderte den Start
# --rw: Dienste mit „configs“ – Compose kopiert deren Inhalt beim Anlegen hinein, das Dateisystem bleibt beschreibbar
set -euo pipefail
PROJECT=${1:?Compose-Projekt fehlt}
shift
declare -A ROOT_OK=() CAP_OK=() RW_OK=() NNP_OK=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT_OK[$2]=1; shift 2 ;;
    --rw) RW_OK[$2]=1; shift 2 ;;
    --ohne-nnp) NNP_OK[$2]=1; shift 2 ;;
    --cap) CAP_OK[${2%%=*}]="${CAP_OK[${2%%=*}]:-} ${2#*=}"; shift 2 ;;
    *) echo "unbekannt: $1" >&2; exit 64 ;;
  esac
done
fehler=0
schlecht() { echo "SEC-13 ✗ $1: $2"; fehler=1; }
ids=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")
[ -n "$ids" ] || { echo "SEC-13: keine laufenden Container im Projekt $PROJECT" >&2; exit 1; }
for id in $ids; do
  svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")
  user=$(docker inspect -f '{{.Config.User}}' "$id")
  ro=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$id")
  drop=$(docker inspect -f '{{join .HostConfig.CapDrop " "}}' "$id")
  add=$(docker inspect -f '{{join .HostConfig.CapAdd " "}}' "$id")
  sec=$(docker inspect -f '{{join .HostConfig.SecurityOpt " "}}' "$id")
  binds=$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$id")
  # leerer Benutzer im Container heißt root – dann zählt, was das Image setzt (.Config.User ist schon das wirksame)
  uid=$(docker exec "$id" id -u 2>/dev/null || echo "?")
  if [ "$uid" = 0 ] || { [ "$uid" = "?" ] && { [ -z "$user" ] || [ "$user" = root ] || [ "$user" = 0 ]; }; }; then
    [ -n "${ROOT_OK[$svc]:-}" ] || schlecht "$svc" "läuft als root (User „$user“)"
  fi
  [ "$ro" = true ] || [ -n "${RW_OK[$svc]:-}" ] || schlecht "$svc" "Image-Dateisystem beschreibbar (read_only fehlt)"
  case " $drop " in *" ALL "* | *" CAP_ALL "*) ;; *) schlecht "$svc" "cap_drop ALL fehlt ($drop)" ;; esac
  for c in $add; do
    case " ${CAP_OK[$svc]:-} " in *" ${c#CAP_} "* | *" $c "*) ;; *) schlecht "$svc" "zusätzliche Capability $c" ;; esac
  done
  # G4E-O14: genau „no-new-privileges“ bzw. „…:true“ – „no-new-privileges:false“ zählt nicht
  case " $sec " in *" no-new-privileges "* | *" no-new-privileges:true "* | *" no-new-privileges=true "*) ;; *) [ -n "${NNP_OK[$svc]:-}" ] || schlecht "$svc" "no-new-privileges fehlt" ;; esac
  case " $binds " in *docker.sock*) schlecht "$svc" "docker.sock eingebunden" ;; esac
  # G4E-O14: kein privilegierter Container, keine Namensräume des Hosts, keine Geräte
  [ "$(docker inspect -f '{{.HostConfig.Privileged}}' "$id")" = false ] || schlecht "$svc" "privileged"
  for m in PidMode IpcMode NetworkMode UTSMode UsernsMode; do
    if [ "$(docker inspect -f "{{.HostConfig.$m}}" "$id")" = host ]; then schlecht "$svc" "$m=host"; fi
  done
  [ "$(docker inspect -f '{{len .HostConfig.Devices}}' "$id")" = 0 ] || schlecht "$svc" "Geräte eingebunden"
  echo "SEC-13 ✓ $svc (uid $uid, ro=$ro, cap_add: ${add:-–})"
done
exit $fehler
