#!/usr/bin/env bash
# Start de Qbicle-klantomgeving op je eigen computer en opent de browser.
# Gebruik (in Terminal, in de map qbicle):  bash scripts/klantomgeving.sh
# Stoppen: Ctrl+C, daarna eventueel  docker compose --profile web down
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

# Een eerdere Qbicle-app eerst netjes stoppen, zodat zijn poort vrijkomt.
docker compose --profile web stop web >/dev/null 2>&1 || true

# Vrije poort kiezen: 3000 als die vrij is, anders 3300, 3301, ...
PORT_WEB="${QBICLE_WEB_PORT:-}"
if [[ -z "$PORT_WEB" ]]; then
  for p in 3000 3300 3301 3302 3303 3304 3305 8300 8301; do
    if ! port_in_use "$p"; then PORT_WEB="$p"; break; fi
  done
fi
if [[ -z "$PORT_WEB" ]]; then
  echo "Geen vrije poort gevonden. Start opnieuw met bijvoorbeeld: QBICLE_WEB_PORT=4567 bash scripts/klantomgeving.sh"
  exit 1
fi
export QBICLE_WEB_PORT="$PORT_WEB"
export QBICLE_WEB_ORIGIN="http://localhost:$PORT_WEB"
URL="$QBICLE_WEB_ORIGIN"
[[ "$PORT_WEB" != "3000" ]] && echo "Poort 3000 is bezet door een ander programma; Qbicle gebruikt poort $PORT_WEB."

echo "1/4 Database starten..."
docker compose up -d db

echo "2/4 Database bijwerken..."
docker compose --profile tools run --rm migrate

echo "3/4 Klantomgeving bouwen en starten (de eerste keer duurt dit een paar minuten)..."
docker compose --profile web up --build -d web

printf "4/4 Wachten tot de app reageert"
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null $URL/aanmelden; then
    echo " klaar."
    break
  fi
  printf "."
  sleep 2
done

if ! curl -fs -o /dev/null $URL/aanmelden; then
  echo
  echo "De app start niet. Dit zegt hij:"
  docker compose --profile web logs --tail 40 web
  exit 1
fi

echo
echo "Qbicle draait op $URL"
echo "Na het aanmelden verschijnt de inloglink hieronder (regel met 'inloggen/bevestigen')."
echo "Kopieer die link naar je browser. Stoppen: Ctrl+C."
echo
command -v open >/dev/null && open $URL/aanmelden || true
docker compose --profile web logs -f --since 1s web
