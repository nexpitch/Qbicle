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

echo "1/4 Database starten..."
docker compose up -d db

echo "2/4 Database bijwerken..."
docker compose --profile tools run --rm migrate

echo "3/4 Klantomgeving bouwen en starten (de eerste keer duurt dit een paar minuten)..."
docker compose --profile web up --build -d web

printf "4/4 Wachten tot de app reageert"
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null http://localhost:3000/aanmelden; then
    echo " klaar."
    break
  fi
  printf "."
  sleep 2
done

if ! curl -fs -o /dev/null http://localhost:3000/aanmelden; then
  echo
  echo "De app start niet. Dit zegt hij:"
  docker compose --profile web logs --tail 40 web
  exit 1
fi

echo
echo "Qbicle draait op http://localhost:3000"
echo "Na het aanmelden verschijnt de inloglink hieronder (regel met 'inloggen/bevestigen')."
echo "Kopieer die link naar je browser. Stoppen: Ctrl+C."
echo
command -v open >/dev/null && open http://localhost:3000/aanmelden || true
docker compose --profile web logs -f --since 1s web
