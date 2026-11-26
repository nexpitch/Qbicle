# Apparaatherkenning via routers (stap 1)

Ontwerp: [Qbicle Infra & Devices: technisch ontwerp en bouwplan](https://claude.ai/artifact/VBd2meBrk2zSjGeBUPN31i).
Code: `packages/devices`. Probeer het zonder hardware: `npm run apparaten -- --demo`.

## Wat het doet

Qbicle leest uit wat een router of netwerkcontroller **al weet**: zijn eigen model en
firmware, het internetadres (WAN) en de lijst met verbonden apparaten. Daaruit:

1. **Waarnemingen** voor het assetmodel (`packages/inventory`): de router als
   netwerkapparaat ("vastgesteld"), het WAN-adres met blootstelling "internet" (wordt
   een doel voor de buitenkant-checks), en per apparaat MAC, IP en naam.
2. **Indeling in categorieën** (laptop, desktop, telefoon, tablet, server, printer,
   camera, NAS, slimme speaker, tv/media, alarmsysteem, zonnepanelen, laadpaal, IoT)
   op basis van fabrikant (router of MAC-prefix), hostnaam, model en mDNS-diensten.
   Altijd "mogelijk", met redenen in gewone taal. Te weinig aanwijzingen = "onbekend".
3. **Kwetsbaarheden**: firmware wordt via een eigen vertaaltabel een CPE, die we
   koppelen aan NVD-versiebereiken. KEV, EPSS en NCSC (kans hoog) bepalen factor m.
   Exacte versie in het bereik = "vastgesteld". Zonder versie tellen alleen
   KEV-lekken mee, als "mogelijk" (anders telt elk lek ooit in dat product mee).
4. **Bevindingen voor het scoremodel**: lek in router/netwerkapparaat, lek in een
   ander apparaat, firmware-update klaar, plus de bestaande inventarisbevindingen
   (onbeheerd, updates achter, beheerder zonder MFA). Een router of firewall telt
   als randapparaat (z = 1,0). Gewichten zijn voorlopig; Light-rapporten veranderen niet.

## Connectors

| Connector | Hoe | Niveau | Bereikbaar |
|---|---|---|---|
| UniFi (Ubiquiti) | Network API op de console (`/proxy/network/integration/v1`), API-sleutel, alleen GET | 1C | Cloud of lokaal |
| FRITZ!Box (AVM) | TR-064 (SOAP), https-poort 49443, Digest, 4 vaste leesacties | 1C | Lokaal (connector) |
| MikroTik | RouterOS 7 REST API, Basic over https, groep met alleen `read,api,rest-api` | 1C | Lokaal (connector) |
| Tabellen (generiek) | ARP/DHCP: `arp -a` (Windows, macOS/Linux), `ip neigh`, dnsmasq, ISC dhcpd, Windows DHCP-export | 2P | Lokaal (connector) |
| SNMP (generiek) | Alleen SNMPv2-MIB en IP-MIB, alleen lezen, één IP | **2A** | Pas na akkoord |

De generieke routes zijn voor oudere routers en merken zonder eigen connector. Welke
merken als eerstvolgende een eigen connector krijgen, hangt af van het marktonderzoek
en wat IT-partners gebruiken; een nieuwe connector is één bestand dat `RouterConnector`
implementeert.

SNMP staat in het ontwerp op niveau 2A (Qbicle stuurt zelf verkeer). De connector
weigert zonder verwijzing naar een getekende opdracht, en de echte UDP-sessie is er
nog niet: die komt na akkoord op de scangrenzen.

### Alleen lezen, afgedwongen

Elke connector gaat door een `ReadOnlyGuard` met een vaste lijst van methode + pad
(en bij TR-064 de SOAP-actie). Alles daarbuiten, zoals een reboot of een
instelling wijzigen, wordt geweigerd voordat het de router bereikt. Er zijn geen
pings, poortscans of bannergrabs. Redirects worden niet gevolgd; verzoeken buiten de
opgegeven router ook niet.

## Inloggegevens

- In code altijd in een `Secret`: toString, JSON en console.log geven `[geheim]`.
  Foutmeldingen bevatten nooit inloggegevens, antwoorden of de SID van de FRITZ!Box.
- Opslag: AES-256-GCM met sleutelring `QBICLE_SECRETS_KEYS` (rotatie mogelijk),
  gebonden aan organisatie en bron. Tabel `source_secret` (migratie 0004) bevat alleen
  versleutelde waarden en accepteert alleen een bron van dezelfde organisatie.
- Routers die alleen lokaal bereikbaar zijn (FRITZ!Box, MikroTik) houden hun
  wachtwoord op de connector, zoals het ontwerp vraagt.
- TLS: systeemcertificaten, of het vastgepinde certificaat van de router (PEM). Er is
  geen optie "certificaat niet controleren". Basic-auth over http wordt geweigerd.

## AVG

- Hostnamen met een naam ("LAPTOP-ERIK", "iPhone-van-Sanne") worden niet bewaard;
  we tonen "LAPTOP-…". De categorie wordt eerst bepaald, alleen in het geheugen.
- Gastapparaten: MAC alleen als HMAC per organisatie (`QBICLE_PSEUDONYM_KEY`, roteert
  niet mee), privacy-MAC's helemaal niet, hostnaam nooit als identifier.
- Fabrikant en categorie blijven: die zeggen iets over het apparaat, niet over de persoon.
- MAC-prefixen zoeken we offline op (IEEE-register via `scripts/oui-update.sh`),
  zodat MAC-adressen van klanten niet naar een derde gaan.

## Open

- Echte apparaten: de fixtures zijn naar de documentatie gemaakt. Per merk één keer
  testen tegen een echt apparaat en de fixture vervangen door een geanonimiseerde opname.
- Volgorde van de volgende connectors: na het marktonderzoek en de IT-partners.
- SNMP-sessie (UDP, bij voorkeur SNMPv3): na akkoord op de scangrenzen (stap 2).
- Ophalen van NVD/KEV/EPSS/NCSC-snapshots (fase 4); NCSC-CSAF-verwerking. Nu worden
  NCSC-adviezen al als kans/schade per advies ingelezen.
- UniFi: WAN-adres via Site Manager; CPE-namen per UniFi-product controleren in NVD.
- Opslaan van waarnemingen/assets in PostgreSQL en de API-endpoints om een router te koppelen.
- End-of-life-data (endoflife.date) voor "buiten ondersteuning".
