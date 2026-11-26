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
#  3. Bewaart de ARP-tabel van je Mac (welke apparaten hij in het netwerk ziet).
#  4. Leest in Docker het modem uit via UPnP (zonder wachtwoord) en maakt het overzicht.
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

if [[ ! -s netwerk/oui.csv || -n "$(find netwerk/oui.csv -mtime +30 2>/dev/null)" ]]; then
  echo "Register met fabrikanten van netwerkkaarten ophalen (eenmalig, bij de IEEE)..."
  bash scripts/oui-update.sh netwerk/oui.csv || echo "Ophalen mislukt; we gaan verder, maar herkennen minder apparaten."
fi

echo "Qbicle bouwen en starten in Docker (de eerste keer duurt dit een paar minuten)..."
docker compose build --quiet apparaten
docker compose run --rm apparaten --lokaal --gateway "$gateway" --arp /data/arp.txt --uit /data ${ping_flag[@]+"${ping_flag[@]}"}

open netwerk/rapport.html
