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
| Cisco Meraki | Dashboard API v1 (cloud), API-sleutel van een alleen-lezen beheerder, alleen GET | 1C | Cloud |
| FRITZ!Box (AVM) | TR-064 (SOAP), https-poort 49443, Digest, 4 vaste leesacties | 1C | Lokaal (connector) |
| MikroTik | RouterOS 7 REST API, Basic over https, groep met alleen `read,api,rest-api` | 1C | Lokaal (connector) |
| Providermodem / router via UPnP (generiek) | UPnP IGD: beschrijving, `GetExternalIPAddress`, `GetGenericPortMappingEntry`; geen login | 2P | Lokaal (connector) |
| Tabellen (generiek) | ARP/DHCP: `arp -a` (Windows, macOS/Linux), `ip neigh`, dnsmasq, ISC dhcpd, Windows DHCP-export; mDNS via `avahi-browse` | 2P | Lokaal (connector) |
| SNMP (generiek) | Alleen SNMPv2-MIB en IP-MIB, alleen lezen, één IP | **2A** | Pas na akkoord |

Volgorde. De eerste router bij bijna elk MKB-bedrijf en thuis is het **modem van de
provider** (KPN, Ziggo, Odido). Daarachter zit vaak een eigen router of wifi-systeem.
Daarom:

1. **Generieke laag, voor iedereen:** providermodem via UPnP, apparaten via ARP, DHCP en
   mDNS van de lokale connector, MAC-prefix, end-of-life. SNMP na akkoord.
2. **Eigen routers en wifi in bedrijven en thuis:** UniFi, FRITZ!Box, MikroTik en Meraki
   voor 1.0 (marktonderzoek 26-11; geen openbare marktaandelen per merk voor het NL-MKB,
   dus een schatting). FortiGate als eerste daarna. Bevestigen bij 3 tot 5 IT-partners.

Een nieuwe connector is één bestand dat `RouterConnector` implementeert.

## Providermodems (KPN, Ziggo, Odido)

De klant heeft meestal geen beheerdersgegevens van het modem, en de provider beheert de
firmware op afstand. Wat we zonder providerlogin uitlezen:

| Wat | Hoe | Grens |
|---|---|---|
| Welk modem, van welke provider | UPnP-beschrijving (fabrikant, model), MAC-prefix van de gateway, netwerkeigenaar (ASN) van het WAN-adres | Model genoemd = vastgesteld; alleen fabrikant of ASN = mogelijk |
| Internetadres | UPnP `GetExternalIPAddress` | Alleen als UPnP aanstaat |
| Poorten die apparaten zelf openzetten | UPnP `GetGenericPortMappingEntry` | Handmatig doorgezette poorten zie je zo niet |
| Of UPnP aanstaat | UPnP-beschrijving | Zelf al een bevinding (klein gewicht) |
| Apparaten achter het modem | ARP, DHCP en mDNS via de lokale connector | Het modem geeft zonder login geen lijst |
| Firmware | Meestal niet zichtbaar; beheerd door de provider | Bevinding alleen via end-of-life van het model |
| Wat echt openstaat van buiten | Buitenkant (gegevens van derden, eigen poortcheck) | Stap 2, na akkoord op de scangrenzen |

Doorgezette poorten (uit UPnP of uit de NAT-regels van een eigen router zoals MikroTik)
worden bevindingen. RDP, SMB, Telnet, SSH, VNC, databases en beheerpagina's van camera's,
NAS en routers tellen zwaar ("beheerpoort open naar internet"). Staat een eigen router
achter het modem (privé-WAN-adres, dubbele NAT), dan meldt Qbicle dat ook het modem
gekoppeld moet worden, omdat dat de echte rand van het netwerk is.

Niet gedaan: inloggen op de webinterface van het modem met het wachtwoord van de sticker.
Dat werkt per model anders, is niet officieel ondersteund door de providers en vraagt om
een wachtwoord dat de klant vaak niet heeft. Kan later per model als een partner erom vraagt.

## End-of-life

`EolDb` controleert of een apparaat of zijn firmware nog updates krijgt: per fabrikant en
model (eigen lijst uit de aankondigingen van fabrikanten) en per firmwarecyclus (formaat
van endoflife.date). Uitkomst: buiten ondersteuning, binnenkort (180 dagen), ondersteund
of onbekend. Een router zonder updates is een bevinding (gewicht 25, voorlopig), ook als er
nog geen CVE is. Dat is belangrijk voor bijvoorbeeld oude DrayTek- en Cisco RV-routers.
De data in `fixtures/eol-voorbeeld.json` is voorbeelddata; de echte lijst moet nog worden
samengesteld en gecontroleerd.

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

- Providermodems: per model (KPN Box, Experia Box, Ziggo SmartWifi/Connect Box, Odido) testen wat UPnP echt teruggeeft; de modellijst en de ASN-tabel aanvullen en controleren via RIPEstat.
- SSDP: de lokale connector luistert naar aankondigingen om het adres van de UPnP-beschrijving te vinden (Go-connector).

- Echte apparaten: de fixtures zijn naar de documentatie gemaakt. Per merk één keer
  testen tegen een echt apparaat en de fixture vervangen door een geanonimiseerde opname.
- Volgorde van de volgende connectors: na het marktonderzoek en de IT-partners.
- SNMP-sessie (UDP, bij voorkeur SNMPv3): na akkoord op de scangrenzen (stap 2).
- Ophalen van NVD/KEV/EPSS/NCSC-snapshots (fase 4); NCSC-CSAF-verwerking. Nu worden
  NCSC-adviezen al als kans/schade per advies ingelezen.
- UniFi: WAN-adres via Site Manager; CPE-namen per UniFi-product controleren in NVD.
- Opslaan van waarnemingen/assets in PostgreSQL en de API-endpoints om een router te koppelen.
- End-of-life: de echte lijst (modellen en datums per fabrikant, firmwarecycli) samenstellen en controleren.
- FortiGate-connector (na 1.0).
