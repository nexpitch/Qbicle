#!/usr/bin/env bash
# Haalt het openbare MAC-prefixregister van de IEEE op (MA-L, MA-M, MA-S) en voegt het samen.
# Gebruik: bash scripts/oui-update.sh data/oui.csv  en zet daarna QBICLE_OUI_FILE=data/oui.csv
# Het register verandert wekelijks; eens per maand bijwerken is genoeg.
set -euo pipefail
out="${1:-data/oui.csv}"
mkdir -p "$(dirname "$out")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for reg in oui mam oui36; do
  curl -fsSL --retry 3 -A "Qbicle-oui-update/0.1" "https://standards-oui.ieee.org/$reg/$reg.csv" -o "$tmp/$reg.csv"
done
{ head -n 1 "$tmp/oui.csv"; for reg in oui mam oui36; do tail -n +2 "$tmp/$reg.csv"; done; } > "$out"
echo "Register opgeslagen in $out ($(wc -l < "$out") regels)"
