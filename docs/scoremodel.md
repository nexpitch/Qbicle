# Scoremodel

Versie `light-2026.11-v0.1`, uitgewerkt uit het technisch ontwerp. Code: `packages/score`.

## Formule

Per open bevinding *i*: `w = b × m × z × k`

| Factor | Waarden |
|---|---|
| b, basisgewicht | per bevinding, zie tabel hieronder |
| m, misbruik | 2,0 als een gekoppelde CVE in CISA KEV staat; 1,5 bij EPSS boven 0,1, een NCSC-advies met kans hoog of een DTC-waarschuwing; anders 1,0 |
| z, zichtbaarheid | 1,0 hoofddomein, website en mail; 0,7 overige subdomeinen; 0,5 alleen in CT-logs |
| k, zekerheid | 1,0 Technisch vastgesteld en Door jou opgegeven; 0,5 Mogelijk risico; 0 Onbekend |

Urgentie = `round(100 × (1 − e^(−Σw / 60)))`, dezelfde afvlakking als in het prototype.

## Regels

- **Banden:** 0–24 Weinig urgent, 25–49 Aandacht nodig, 50–74 Hoge urgentie, 75+ Direct oppakken.
- **KEV-ondergrens:** een bevinding met een KEV-kwetsbaarheid zet de band minimaal op Hoge urgentie.
- **Dekking:** checks met uitkomst `ok` of `finding`, gedeeld door alle checks behalve `not_applicable`. Onbekend en fout verlagen de dekking, niet de score.
- **Dubbele bevindingen:** dezelfde vingerafdruk telt één keer.
- **Acties:** gegroepeerd per actie, gesorteerd op de som van de gewichten (bij gelijk gewicht alfabetisch), maximaal drie in het rapport.
- **Onbekende sleutel:** telt mee met gewicht 10 en wordt apart gemeld, zodat een nieuwe check nooit stilzwijgend wegvalt.
- **Versiebeheer:** verander je een gewicht, verhoog dan `MODEL_VERSION`. Elke score-snapshot bewaart de versie en de volledige berekening.

## Gewichten

"Voorlopig" betekent: niet in het ontwerp genoemd, eerste inschatting, kalibreren in de pilot met 10 tot 20 echte domeinen naast het oordeel van een securityspecialist.

| Bevinding | b | Actie | Voorlopig |
|---|---|---|---|
| `cert.expired` | 40 | `cert-vernieuwen` | nee |
| `cert.invalid` | 40 | `cert-vernieuwen` | nee |
| `cert.chain_incomplete` | 40 | `cert-vernieuwen` | nee |
| `cert.self_signed` | 40 | `cert-vernieuwen` | nee |
| `cert.name_mismatch` | 40 | `cert-vernieuwen` | nee |
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
| `dmarc.missing` | 20 | `dmarc-instellen` | nee |
| `dmarc.multiple` | 20 | `dmarc-instellen` | ja |
| `dmarc.syntax` | 20 | `dmarc-instellen` | ja |
| `dmarc.p_none` | 10 | `dmarc-aanscherpen` | nee |
| `dmarc.partial` | 5 | `dmarc-aanscherpen` | ja |
| `dmarc.sp_none` | 5 | `dmarc-aanscherpen` | ja |
| `dmarc.no_rua` | 2 | `dmarc-aanscherpen` | ja |
| `dnssec.missing` | 3 | `dnssec-aanzetten` | nee |
| `dnssec.invalid` | 30 | `dnssec-repareren` | ja |
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
| `web.securitytxt_missing` | 3 | `securitytxt-plaatsen` | nee |
| `web.securitytxt_expired` | 2 | `securitytxt-plaatsen` | ja |
