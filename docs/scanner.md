# Scanner

## Contract van een check

Elke check krijgt één asset (het domein of een website) en levert:

- een uitkomst: `ok`, `finding`, `unknown`, `error` of `not_applicable`;
- nul of meer bevindingen, elk met een zekerheidslabel (Technisch vastgesteld, Mogelijk risico, Onbekend, Door jou opgegeven);
- bewijs: wat we precies zagen (records, headers, certificaatgegevens);
- het niveau (0 of 1).

De runner (`src/scan.ts`) bewaakt de belangrijkste regel uit het ontwerp: **een check die faalt levert nooit "in orde" op.** Een crash wordt `error`, een netwerkstoring wordt `unknown`, en tegenstrijdige uitkomsten worden rechtgezet. Tests controleren dit voor elke check bij DNS- en netwerkstoringen.

Bestaat het domein niet in DNS, of werkt DNS niet, dan stopt de scan met een melding. Anders zou alles "ontbreekt" lijken.

## Checks in deze versie

| Check | Niveau | Bevindingen |
|---|---|---|
| `mail.spf` | 0 | ontbreekt, meerdere records, syntaxfout, `+all`, `?all`, geen afsluiting, meer dan 10 lookups, verwijzing zonder SPF |
| `mail.dmarc` | 0 | ontbreekt, meerdere records, geen geldig beleid, `p=none`, `pct` onder 100, `sp=none`, geen rapportage-adres |
| `mail.dkim` | 0 | bekende selectors van grote providers; niets gevonden = Onbekend, nooit een bevinding |
| `dns.dnssec` | 0 | ontbreekt, kapot (resolver weigert); via een validerende DNS-over-HTTPS-resolver |
| `dns.caa` | 0 | ontbreekt |
| `tls.certificate` | 1 | verlopen, keten onvolledig, zelfgemaakt, ongeldig, verkeerde naam, verloopt binnen 14 of 30 dagen |
| `web.https_redirect` | 1 | http blijft onbeveiligd |
| `web.headers` | 1 | HSTS ontbreekt of te kort, geen CSP, geen nosniff, insluiten niet afgeschermd, geen Referrer-Policy |
| `web.cookies` | 1 | cookie zonder Secure; sessie- of inlogcookie zonder HttpOnly (Mogelijk risico) |
| `web.version_disclosure` | 1 | softwareversie zichtbaar in headers of meta generator; levert ook de software-inventaris voor fase 4 |
| `web.software` | 1 | zichtbare software met bekende lekken (CVE, KEV) of zonder beveiligingsupdates, met bronvermelding; zie [scanner-kwaliteit.md](scanner-kwaliteit.md) |
| `web.security_txt` | 1 | ontbreekt of verlopen; doorverwijzing naar een geldige security.txt elders is in orde |

Websitechecks draaien op het hoofddomein en `www`, als die een publiek IP-adres hebben.

## Gedragsregels

- **User-Agent:** `QbicleScanner/<versie> (+<uitleglink>)`. Zet `QBICLE_SCANNER_INFO_URL` op de echte uitlegpagina zodra die bestaat.
- **Time-outs:** 5 seconden per verzoek; DNS twee pogingen.
- **Aantal verzoeken per host:** een TLS-handshake, `http://host/`, `https://host/`, `security.txt`, plus maximaal 5 redirects binnen het domein.
- **Geen interne adressen:** elke verbinding loopt via `safeLookup`, die alleen publieke IP-adressen toestaat. Dat geldt ook na redirects, zodat DNS-rebinding geen intern adres oplevert.
- **Geen andere domeinen:** een redirect naar een ander domein wordt niet gevolgd. Het rapport zegt dan dat de site doorverwijst.
- **Opt-out:** `QBICLE_OPTOUT_FILE` wijst naar een lijst domeinen die niet gescand willen worden (later een tabel `scan_opt_out`).
- **Invoer:** IP-adressen, poorten, e-mailadressen en interne namen (`.local`, `.internal`, `home.arpa` enz.) worden geweigerd.

## Bekende beperkingen

- DKIM-selectors zijn niet op te vragen; we kunnen alleen raden. Daarom is "niet gevonden" Onbekend.
- De DNSSEC-check gebruikt standaard de DNS-over-HTTPS-API van Cloudflare. Voor productie kiezen we een resolver die past bij de EU-hostingkeuze (instelbaar via `QBICLE_DOH_URL`).
- Certificaatvalidatie gebruikt de vertrouwde CA-lijst van Node.js (Mozilla).
- MTA-STS, TLS-RPT, CT-logs, RDAP (domeinverloop, registrar-lock), zwevende CNAME's en subdomeinen volgen in de volgende stap.
