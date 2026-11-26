# Kwaliteit van de scanner meten

De scanner moet twee dingen goed doen: echte problemen vinden (geen gemiste bevindingen) en niets melden wat er niet is (geen fout-positieven). Daarnaast moet de urgentieband kloppen met wat een specialist zou zeggen. Dat meten we op twee manieren.

## 1. Vaste meetset (zonder internet)

`npm run meetset` draait 24 nagebootste domeinen (`packages/scanner/meetset/scenarios.ts`) en vergelijkt de uitkomst met wat er verwacht wordt: de band, welke bevindingen er moeten zijn (soms met zekerheid), welke er niet mogen zijn, of het rapport een dekkingswaarschuwing geeft, en welke assets niet gescand mogen worden. Elk scenario is een les uit de echte testset van 26 november 2026 of een veelvoorkomend MKB-geval.

De meetset draait ook in CI (`packages/scanner/test/meetset.test.ts`). Een wijziging die de kwaliteit verlaagt, faalt dus meteen.

Gevonden een fout-positief of een gemiste bevinding? Voeg eerst een scenario toe dat faalt, en repareer dan de scanner. Pas een verwachting alleen aan als die zelf fout blijkt.

### Stand 26-11-2026

| | v0.1 (main) | v0.2 (testsetfixes) | v0.3 (deze versie) |
|---|---|---|---|
| Scenario's helemaal goed | 8 van 24 | 11 van 24 | 24 van 24 |
| Juiste urgentieband | 16 van 24 | 18 van 24 | 24 van 24 |
| Verwachte bevindingen gevonden | 15 van 22 | 16 van 22 | 22 van 22 |
| Valse bevindingen | 8 | 3 | 0 |
| Overige afwijkingen | 6 | 4 | 0 |

Kanttekening: de meetset is samengesteld samen met v0.3, dus 24 van 24 is geen bewijs dat de scanner perfect is. Het bewijst dat de bekende lessen erin zitten en er niet meer uit kunnen verdwijnen. De echte toets blijft de live testset en straks de pilot.

## 2. Live testset (met internet, op een eigen computer)

```
npm run scan -- --bestand testset/testset.txt --uit testset/resultaten --verwacht testset/verwacht.csv
```

`testset/verwacht.csv` legt per domein de verwachte band vast (uit de handmatige analyse van 26-11). De scanner laat tussen domeinen 2 seconden rust (`--pauze`), schrijft per domein of de band klopt in `overzicht.csv` en eindigt met "Band zoals verwacht: x van 22". Echte websites veranderen; pas een verwachting alleen aan als de site zelf aantoonbaar is veranderd.

## Softwareversies, lekken en bronvermelding

De check `web.software` leest wat de website zelf meestuurt (Server, X-Powered-By, generator-tag) en koppelt dat aan:

- **bekende lekken** via dezelfde `VulnDb` als de apparaatherkenning (NVD-bereiken, CISA KEV, EPSS, NCSC). Elke bevinding noemt de CVE's en linkt naar NVD en, als het lek actief misbruikt wordt, naar de KEV-catalogus;
- **einde ondersteuning** per versiereeks (PHP, Apache, nginx, OpenSSL, IIS/Windows Server), met de bron van de fabrikant en endoflife.date.

Regels tegen valse meldingen:

- Meldt de server een Linux-distributie (Ubuntu, Debian, Red Hat en dergelijke), dan is een lek of einde ondersteuning hooguit "mogelijk": distributies zetten fixes terug zonder het versienummer te verhogen.
- Een lek dat alleen onder een onzichtbare voorwaarde geldt (bijvoorbeeld PHP-CGI op Windows) is ook "mogelijk".
- Alleen een vastgesteld KEV-lek tilt de band naar Hoge urgentie.
- Foutpagina's (403 van botbescherming e.d.) worden niet beoordeeld.
- Er wordt niets uitgeprobeerd: alleen het ene bezoek dat de andere webchecks ook doen.

**Kennisbank.** In `packages/scanner/src/kennis/software.ts` staat een kleine, handmatig samengestelde startset (stand 26-11-2026, elke regel met bron). In productie zet de periodieke taak van fase 4 de volledige snapshots in een map en wijst `QBICLE_VULN_DIR` daarnaar: `nvd*.json` (NVD API 2.0), `kev*.json` (CISA) en `epss*.csv` (FIRST). Die worden bij de startset opgeteld.

## Overige verbeteringen in v0.3

- Cookies zonder HttpOnly alleen melden bij sessie- en inlogcookies (PHPSESSID, `*session*`, `sid`, `auth`, `token` ...), niet bij toestemmings- en analysecookies.
- Een cookiemuur op een ander domein (zoals myprivacy.dpgmedia.nl) telt als "onbekend" in plaats van "niet van toepassing", zodat de dekking eerlijk daalt.
- security.txt die doorverwijst naar een geldige security.txt van een andere organisatie (RFC 9116) is in orde.
- Domein zonder MX: advies "zet je domein dicht voor nepmail" in plaats van "leg vast wie mag mailen".
- Onder 80% dekking een zichtbare waarschuwing naast de score.
