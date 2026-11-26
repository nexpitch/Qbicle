# Scoremodel

Versie `light-2026.11-v0.4`, uitgewerkt uit het technisch ontwerp. Code: `packages/score`.

## Formule

Per open bevinding *i*: `w = b × m × z × k × r`

| Factor | Waarden |
|---|---|
| b, basisgewicht | per bevinding, zie tabel hieronder |
| m, misbruik | 2,0 als een gekoppelde CVE in CISA KEV staat; 1,5 bij EPSS boven 0,1, een NCSC-advies met kans hoog of een DTC-waarschuwing; anders 1,0 |
| z, zichtbaarheid | 1,0 hoofddomein, website en mail; 0,7 overige subdomeinen; 0,5 alleen in CT-logs |
| k, zekerheid | 1,0 Technisch vastgesteld en Door jou opgegeven; 0,5 Mogelijk risico; 0 Onbekend |
| r, herhaling | 1,0 voor de zwaarste bevinding per sleutel; 0,25 voor dezelfde sleutel op een ander asset (bijvoorbeeld apex en www); 0 voor een tweede "kapot certificaat"-bevinding op hetzelfde certificaat |

Per actie geldt een plafond (website-headers 10, cookies 5, softwareversies 5, mail-dichtzetten 18). Urgentie = `round(100 × (1 − e^(−Σw / 60)))`, dezelfde afvlakking als in het prototype.

## Wijzigingen in v0.2

Na de eerste testset (22 domeinen, 26 november 2026): herhalingsfactor r, kapotte certificaatbevindingen niet stapelen, plafond per actie, en `cert.untrusted_ca` los van `cert.self_signed`. Google ging in v0.1 naar Hoge urgentie door dubbeltelling van apex en www; dat was niet de bedoeling.

## Wijzigingen in v0.4

Na de live testset met v0.3 (26-11-2026, 22 van 22 in de verwachte band) twee bijstellingen:

- Einde ondersteuning op een server die Ubuntu, Debian of Red Hat meldt, wordt `web.software_einde_distro` met gewicht 0. Die distributies werken hun eigen versies vaak jaren langer bij (nginx 1.24 in Ubuntu 24.04 tot 2029). Welke distributieversie draait, zien we niet, dus we tonen het wel maar het telt niet mee. bitsoffreedom.nl ging daardoor ten onrechte van 27 naar 36.
- Plafond `mail-dichtzetten` van 25 naar 18. neverssl.com (geen mail, verder alleen hygiëne) kwam op 54, Hoge urgentie. Met 18 komt hij op 48; een domein waar alleen SPF en DMARC ontbreken blijft op 26, Aandacht nodig.

Herberekend op de live resultaten: bitsoffreedom.nl 36 naar 25, neverssl.com 54 naar 48, http.badssl.com 65 naar 56, de andere badssl-domeinen 81 naar 75. Alle 22 blijven in de verwachte band.

## Wijzigingen in v0.3

Na het invoeren van de vaste meetset (`npm run meetset`, zie [scanner-kwaliteit.md](scanner-kwaliteit.md)):

- Kapot certificaat van 40 naar 45 (voorlopig): op zichzelf nu Hoge urgentie (53), net als kapotte DNSSEC. Bezoekers krijgen een blokkerende waarschuwing; met 40 bleef dat op 49 hangen.
- Nieuw: `web.software_kwetsbaar` (25), `web.software_einde_ondersteuning` (15) en `web.software_einde_binnenkort` (3), actie `software-bijwerken`. Een KEV-lek geeft via m = 2 gewicht 50.
- Nieuw: `spf.missing_no_mail` (10) en `dmarc.missing_no_mail` (15) voor domeinen zonder MX, actie `mail-dichtzetten` ("zet je domein dicht voor nepmail").
- KEV-ondergrens alleen bij zekerheid "vastgesteld". Een "mogelijk" lek (bijvoorbeeld Ubuntu, dat fixes terugzet zonder het versienummer te verhogen) telt mee via m en k, maar tilt de band niet op.
- Onder 80% dekking zet het resultaat `coverageWarning`; het rapport toont die naast de score.

## Regels

