#!/usr/bin/env bash
# CI-01: PR erst mergen, wenn alle Prüfungen fertig sind und keine fehlgeschlagen/abgebrochen ist.
# Ersatz für Branch-Protection (privates Repo ohne GitHub Pro: keine Pflicht-Prüfungen; `gh pr merge --auto` merged dann
# sofort – so ist Gate-PR #28 vor Ende der CI gemergt worden). Nie `--auto` verwenden, immer dieses Skript.
#   bash scripts/pr-merge.sh <PR-Nummer> [--max-minuten 90]
# Regeln: der CI-Abschluss-Job „ergebnis“ muss dabei sein; „übersprungen“ zählt als grün; Gate-PRs (Titel „Gate…“) merged
# nur die Projektleitung; gemerged wird genau der geprüfte Kopf-Commit (--match-head-commit). Filtert mit `gh --jq` (kein jq nötig).
set -euo pipefail
nr=${1:?Aufruf: bash scripts/pr-merge.sh <PR-Nummer> [--max-minuten 90]}
max=90
[ "${2:-}" = --max-minuten ] && max=${3:?Minuten fehlen}

info=$(gh pr view "$nr" --json state,isDraft,title,headRefOid -q '[.state, (.isDraft|tostring), .headRefOid, .title] | join("|")')
IFS='|' read -r state draft head title <<<"$info"
[ "$state" = OPEN ] || { echo "PR #$nr ist nicht offen ($state)"; exit 1; }
[ "$draft" = false ] || { echo "PR #$nr ist ein Entwurf"; exit 1; }
case "$title" in [Gg][Aa][Tt][Ee]*) echo "PR #$nr ist ein Gate-PR – den merged nur die Projektleitung"; exit 1 ;; esac

ende=$(( $(date +%s) + max * 60 ))
while :; do
  stand=$(gh pr checks "$nr" --json name,bucket --jq '[([.[] | select(.bucket == "pending")] | length), ([.[] | select(.name == "ergebnis")] | length), ([.[] | select(.bucket == "fail" or .bucket == "cancel") | .name] | join(", "))] | map(tostring) | join("|")' 2>/dev/null || true)
  IFS='|' read -r offen ergebnis rot <<<"${stand:-0|0|}"
  if [ -n "$rot" ]; then
    echo "PR #$nr: rot – $rot. Nicht gemerged."
    exit 1
  fi
  if [ "$offen" -eq 0 ] && [ "$ergebnis" -gt 0 ]; then break; fi
  if [ "$(date +%s)" -ge "$ende" ]; then
    echo "PR #$nr: nach $max min noch $offen Prüfung(en) offen – nicht gemerged."
    exit 1
  fi
  echo "$(date +%H:%M) PR #$nr: $offen Prüfung(en) laufen noch$([ "$ergebnis" -gt 0 ] || echo ', Abschluss-Job ergebnis steht noch aus')"
  sleep 30
done

jetzt=$(gh pr view "$nr" --json headRefOid -q .headRefOid)
[ "$jetzt" = "$head" ] || { echo "PR #$nr: neuer Commit während des Wartens ($jetzt) – bitte erneut aufrufen"; exit 1; }
gh pr checks "$nr" --json name,bucket --jq '.[] | "  " + .bucket + "  " + .name' || true
gh pr merge "$nr" --merge --delete-branch --match-head-commit "$head"
echo "PR #$nr gemerged ($head)."
