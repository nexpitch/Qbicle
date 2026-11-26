#!/usr/bin/env bash
# Eerste test van Qbicle op je eigen netwerk (Mac + Docker Desktop).
#
#   bash scripts/mijn-netwerk.sh
#
# Wat het doet:
#  1. Zoekt het adres van je modem of router (de gateway) en je eigen netwerk.
#  2. Vraagt of je Qbicle opdracht geeft alle adressen in je eigen netwerk één keer te
#     pingen (scanopdracht). Dan staan meer apparaten in de lijst. Zeg je nee, dan gebruiken
#     we alleen wat je Mac al kent. Er wordt nooit op poorten gescand en er worden geen
#     kwetsbaarheden uitgeprobeerd.
#  3. Bewaart de ARP-tabel van je Mac (welke apparaten hij in het netwerk ziet) en luistert
#     ~15 seconden naar Bonjour: namen, diensten en modellen die apparaten zelf aankondigen.
#  4. Leest in Docker het modem uit via UPnP (zonder wachtwoord) en maakt het overzicht. Met
#     scanopdracht vraagt het ook elk apparaat één keer om zijn UPnP-beschrijving (model).
#     Namen die je in het overzicht zelf gaf (Downloads/qbicle-namen.csv) gaan mee.
#  5. Opent netwerk/rapport.html in je browser.
# Alles blijft op je eigen computer, in de map netwerk/ (staat niet in git).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Dit script is voor een Mac. Op Linux: maak zelf 'arp -a > netwerk/arp.txt' en start 'docker compose run --rm apparaten --lokaal --gateway <adres> --arp /data/arp.txt --uit /data'."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker draait niet. Open Docker Desktop, wacht tot het walvisje stilstaat en start dit script opnieuw."
  exit 1
fi

iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
gateway="$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')"
myip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
mask="$(ipconfig getoption "$iface" subnet_mask 2>/dev/null || true)"
if [[ -z "$gateway" || -z "$myip" ]]; then
  echo "Ik vind geen netwerkverbinding. Zit je Mac op je wifi of netwerkkabel?"
  exit 1
