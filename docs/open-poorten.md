# Open poorten en apparaten van buitenaf

Vraag (Erik, 27-11-2026): het voorbeeldrapport op de website noemt bevindingen als
"Extern bureaublad open voor iedereen (poort 3389)", "camerasysteem met inlogpagina op
internet", een VPN met een bekend lek en vergeten servers. Wat ziet Qbicle daar nu echt van?

Scangrens (Erik, 26-11, staat vast): actief poorten scannen alleen met een getekende
scanopdracht per netwerk, nooit kwetsbaarheden uitproberen.

## Wat er nu is

| Wat | Waar | Status |
|---|---|---|
| Websites op het domein en `www` (poort 80 en 443): certificaat, headers, zichtbare software en lekken | `packages/scanner` | Werkt, van buiten |
| Andere poorten op servers of IP-adressen van de klant (3389, 22, camera, NAS, VPN) | — | **Niet van buiten.** De scanner doet geen poortscan. |
| VPN-apparaat met bekend lek | — | Alleen als de VPN op een website-adres draait en zijn versie laat zien; verder niet |
| Poorten die de router doorzet naar binnen | `packages/devices` | Werkt via de routerkoppeling, zie hieronder |

Het overzicht zei bij servers ten onrechte "welke poorten open staan". Dat is aangepast
(`packages/platform/src/dekking.ts`): we zeggen nu dat we van buiten alleen de websites
bekijken, en dat open poorten via de router- of firewallkoppeling komen.

## Uitlezen uit de router (geen scan)

De router vertelt zelf welke poorten hij van internet naar binnen doorzet. Dat is het
betrouwbaarst (het is de echte instelling) en valt niet onder actief scannen.

| Router | Hoe | Bron |
|---|---|---|
| Providermodem (KPN, Ziggo, Odido) | UPnP `GetGenericPortMappingEntry`: poorten die apparaten zelf openden | lokaal (connector) |
| FRITZ!Box | TR-064 `GetPortMappingNumberOfEntries` + `GetGenericPortMappingEntry` (WANIPConnection, bij DSL WANPPPConnection) | lokaal (connector) |
| MikroTik | REST `/ip/firewall/nat` (dst-nat) en `/ip/upnp` | lokaal (connector) |
| UniFi | `GET /proxy/network/api/s/{site}/rest/portforward` met dezelfde API-sleutel | lokaal of via Site Manager |
| Cisco Meraki | `GET /networks/{id}/appliance/firewall/portForwardingRules` en `oneToOneNatRules` | cloud-API |

Alles gaat door de `ReadOnlyGuard`: alleen deze leesverzoeken zijn toegestaan.

**Nog te testen tegen een echt apparaat:** de fixtures zijn opgebouwd naar de documentatie.
Bij UniFi staat port forwarding niet in de officiële Network API v1; we gebruiken de
klassieke lijst. Werkt die niet (oudere versie, sleutel zonder toegang), dan zegt
Qbicle "niet uitgelezen" en gaat de rest van de koppeling gewoon door.

### Bevindingen

- **Beheerpoort open naar internet**: RDP, SSH, Telnet, SMB, databases, VNC, Winbox,
  NAS-beheer (Synology 5000/5001), camerasystemen (RTSP 554, Hikvision 8000, Dahua 37777),
  PPTP-VPN, of een webpagina (80/443/8080/8443) van een gevoelig apparaat (camera, NAS,
  router, alarm, zonnepanelen, laadpaal, printer). Ook 1:1 NAT/DMZ ("alle poorten").
- **Poort open naar internet**: andere doorgezette poorten.
- Elke bevinding zegt in gewone taal wat er open staat, voor wie (iedereen of alleen
  bepaalde adressen), en **hoe je hem sluit**, met de menunaam van die router, plus
  het advies om een VPN of de app van de fabrikant te gebruiken.
- Alleen open voor vaste adressen: de bevinding blijft, maar telt half zo zwaar (z = 0,5).

### Eerlijke status

`forwardCoverage(readouts)` (en `openPoorten` in het resultaat van `discover`):

- **niet gecontroleerd**: geen router gekoppeld, of de router gaf de lijst niet;
- **deels**: niet elke router gaf de lijst, of de router staat achter het providermodem
  (dubbele NAT: ook het modem kan poorten doorzetten);
- **gecontroleerd**: elke router gaf de volledige lijst.

Een lege lijst betekent alleen "niets open" als de router hem echt gaf.

## Routes die nog niet gebouwd zijn

- **Openbare internetscandata** (Shodan, Censys) over de eigen IP-adressen van de klant.
  Shodan InternetDB is gratis maar niet voor commerciële producten; betaalde Shodan-API
  vanaf $69/maand met commercieel gebruik en bronvermelding. Censys noemt geen prijzen
  en geen voorwaarden voor commercieel gebruik in de openbare documentatie. Keuze ligt bij Erik.
- **Eigen poortcheck** van de publieke IP's: alleen met getekende scanopdracht, vaste
  poortlijst, snelheidslimiet, eigendom gecontroleerd. Na juristtoets.
- **Lokale connector/sensor** (1.1): ziet ook wat binnen open staat.