- **Banden:** 0–24 Weinig urgent, 25–49 Aandacht nodig, 50–74 Hoge urgentie, 75+ Direct oppakken.
- **KEV-ondergrens:** een vastgestelde bevinding met een KEV-kwetsbaarheid zet de band minimaal op Hoge urgentie.
- **Dekking:** checks met uitkomst `ok` of `finding`, gedeeld door alle checks behalve `not_applicable`. Onbekend en fout verlagen de dekking, niet de score.
- **Dubbele bevindingen:** dezelfde vingerafdruk telt één keer.
- **Acties:** gegroepeerd per actie, gesorteerd op de som van de gewichten (bij gelijk gewicht alfabetisch), maximaal drie in het rapport.
- **Onbekende sleutel:** telt mee met gewicht 10 en wordt apart gemeld, zodat een nieuwe check nooit stilzwijgend wegvalt.
- **Versiebeheer:** verander je een gewicht, verhoog dan `MODEL_VERSION`. Elke score-snapshot bewaart de versie en de volledige berekening.

## Gewichten

"Voorlopig" betekent: niet in het ontwerp genoemd, eerste inschatting, kalibreren in de pilot met 10 tot 20 echte domeinen naast het oordeel van een securityspecialist.

| Bevinding | b | Actie | Voorlopig |
|---|---|---|---|
| `cert.expired` | 45 | `cert-vernieuwen` | ja (was 40) |
| `cert.invalid` | 45 | `cert-vernieuwen` | ja (was 40) |
| `cert.chain_incomplete` | 45 | `cert-vernieuwen` | ja (was 40) |
| `cert.self_signed` | 45 | `cert-vernieuwen` | ja (was 40) |
| `cert.untrusted_ca` | 45 | `cert-vernieuwen` | ja |
| `cert.name_mismatch` | 45 | `cert-vernieuwen` | ja (was 40) |
| `cert.expires_14d` | 20 | `cert-automatisch` | nee |
| `cert.expires_30d` | 10 | `cert-automatisch` | ja |
| `spf.plus_all` | 30 | `spf-repareren` | nee |
| `spf.missing` | 15 | `spf-instellen` | nee |
| `spf.multiple` | 15 | `spf-repareren` | ja |
| `spf.syntax` | 15 | `spf-repareren` | ja |
| `spf.too_many_lookups` | 15 | `spf-repareren` | ja |
| `spf.include_broken` | 15 | `spf-repareren` | ja |
| `spf.neutral_all` | 10 | `spf-repareren` | ja |
| `spf.no_all` | 5 | `spf-repareren` | ja |
| `spf.missing_no_mail` | 10 | `mail-dichtzetten` | ja |
| `dmarc.missing` | 20 | `dmarc-instellen` | nee |
| `dmarc.missing_no_mail` | 15 | `mail-dichtzetten` | ja |
| `dmarc.multiple` | 20 | `dmarc-instellen` | ja |
| `dmarc.syntax` | 20 | `dmarc-instellen` | ja |
| `dmarc.p_none` | 10 | `dmarc-aanscherpen` | nee |
| `dmarc.partial` | 5 | `dmarc-aanscherpen` | ja |
| `dmarc.sp_none` | 5 | `dmarc-aanscherpen` | ja |
| `dmarc.no_rua` | 2 | `dmarc-aanscherpen` | ja |
| `dnssec.missing` | 3 | `dnssec-aanzetten` | nee |
| `dnssec.invalid` | 45 | `dnssec-repareren` | ja |
| `caa.missing` | 2 | `caa-instellen` | ja |
| `web.no_https_redirect` | 10 | `https-afdwingen` | ja |
| `web.hsts_missing` | 5 | `website-headers` | nee |
| `web.hsts_short` | 2 | `website-headers` | ja |
| `web.csp_missing` | 3 | `website-headers` | nee |
| `web.framing_unprotected` | 3 | `website-headers` | ja |
| `web.xcto_missing` | 2 | `website-headers` | ja |
| `web.referrer_missing` | 1 | `website-headers` | ja |
| `web.cookie_insecure` | 5 | `cookies-beveiligen` | ja |
| `web.cookie_no_httponly` | 2 | `cookies-beveiligen` | ja |
| `web.version_disclosed` | 3 | `versies-verbergen` | ja |
| `web.software_kwetsbaar` | 25 | `software-bijwerken` | ja |
| `web.software_einde_ondersteuning` | 15 | `software-bijwerken` | ja |
| `web.software_einde_binnenkort` | 3 | `software-bijwerken` | ja |
| `web.software_einde_distro` | 0 | `software-bijwerken` (alleen ter informatie) | ja |
| `web.securitytxt_missing` | 3 | `securitytxt-plaatsen` | nee |
| `web.securitytxt_expired` | 2 | `securitytxt-plaatsen` | ja |
