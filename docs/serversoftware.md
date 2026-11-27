# Software en server per website

Per website laat Qbicle zien welke software er draait, of die nog beveiligingsupdates krijgt,
of er updates klaarliggen, wie het moet bijwerken en welke standaard beveiligingsmaatregelen aan staan.
Zichtbaar op de detailpagina van een website (sectie **Software en server**) en in de tekstuitvoer van de scanner.

## Wat we herkennen (alleen passief)

Alles komt uit hetzelfde ene bezoek aan de voorpagina dat de andere webchecks al doen: headers,
cookienamen, de generator-tag en de adressen van scripts en stylesheets. Geen extra verzoeken, geen
verborgen bestanden (geen `readme.html`, `/wp-login.php`, `CHANGELOG.txt`), geen poortscans, nooit lekken uitproberen.

| Onderdeel | Herkenning | Wie werkt bij |
|---|---|---|
| Webserver (Apache, nginx, IIS, LiteSpeed, Tomcat) | Server-header | hostingpartij |
| PHP, ASP.NET | X-Powered-By, cookie `PHPSESSID` | hostingpartij |
| OpenSSL | Server-header | hostingpartij |
| Besturingssysteem (Ubuntu, Debian, Red Hat, CentOS, Windows) | opmerking in Server-header, IIS | hostingpartij |
| WordPress, Drupal, Joomla, TYPO3 | generator-tag, `X-Generator`, paden (`/wp-content/`, `/misc/drupal.js`, `/media/jui/`) | webbouwer |
| Magento, PrestaShop, Shopware | headers, cookies, paden | webbouwer |
| WordPress-plug-ins en thema | `/wp-content/plugins/<naam>/` en `?ver=` | webbouwer |
| jQuery, jQuery UI, Bootstrap, AngularJS, Vue | versie in het scriptadres | webbouwer |
| Shopify, Wix, Squarespace, Webflow, Lightspeed | headers en CDN-adressen | leverancier (niets te doen) |
| Cloudflare, Akamai, CloudFront | Server-header, `cf-ray` | beschermlaag; server erachter onzichtbaar |

## Zekerheid

- **Zeker**: de website meldt het zelf (header, generator-tag).
- **Waarschijnlijk**: afgeleid uit een pad, bestandsnaam of `?ver=`. Bevindingen hierop zijn altijd "mogelijk" (telt half).
- **Versie verborgen**: goed; dan zeggen we niets over updates ("niet te beoordelen"), nooit "in orde".
- **Distributie**: Ubuntu/Debian/Red Hat zetten fixes terug zonder het versienummer te verhogen. Dan tonen we het,
  maar tellen we einde-ondersteuning niet mee (`*_einde_distro`, gewicht 0). Meldt de server Red Hat, dan geldt dat
  ook voor PHP zonder eigen distributietekst (Red Hat zet die er niet in, Ubuntu en Debian wel).

## Kennisbank

- Einde-ondersteuning en nieuwste versies: snapshot van [endoflife.date](https://endoflife.date) in
  `packages/scanner/src/kennis/eol-snapshot.json` (21 producten). Verversen: `npm run kennis:bijwerken`
  (zonder node, in Docker: `docker compose run --rm --entrypoint npx scanner tsx packages/scanner/src/kennis/bijwerken.ts /data/eol-snapshot.json`,
  daarna `testset/eol-snapshot.json` over het bestand in de repo zetten). In productie wordt dit een wekelijkse taak. Leest de openbare bronbestanden
  op GitHub; mislukt één product, dan wordt niets overschreven. Een ander bestand gebruiken: `QBICLE_EOL_FILE`.
- Lekken: dezelfde VulnDb als voorheen (startset met bron, plus NVD/KEV/EPSS-snapshots via `QBICLE_VULN_DIR`).
- Tests en meetset gebruiken een vaste kopie (`packages/scanner/test/fixtures/eol-snapshot.json`), zodat een nieuwe stand geen tests breekt.

## Score en acties (model v0.5)

| Sleutel | Gewicht | Actie |
|---|---|---|
| `web.server_kwetsbaar` / `web.software_kwetsbaar` | 25 | server-bijwerken (hostingpartij) / software-bijwerken (webbouwer) |
| `web.server_einde_ondersteuning` / `web.software_einde_ondersteuning` | 15 | idem |
| `web.server_einde_binnenkort` / `web.software_einde_binnenkort` | 3 | idem |
| `web.software_update_achter` (CMS mist patches binnen ondersteunde reeks) | 5 | software-bijwerken |
| `web.server_update_achter` (server mist patches, zonder bekend lek) | 1 | server-bijwerken |
| `web.bibliotheek_einde` (jQuery 1/2, AngularJS ...) | 5 | software-bijwerken |

Alle gewichten zijn voorlopig en worden in de pilot gekalibreerd.

## Nog niet

- Of plug-ins en thema's achterlopen (vraagt een plug-inbron, bijvoorbeeld de WordPress.org-API of Wordfence Intelligence).
- Of oude TLS-versies (1.0/1.1) nog aan staan; nu zien we alleen de versie die de server met ons afsprak.
