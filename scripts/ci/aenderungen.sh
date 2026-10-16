#!/usr/bin/env bash
# CI-01: entscheidet vor den schweren CI-Jobs (verify, postgres, stack, backup), ob sie laufen müssen.
#   voll=false, wenn nur Doku geändert ist (docs/**, *.md) – PR und Push gleich
#   voll=false auf main, wenn ein PR-Lauf genau diesen Baum schon komplett grün geprüft hat (Artefakt „geprueft-<baum>“
#     aus dem Job „ergebnis“; ein Merge-Commit ohne zwischenzeitliche Änderung an main hat denselben Baum wie der
#     geprüfte Test-Merge des PRs)
#   sonst voll=true (auch workflow_dispatch, unbekannter Vorgänger, leerer Diff)
# Umgebung: EVENT, VORHER (Push: github.event.before), REPO, GH_TOKEN. Schreibt voll/baum/grund nach $GITHUB_OUTPUT.
set -euo pipefail
baum=$(git rev-parse 'HEAD^{tree}')
ausgabe() {
  echo "voll=$1" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  echo "baum=$baum" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  echo "grund=$2" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  echo "### CI-Umfang: $([ "$1" = true ] && echo voll || echo Kurzprüfung)" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  echo "$2" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  echo "voll=$1 – $2"
  exit 0
}

case "$EVENT" in
  pull_request) dateien=$(git diff --name-only 'HEAD^1' HEAD) ;;  # Test-Merge: erster Elternteil = aktueller Stand der Basis
  push)
    if [ -z "${VORHER:-}" ] || [ "$VORHER" = 0000000000000000000000000000000000000000 ] || ! git cat-file -e "$VORHER^{commit}" 2>/dev/null; then
      ausgabe true "Vorgänger unbekannt"
    fi
    dateien=$(git diff --name-only "$VORHER" HEAD) ;;
  *) ausgabe true "Auslöser $EVENT prüft immer voll" ;;
esac

[ -n "$dateien" ] || ausgabe true "keine geänderten Dateien erkannt"
code=$(grep -Ev '^docs/|\.md$' <<<"$dateien" || true)
anzahl=$(wc -l <<<"$dateien" | tr -d ' ')
[ -n "$code" ] || ausgabe false "nur Doku geändert ($anzahl Datei(en))"

if [ "$EVENT" = push ]; then
  lauf=$(gh api "repos/$REPO/actions/artifacts?name=geprueft-$baum" \
    --jq '[.artifacts[] | select(.expired | not) | .workflow_run.id] | first // empty' 2>/dev/null || true)
  [ -z "$lauf" ] || ausgabe false "Baum $baum ist im PR-Lauf $lauf schon vollständig grün geprüft"
fi
ausgabe true "$(wc -l <<<"$code" | tr -d ' ') Datei(en) außerhalb der Doku geändert"
