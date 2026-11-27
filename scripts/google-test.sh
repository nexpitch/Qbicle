#!/usr/bin/env bash
# Google Workspace en Google Cloud alleen-lezen testen, zonder Node op je laptop.
#
#   bash scripts/google-test.sh test                          testmodus: nagebootste Google, geen account nodig
#   bash scripts/google-test.sh workspace admin@jouwdomein.nl echte Workspace, leest namens deze beheerder
#   bash scripts/google-test.sh cloud                         echte Google Cloud, alle projecten met de leesrol
#   bash scripts/google-test.sh cloud mijn-project-id         alleen dit project
#
# Voor echt testen: zet het sleutelbestand (JSON) van je test-serviceaccount op
#   geheim/google-sleutel.json   (in de map qbicle; zie docs/google.md)
# De sleutel blijft op je laptop. Er wordt niets opgeslagen of naar Qbicle verstuurd.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker draait niet. Open eerst Docker Desktop en wacht tot het walvisje stil staat."
  exit 1
fi

soort="${1:-}"
case "$soort" in
  test)
    echo "Bouwen (de eerste keer duurt dit een paar minuten)..."
    docker compose --profile tools build -q google
    docker compose --profile tools run --rm google workspace --test
    docker compose --profile tools run --rm google cloud --test
    ;;
  workspace|cloud)
    if [[ ! -f geheim/google-sleutel.json ]]; then
      echo "Geen sleutel gevonden op geheim/google-sleutel.json."
      echo "Maak de map 'geheim' in de map qbicle en zet het gedownloade JSON-bestand daar neer onder die naam."
      echo "Stappenplan: docs/google.md"
      exit 1
    fi
    chmod 600 geheim/google-sleutel.json 2>/dev/null || true
    shift
    args=()
    if [[ "$soort" == "workspace" ]]; then
      if [[ -z "${1:-}" ]]; then
        echo "Geef het e-mailadres van een beheerder op, bijvoorbeeld:"
        echo "  bash scripts/google-test.sh workspace admin@jouwdomein.nl"
        exit 1
      fi
      args=(--beheerder "$1")
    elif [[ -n "${1:-}" ]]; then
      args=(--project "$1")
    fi
    echo "Bouwen (de eerste keer duurt dit een paar minuten)..."
    docker compose --profile tools build -q google
    docker compose --profile tools run --rm google "$soort" ${args[@]+"${args[@]}"}
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
