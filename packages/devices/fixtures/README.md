# Fixtures voor apparaatherkenning

Antwoorden zoals een router of controller ze geeft, zodat alles zonder echte
hardware te testen en te demonstreren is (`npm run apparaten -- --demo`).

- `unifi.json`, `meraki.json`, `fritzbox.json`, `mikrotik.json`, `upnp.json`: per verzoek ("METHODE pad", bij
  TR-064 "POST pad#actie") het antwoord. Opgebouwd naar de documentatie van de
  fabrikant; **controleer ze tegen een echt apparaat** voordat een connector live gaat
  (vervang dan de fixture door een geanonimiseerde opname).
- `oui-voorbeeld.csv`: een klein stukje in het formaat van het IEEE-register. Alleen
  voor tests en de demo; het echte register haal je op met `scripts/oui-update.sh`.
- `nvd-voorbeeld.json`, `kev-voorbeeld.json`, `ncsc-voorbeeld.json`: vereenvoudigde
  kwetsbaarheidsdata in het formaat van NVD API 2.0 en de CISA KEV-catalogus.
  CVE-2018-14847 (MikroTik Winbox) is echt en staat in KEV; het bereik is vereenvoudigd.
  Alle **CVE-2099-…** en **NCSC-2099-…** zijn verzonnen testwaarden.

- `upnp.json` is een providermodem zoals een KPN Experia Box zich via UPnP zou kunnen melden. Fabrikant en model zijn ter illustratie; controleer met een echt modem.
- `eol-voorbeeld.json`: voorbeelddata, niet als feit gebruiken.

Namen, MAC-adressen en serienummers zijn verzonnen.
