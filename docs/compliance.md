# Compliance-checks: cookiecheck (proof of concept)

Ontwerp: [Qbicle Compliance Check: ontwerp websites en systemen](https://claude.ai/artifact/L8oKk2tVVcycXtV5heUCZX).

`packages/compliance` controleert of een website trackers en cookies plaatst
voordat de bezoeker toestemming geeft, en of weigeren werkt. Het is een
**technische waarneming, geen juridisch oordeel**: of iets mag, beoordeelt een
jurist of de toezichthouder.

## Hoe het werkt

Een gewone headless Chromium bezoekt de homepage drie keer, elk keer met een schoon profiel:

| Bezoek | Wat we doen | Wat we vastleggen |
| --- | --- | --- |
| `geen-keuze` | Pagina openen, niets klikken | Cookies, namen van localStorage-sleutels, alle verzoeken; cookiebanner en knoppen |
| `weigeren` | Klik op de weigerknop van de banner | Idem, na de klik |
| `accepteren` | Klik op de akkoordknop | Idem; dient ook als controle dat onze klik aankomt |

`evaluateConsent` (pure functie, zonder browser te testen) maakt daaruit drie controles:

| Controle | Bevinding | Zekerheid |
| --- | --- | --- |
| `consent.voor_keuze` Geen tracking vóór toestemming | `consent.tracking_before_consent` per tracker | Marketing: vastgesteld. Analytisch: mogelijk (kan privacyvriendelijk zijn ingesteld; zien we niet). Google Consent Mode "geweigerd" zonder cookies: mogelijk |
| `consent.weigeroptie` Weigeren even makkelijk als accepteren | `consent.no_reject_first_layer`, of `consent.banner_missing` als er wel tracking is maar geen banner | Mogelijk (een afwijkende banner kunnen we missen) |
| `consent.na_weigeren` Geen tracking na weigeren | `consent.tracking_after_reject` per tracker | Als hierboven. Geen weigerknop of klik mislukt: onbekend |

Een pagina die niet laadt, geeft `unknown`, nooit `ok`. Cookies van derden die we niet
herkennen, tonen we apart en rekenen we niet mee.

- Trackerlijst: `src/trackers.ts` (Google Analytics, Google Ads/DoubleClick, Meta Pixel, LinkedIn, Hotjar,
  Microsoft Clarity en Ads, TikTok, YouTube, Matomo; Google Tag Manager telt zelf niet als tracker).
- Banners: `src/banner.ts` herkent Cookiebot, OneTrust, CookieYes en Complianz op hun knoppen, en anders
  zichtbare knoppen met teksten als "Accepteren", "Akkoord", "Weigeren" of "Alleen noodzakelijk".
  Alleen de eerste laag telt.
- Bevindingen in het bestaande model: `toFindings(checks, asset)` geeft `Finding`s met vingerafdruk op het asset
  `website`. Voorstel voor gewichten en acties: `PROPOSED_WEIGHTS` en `PROPOSED_ACTIONS` in `src/model.ts`.
  Die staan bewust nog niet in `packages/score` (open keuze: urgentiescore of eigen nalevingsoverzicht).

## Spelregels

De cookiecheck doet meer dan de scanner op niveau 1: de browser laadt alle scripts,
afbeeldingen en diensten van derden die de site zelf laadt, net als een bezoeker.
We noemen dat **niveau 1B, browserbezoek**. Wel:

- alleen klikken op de knoppen van de cookiebanner; geen formulieren, niet inloggen;
- alleen http en https; geen verbindingen met interne of gereserveerde IP-adressen
  (ook niet voor scripts van derden); de hoofdpagina blijft op het opgegeven domein;
- vaste User-Agent met `QbicleComplianceCheck` en uitleglink, tijdslimieten, maximaal 400 verzoeken per bezoek;
- de drie bezoeken na elkaar, niet parallel; de opt-outlijst (`QBICLE_OPTOUT_FILE`) geldt ook hier;
- van URL's bewaren we de namen van query-parameters, niet de waarden (die kunnen persoonsgegevens bevatten),
  behalve de Consent Mode-signalen `gcs` en `gcd`. Van localStorage bewaren we alleen de sleutelnamen.

Restrisico: Chromium doet zijn eigen DNS-lookup na onze controle (DNS-rebinding). In productie draait de
browser daarom in een aparte worker zonder toegang tot het interne netwerk, achter een uitgaande proxy die
dezelfde IP-regels afdwingt.

## Draaien

```bash
# Chromium is nodig. Lokaal eenmalig:
npx playwright-core install chromium
# of een eigen Chromium: QBICLE_CHROMIUM_PATH=/pad/naar/chromium

npm run consent -- https://www.voorbeeld.nl          # samenvatting
npm run consent -- https://www.voorbeeld.nl --json   # waarnemingen + beoordeling
```

De tests (`packages/compliance/test`) draaien een echte headless Chromium tegen nagemaakte
testsites. Alle verzoeken worden lokaal beantwoord, ook die naar bijvoorbeeld
`www.google-analytics.com`; de tests raken het internet niet. Zonder Chromium worden de
browsertests overgeslagen, behalve met `QBICLE_REQUIRE_BROWSER=1` (zo staat het in CI).

## Wat nog niet

- Alleen de homepage; geen tweede pagina, geen scrollen (sommige trackers laden pas dan).
- Geen controle van de inhoud van de privacyverklaring, bedrijfsgegevens of toegankelijkheid (zie ontwerp, volgende stappen).
- Niet in het Docker-image van de scanner: de browser krijgt een eigen worker-image.
- Niet getest op echte sites; eerste stap na akkoord is de testset van 22 domeinen.
