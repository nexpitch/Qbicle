# Eerste test op je eigen netwerk (Mac)

Brengt je eigen netwerk in kaart: het modem van de provider (KPN, Ziggo, Odido) of je
eigen router, en de apparaten erachter, zoals wifi-punten (bijvoorbeeld TP-Link Deco),
laptops, telefoons, printers en camera's. Uitkomst: `netwerk/rapport.html` met per
apparaat het type, de fabrikant, het IP-adres en het risico.

## Starten

1. Open **Docker Desktop** en wacht tot het klaar is.
2. Open **Terminal** en ga naar de repository: `cd ~/Claude/qbicle`
3. Haal de nieuwste versie op: `git pull`
4. Start: `bash scripts/mijn-netwerk.sh`
5. Beantwoord de vraag over de scanopdracht met `ja` (alleen op je eigen netwerk) of `nee`.
6. Het overzicht opent vanzelf in je browser.

Vraagt macOS of Docker of Terminal "apparaten in je lokale netwerk" mag vinden: kies **Sta toe**.

## Wat er gebeurt

| Stap | Hoe | Niveau |
|---|---|---|
| Gateway en eigen netwerk vinden | `route` en `ipconfig` op de Mac | lokaal |
| Stille apparaten wakker maken (alleen met scanopdracht, alleen een /24) | één ping per adres | 2A, opdracht in `netwerk/scanopdracht.txt` |
| Apparaten die de Mac kent | `arp -a` | 2P |
| Fabrikant per MAC-prefix | IEEE-register, meegeleverd (npm-pakket `oui-data`), offline; aangevuld met `netwerk/oui.csv` als de download lukt | lokaal |
| Namen, diensten, model en fabrikant die apparaten zelf aankondigen | Bonjour via `dns-sd` op de Mac (~15 s luisteren) | 2P |
| Fabrikant, model en type van apparaten die UPnP spreken (alleen met scanopdracht) | één SSDP-vraag per apparaat (unicast) + hun eigen beschrijving | 2A, binnen de scanopdracht |
| Modem: model, internetadres, door apparaten geopende poorten | één SSDP-vraag aan de gateway + UPnP-leesacties, zonder wachtwoord | 2P |

Geen poortscan, geen kwetsbaarheden uitproberen, niets veranderen op het modem.
Alles blijft op je computer in `netwerk/` (staat in `.gitignore`: bevat MAC-adressen).
Elke run bewaart de inventaris als `netwerk/inventaris-<datum>.json`.

## Per apparaat in het overzicht

Type en zekerheid (vastgesteld, vermoedelijk, onbekend, door jou opgegeven), naam,
besturingssysteem (een gok uit fabrikant, naam en diensten, geen vingerafdruk-scan),
fabrikant en model, IP- en MAC-adres, laatst gezien, bronnen, waarom dit type, en bij
onbekend waarom het onbekend blijft.

## Zelf benoemen

Vul in het overzicht bij "Meer" een naam en type in en klik op "Download mijn namen".
Dat geeft `~/Downloads/qbicle-namen.csv`; de volgende run kopieert dat naar
`netwerk/namen.csv` en toont de namen met zekerheid "door jou opgegeven". Je kunt
`netwerk/namen.csv` ook zelf bewerken: per regel `mac,naam,type`.

## Bekende grenzen van deze eerste test

- Apparaten die uit staan en apparaten op het gastnetwerk staan niet in de lijst. Je Mac zelf alleen als hij zich via Bonjour aankondigt.
- Deco-satellieten in accesspoint-modus herkennen we aan de fabrikant (TP-Link) en, als die
  er is, de naam. Model en firmware van de Deco lezen we nog niet uit (daarvoor is de
  Deco-app nodig; geen officiële API).
- Antwoordt het modem niet op UPnP, dan staat UPnP uit (goed) of komt het antwoord niet door
  Docker heen. Dan zie je het modem alleen met de fabrikant uit de MAC-prefix.
- Er is nog geen echte end-of-life- of kwetsbaarhedenlijst geladen; "Niets gevonden" betekent
  dus niet "veilig".
- Opslaan in de database en het portaal volgen hierna.
