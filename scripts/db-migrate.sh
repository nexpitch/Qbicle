#!/usr/bin/env bash
# Past alle migraties in db/migrations toe die nog niet gedraaid zijn.
# Gebruik: DATABASE_URL=postgres://... npm run db:migrate
set -euo pipefail
: "${DATABASE_URL:?Zet DATABASE_URL, zie .env.example}"
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")/.."

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in db/migrations/*.sql; do
  name="$(basename "$f")"
  done_already="$(psql "$DATABASE_URL" -tA -v name="$name" <<<"SELECT 1 FROM schema_migrations WHERE name = :'name'")"
  if [[ "$done_already" == "1" ]]; then
    continue
  fi
  echo "Migratie $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 \
    -f "$f" \
    -c "INSERT INTO schema_migrations (name) VALUES ('$name')"
done
echo "Database is bij."
