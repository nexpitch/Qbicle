#!/usr/bin/env bash
# Start de interne Qbicle Cockpit op je eigen computer en opent de browser.
# Gebruik (in Terminal, in de map qbicle):  bash scripts/cockpit.sh
# De eerste keer vraagt het script met welk e-mailadres je wilt inloggen.
# Stoppen: Ctrl+C, daarna eventueel  docker compose --profile cockpit down
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker draait niet. Open eerst Docker Desktop en wacht tot het walvisje stil staat."
  exit 1
fi

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

docker compose --profile cockpit stop cockpit >/dev/null 2>&1 || true

PORT_C="${QBICLE_COCKPIT_PORT:-}"
if [[ -z "$PORT_C" ]]; then
  for p in 3100 3400 3401 3402 3403 8400 8401; do
    if ! port_in_use "$p"; then PORT_C="$p"; break; fi
  done
fi
if [[ -z "$PORT_C" ]]; then
  echo "Geen vrije poort gevonden. Start opnieuw met bijvoorbeeld: QBICLE_COCKPIT_PORT=4567 bash scripts/cockpit.sh"
  exit 1
fi
export QBICLE_COCKPIT_PORT="$PORT_C"
export QBICLE_COCKPIT_ORIGIN="http://localhost:$PORT_C"
URL="$QBICLE_COCKPIT_ORIGIN"
[[ "$PORT_C" != "3100" ]] && echo "Poort 3100 is bezet; de cockpit gebruikt poort $PORT_C."

echo "1/5 Database starten..."
docker compose up -d db

echo "2/5 Database bijwerken..."
docker compose --profile tools run --rm migrate

echo "3/5 Cockpit bouwen (de eerste keer duurt dit een paar minuten)..."
docker compose --profile cockpit build cockpit

beheer() {
  docker compose --profile cockpit run --rm --no-deps --entrypoint npx cockpit --no-install tsx apps/cockpit/src/cli.ts "$@"
}

if ! beheer heeft-medewerkers >/dev/null 2>&1; then
  echo
  echo "Er is nog niemand met toegang tot de cockpit."
  read -r -p "Met welk e-mailadres wil je inloggen? " EMAIL
  beheer toevoegen "$EMAIL" beheerder
fi

echo "4/5 Cockpit starten..."
docker compose --profile cockpit up -d cockpit

printf "5/5 Wachten tot de cockpit reageert"
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "$URL/inloggen"; then
    echo " klaar."
    break
  fi
  printf "."
  sleep 2
done

if ! curl -fs -o /dev/null "$URL/inloggen"; then
  echo
  echo "De cockpit start niet. Dit zegt hij:"
  docker compose --profile cockpit logs --tail 40 cockpit
  exit 1
fi

echo
echo "De cockpit draait op $URL"
echo "Vul je e-mailadres in. De inloglink komt in je mail (als Brevo in .env staat) of hieronder"
echo "(regel met 'inloggen/bevestigen'). Open die link en stel daarna je authenticator-app in. Stoppen: Ctrl+C."
echo
command -v open >/dev/null && open "$URL/inloggen" || true
docker compose --profile cockpit logs -f --since 1s cockpit