fi
if ! [[ "$gateway" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
  echo "Je gateway ($gateway) is geen adres in een eigen netwerk. Zit je op een VPN? Zet die uit en probeer opnieuw."
  exit 1
fi
prefix="${myip%.*}"
echo "Je Mac: $myip  ·  modem/router (gateway): $gateway  ·  netwerk: $prefix.0/24"
mkdir -p netwerk

ping_flag=()
if [[ "$mask" == "255.255.255.0" ]]; then
  echo ""
  echo "SCANOPDRACHT"
  echo "Mag Qbicle alle 254 adressen in $prefix.0/24 één keer pingen, zodat ook stille apparaten"
  echo "in de lijst komen? Doe dit alleen op je eigen netwerk (thuis of je eigen kantoor)."
  echo "Er wordt niet op poorten gescand en er worden geen kwetsbaarheden uitgeprobeerd."
  read -r -p "Is dit jouw eigen netwerk en geef je die opdracht? (ja/nee) " answer
  if [[ "$answer" =~ ^[Jj] ]]; then
    {
      echo "Scanopdracht Qbicle netwerktest"
      echo "Datum: $(date '+%Y-%m-%d %H:%M:%S %z')"
      echo "Gebruiker op deze Mac: $(whoami)"
      echo "Netwerk: $prefix.0/24 (gateway $gateway)"
      echo "Opdracht: elk adres één keer pingen om de ARP-tabel te vullen. Geen poortscan, geen kwetsbaarheden uitproberen."
      echo "Verklaring: dit is mijn eigen netwerk of ik ben bevoegd hiervoor opdracht te geven."
    } > netwerk/scanopdracht.txt
    echo "Bezig met pingen (ongeveer 10 seconden)..."
    for i in $(seq 1 254); do
      ping -c 1 -t 1 "$prefix.$i" >/dev/null 2>&1 &
      if (( i % 32 == 0 )); then wait; fi
    done
    wait
    ping_flag=(--ping)
  else
    echo "Prima, dan gebruiken we alleen wat je Mac al kent."
  fi
else
  echo "Je netwerk is groter of kleiner dan 254 adressen ($mask); we pingen niet en gebruiken alleen wat je Mac al kent."
fi

echo "ARP-tabel van je Mac opslaan..."
arp -a > netwerk/arp.txt

echo "Bonjour-aankondigingen verzamelen (ongeveer 15 seconden)..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Elke dns-sd-vraag loopt tot hij gestopt wordt; daarom na een paar seconden stoppen.
listen() { local secs="$1" out="$2"; shift 2; "$@" > "$out" 2>/dev/null & local pid=$!; sleep "$secs"; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 0; }
listen 4 "$tmp/types" dns-sd -B _services._dns-sd._udp local.
n=0
for t in $(awk '$2=="Add" && NF>=7 { split($6, a, "."); print $7 "." a[1] }' "$tmp/types" | grep -E '^_[A-Za-z0-9-]+\._(tcp|udp)$' | sort -u | head -40); do
  n=$((n+1)); echo "$t" > "$tmp/bt.$n"
  listen 3 "$tmp/b.$n" dns-sd -B "$t" local. &
done
wait
: > "$tmp/lookups"
for f in "$tmp"/b.*; do
  [[ -e "$f" ]] || continue
  t="$(cat "$tmp/bt.${f##*.}")"
  awk -v t="$t" '$2=="Add" && NF>=7 { s=$7; for (k=8; k<=NF; k++) s=s" "$k; print t "\t" s }' "$f" >> "$tmp/lookups"
done
n=0
while IFS=$'\t' read -r t name; do
  n=$((n+1)); [[ $n -gt 150 ]] && break
  printf '%s %s\n' "$t" "$name" > "$tmp/lt.$n"
  listen 3 "$tmp/l.$n" dns-sd -L "$name" "$t" local. &
done < <(sort -u "$tmp/lookups")
wait
n=0
for h in $(cat "$tmp"/l.* 2>/dev/null | sed -n 's/.*can be reached at \([^ :]*\):.*/\1/p' | sed 's/\.$//' | sort -u | head -150); do
  n=$((n+1)); echo "$h" > "$tmp/gh.$n"
  listen 2 "$tmp/g.$n" dns-sd -G v4 "$h" &
done
wait
: > netwerk/bonjour.txt
for f in "$tmp"/l.*; do [[ -e "$f" ]] || continue; echo "### L $(cat "$tmp/lt.${f##*.}")"; cat "$f"; done >> netwerk/bonjour.txt
for f in "$tmp"/g.*; do [[ -e "$f" ]] || continue; echo "### G $(cat "$tmp/gh.${f##*.}")"; cat "$f"; done >> netwerk/bonjour.txt
echo "  $(grep -c 'can be reached at' netwerk/bonjour.txt || true) aankondigingen gevonden."

# Namen die je in het overzicht zelf gaf (knop "Download mijn namen").
dl="$HOME/Downloads/qbicle-namen.csv"
if [[ -f "$dl" && ( ! -f netwerk/namen.csv || "$dl" -nt netwerk/namen.csv ) ]]; then
  cp "$dl" netwerk/namen.csv
  echo "Je eigen namen overgenomen uit Downloads/qbicle-namen.csv."
fi

if [[ ! -s netwerk/oui.csv || -n "$(find netwerk/oui.csv -mtime +30 2>/dev/null)" ]]; then
  # Qbicle heeft een ingebouwde lijst; dit haalt alleen de nieuwste versie op als dat lukt.
  bash scripts/oui-update.sh netwerk/oui.csv >/dev/null 2>&1 || true
fi

echo "Qbicle bouwen en starten in Docker (de eerste keer duurt dit een paar minuten)..."
docker compose build --quiet apparaten
docker compose run --rm apparaten --lokaal --gateway "$gateway" --arp /data/arp.txt --bonjour /data/bonjour.txt --namen /data/namen.csv --uit /data ${ping_flag[@]+"${ping_flag[@]}"}

open netwerk/rapport.html
