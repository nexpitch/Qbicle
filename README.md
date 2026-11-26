# Qbicle Light

Qbicle laat MKB-bedrijven in één overzicht zien hoe veilig en actueel hun internetgerichte systemen zijn, en hoe urgent het is om iets op te pakken. Qbicle Light is de eerste versie: domein invullen, een urgentiescore van 0 tot 100, en maximaal drie acties in gewone taal die je kunt doorsturen naar je IT-partner.

Deze repository bevat de code voor het platform. Het technisch ontwerp is leidend voor keuzes en bouwvolgorde.

## Status

| Onderdeel | Status |
|---|---|
| Passieve scanner (DNS, SPF, DKIM, DMARC, DNSSEC, CAA, certificaat, https, security headers, cookies, softwareversies, security.txt) | Werkt, met tests en opdrachtregel |
| Scoremodel (urgentie, banden, dekking, top 3 acties) | Werkt, gewichten voorlopig |
| Datamodel PostgreSQL | Eerste migratie |
| CI (typecheck, tests, migraties, Docker-image) | GitHub Actions |
| Docker (scanner-image, PostgreSQL, migraties) | Voor lokaal en later EU-hosting |
| Klant- en gebruikersbeheer: organisaties, IT-partners met meerdere klanten, rollen, inloggen met e-maillink, uitnodigingen, domeinverificatie, audit-log | Werkt, met tests tegen PostgreSQL |
| Basis-API (`/api/v1`, JSON) | Werkt, zie [docs/accounts.md](docs/accounts.md) |
| Web-app (Next.js) | Volgende fase |
| CT-logs, RDAP, subdomeinen | Volgende fase |
| Kwetsbaarheidsbronnen (CVE, NVD, KEV, EPSS, EUVD, NCSC, DTC) | Fase 4 |

## Wat de scanner wel en niet doet

De scanner leest alleen openbare informatie en doet hooguit wat een gewone bezoeker doet.

- **Niveau 0, alleen derden:** DNS-records en een validerende DNS-resolver. Geen enkel verzoek naar de systemen van het domein zelf.
- **Niveau 1, gewoon bezoek:** één TLS-verbinding op poort 443, de homepage via http en https (met redirects zoals een browser), en `/.well-known/security.txt`.
- **Niet:** poortscans, versie-probes, inlogpogingen of kwetsbaarheidstests. Die zitten bewust niet in deze code.

Verdere spelregels: vaste User-Agent met uitleglink, time-outs van 5 seconden, een opt-outlijst, geen verbindingen met interne of gereserveerde IP-adressen (ook niet na een redirect of DNS-wijziging), en redirects naar andere domeinen worden niet gevolgd. Zie [docs/scanner.md](docs/scanner.md).

## Aan de slag

Vereist: Node.js 22 of nieuwer. Voor de database: Docker (of een eigen PostgreSQL 16).

```bash
npm install
npm test               # alle tests
npm run typecheck      # TypeScript-controle

# Een domein scannen (alleen domeinen waarvoor je dat mag)
npm run scan -- voorbeeld.nl
npm run scan -- voorbeeld.nl --json       # volledig rapport met bewijs
npm run scan -- voorbeeld.nl --niveau 0   # alleen DNS, geen verbinding met de site

# Database lokaal
docker compose up -d db
DATABASE_URL=postgres://qbicle:qbicle@localhost:5432/qbicle npm run db:migrate

# API lokaal (mail verschijnt in de console)
DATABASE_URL=postgres://qbicle:qbicle@localhost:5432/qbicle QBICLE_SECURE_COOKIES=uit npm run api

# Ook de databasetests draaien
DATABASE_URL=postgres://qbicle:qbicle@localhost:5432/qbicle npm test
```

Instellingen staan in [.env.example](.env.example).

### Met Docker (zonder Node.js op je laptop)

```bash
docker compose up -d db                              # PostgreSQL 16
docker compose run --rm migrate                      # migraties toepassen
docker compose run --rm scanner voorbeeld.nl         # één domein scannen

# Testset (toets fase 1): zet ~20 domeinen in testset/testset.txt
cp testset/testset.voorbeeld.txt testset/testset.txt
docker compose run --rm scanner --bestand /data/testset.txt --uit /data/resultaten
```

De resultaten komen in `testset/resultaten/`: per domein een JSON-rapport en een `overzicht.csv` om naast het oordeel van een specialist te leggen. Zonder Docker kan hetzelfde met `npm run scan -- --bestand testset/testset.txt --uit testset/resultaten`.

## Projectstructuur

```
packages/
  scanner/          passieve checks, runner, opdrachtregel
    src/checks/     één bestand per groep checks (spf, dmarc, dkim, dns, tls, web)
    src/net.ts      alle netwerktoegang, achter één interface (in tests vervangen)
    src/scan.ts     voert checks uit, bewaakt de regel "een fout is nooit in orde"
    test/           tests met een nep-netwerk; draaien zonder internet
  score/            scoremodel: gewichten, factoren, banden, acties in gewone taal
  platform/         accounts, organisaties, rollen, IT-partners, domeinverificatie, audit-log
apps/
  api/              HTTP-API (Hono), los te draaien of later achter Next.js
db/migrations/      SQL-migraties voor PostgreSQL
scripts/            hulpscripts (migraties)
docs/               uitleg over scanner en scoremodel
```

Later komen hier `apps/web` (Next.js: website en app) en `apps/worker` (scan-worker met pg-boss) bij.

## Scoremodel in het kort

Per open bevinding telt `b × m × z × k` mee: basisgewicht, misbruikfactor (CISA KEV, EPSS, NCSC, DTC), zichtbaarheid van het asset en zekerheid. De som wordt afgevlakt tot `100 × (1 − e^(−som/60))`.

- **Banden:** 0–24 Weinig urgent, 25–49 Aandacht nodig, 50–74 Hoge urgentie, 75+ Direct oppakken. Een bevinding met een KEV-kwetsbaarheid zet de band minimaal op Hoge urgentie.
- **Dekking** staat apart: afgeronde checks gedeeld door toepasselijke checks. "Onbekend" telt nooit als "in orde"; het verlaagt de dekking, niet de score.
- **Acties:** bevindingen worden per actie gegroepeerd, het rapport toont er maximaal drie.
- **Versie:** gewichten staan in `packages/score/src/model.ts` met een `MODEL_VERSION`. Gewichten die niet in het ontwerp stonden zijn als `voorlopig` gemarkeerd en worden in de pilot gekalibreerd.

Zie [docs/scoremodel.md](docs/scoremodel.md).

## Werkwijze

- Werk op een branch en open een pull request; niet rechtstreeks naar `main`.
- Taal van product, teksten en documentatie: Nederlands. Code en identifiers mogen Engels zijn.
- Nieuwe check: één bestand in `src/checks`, een gewicht en actie in het scoremodel, en tests. De test `elke bevindingssleutel in de checks heeft een gewicht` bewaakt dat.
