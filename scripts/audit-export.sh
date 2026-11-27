#!/usr/bin/env bash
# Kopie van het audit-log buiten de database (S3 uit de review van PR 15).
# Schrijft alle regels sinds de vorige export als JSON-regels naar een nieuw
# bestand. Zet de map op opslag die niet te overschrijven is (bijv. een bucket
# met object lock / WORM) en draai dit dagelijks (cron of de worker).
#
# Gebruik: DATABASE_URL=postgres://... bash scripts/audit-export.sh /pad/naar/map
set -euo pipefail
: "${DATABASE_URL:?Zet DATABASE_URL}"
dir="${1:?Geef de doelmap op}"
mkdir -p "$dir"
state="$dir/.laatste-id"
last="$(cat "$state" 2>/dev/null || echo 0)"
[[ "$last" =~ ^[0-9]+$ ]] || { echo "Ongeldige status in $state" >&2; exit 1; }
out="$dir/audit-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAq -v last="$last" > "$out.tmp" <<'SQL'
SELECT row_to_json(a) FROM audit_log a WHERE id > :last ORDER BY id;
SQL
if [[ ! -s "$out.tmp" ]]; then rm -f "$out.tmp"; echo "Geen nieuwe regels."; exit 0; fi
mv "$out.tmp" "$out"
new="$(tail -n 1 "$out" | sed -E 's/^\{"id":([0-9]+).*/\1/')"
sha256sum "$out" > "$out.sha256"
echo "$new" > "$state"
echo "$(wc -l < "$out") regels naar $out (tot en met id $new)."
