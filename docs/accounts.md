# Klant- en gebruikersbeheer

Dit deel regelt wie er bij Qbicle kan, wat iemand mag zien en doen, en welke domeinen een organisatie mag laten scannen. De logica staat in `packages/platform`, de HTTP-laag in `apps/api`.

## Organisaties en rollen

Alles hangt aan een **organisatie**. Er zijn drie soorten: `klant`, `it-partner` en `adviseur`. Een gebruiker kan lid zijn van meerdere organisaties, met per organisatie één rol:

| Rol | Mag |
|---|---|
| eigenaar | alles, ook IT-partners toelaten en eigenaren benoemen |
| beheerder | domeinen, verificatie, scans, bevindingen accepteren, delen, collega's uitnodigen (tot beheerder), audit-log lezen |
| lezer | alleen kijken: organisatie, leden, domeinen, bevindingen |

Vaste regels:

- Je kunt niemand een hogere rol geven dan je zelf hebt. Alleen een eigenaar benoemt eigenaren.
- Er is altijd minstens één eigenaar; de laatste eigenaar kan niet weg of omlaag.
- Zonder toegang krijg je "niet gevonden", niet "geen toegang". Zo kun je niet raden welke organisaties of domeinen bestaan.
- Alle rechten staan in `packages/platform/src/roles.ts`; elke actie gaat via `authorize()`.

## IT-partners met meerdere klanten

Een IT-partner (MSP) of adviseur krijgt toegang tot een klant via een **partnerkoppeling** met niveau `beheerder` of `lezer`. Een medewerker van de partner krijgt bij die klant het laagste van zijn rol bij de partner en het niveau van de koppeling. Een lezer bij de partner blijft dus overal lezer.

Twee manieren om te koppelen:

1. **Partner maakt de klant aan.** De klant heeft nog geen account. De partner krijgt beheerderstoegang en mag de eerste eigenaar van de klant uitnodigen (en alleen die eerste).
2. **Bestaande klant laat een partner toe.** De eigenaar van de klant vult de partner-ID in die de partner doorgeeft.

Via een partner kun je nooit andere partners toelaten of zelf klanten aanmaken onder de klant (geen doorschakeling). De eigenaar van de klant kan de koppeling altijd intrekken; de partner kan zelf ook stoppen.

## Inloggen

Zonder wachtwoord, met een eenmalige link per e-mail:

- Link 15 minuten geldig, één keer te gebruiken, alleen als SHA-256-hash opgeslagen.
- Het token staat achter `#` in de link, zodat het niet in serverlogs of Referer-headers komt. De pagina stuurt het met een POST door, dus een virusscanner die links voorproeft verbruikt het niet.
- Hetzelfde antwoord voor bekende en onbekende adressen. Bij de eerste keer inloggen wordt het account aangemaakt.
- Sessie in een cookie `__Host-qbicle_sessie` (HttpOnly, Secure, SameSite=Lax). Vervalt na 7 dagen zonder gebruik en hoe dan ook na 30 dagen. Uitloggen en "overal uitloggen" trekken sessies in.
- Wijzigende aanvragen moeten JSON zijn en vanaf de eigen app komen (Origin-controle tegen CSRF).

Tokens zijn 32 bytes uit `crypto.randomBytes`, met een herkenbaar voorvoegsel (`qbl_`, `qbs_`, `qbu_`, `qbd_`) zodat secret scanning ze kan vinden. Er is geen eigen cryptografie.

## Uitnodigingen

Een eigenaar of beheerder nodigt iemand uit per e-mailadres en rol. De link is 7 dagen geldig en werkt alleen voor wie inlogt met hetzelfde e-mailadres; een doorgestuurde link helpt een ander dus niet. Een nieuwe uitnodiging vervangt de oude; intrekken kan.

## Domeinverificatie

Een organisatie moet aantonen dat een domein van haar is voordat Qbicle het vanuit het account scant en details toont.

**DNS-TXT (aanbevolen)**

```
_qbicle-verificatie.voorbeeld.nl.  TXT  "qbicle-verificatie=<code>"
```

Het record mag ook direct op `voorbeeld.nl` staan. De code is per organisatie en domein uniek, dus de code van een andere organisatie werkt niet. Een DNS-fout telt nooit als geslaagd. Qbicle controleert dagelijks opnieuw (`reverifyDomains`, voor de worker); is het record 30 dagen lang niet meer gevonden, dan vervalt de verificatie.

**E-mail naar een beheeradres** op het domein: `admin@`, `administrator@`, `webmaster@`, `hostmaster@` of `postmaster@`, zoals certificaatautoriteiten dat ook doen. Een willekeurig adres zoals `info@` of het eigen adres van de gebruiker telt bewust niet. De link is 24 uur geldig en werkt zonder account. Een e-mailverificatie vervalt na een jaar.

Verificatie van `voorbeeld.nl` dekt ook subdomeinen. Een scan aanvragen kan alleen voor een geverifieerd domein dat niet op de opt-outlijst staat.

## Audit-log

Inloggen, uitloggen, rolwijzigingen, uitnodigingen, partnerkoppelingen, domeinen, verificaties en scanverzoeken komen in `audit_log`, met wie, wanneer en vanaf welk IP. De tabel is alleen-toevoegen: een databasetrigger blokkeert UPDATE, DELETE en TRUNCATE. Opschonen na de bewaartermijn kan alleen bewust, met `SET qbicle.audit_onderhoud = 'aan'`. Beheerders en eigenaren lezen het log van hun eigen organisatie.

## Misbruiklimieten

Voorlopige limieten (in `ratelimit.ts`, bijstellen na de pilot): 5 inloglinks per adres per uur, 20 per IP per uur, 10 DNS-controles per domein per uur, 5 verificatiemails per domein per dag, 6 scans per domein per dag, 20 nieuwe domeinen en 50 uitnodigingen per organisatie per dag. Sleutels worden gehasht opgeslagen.

## API

JSON onder `/api/v1`. Fouten hebben de vorm `{ "fout": "<code>", "bericht": "<Nederlandse uitleg>" }`.

| Methode en pad | Wat |
|---|---|
| `POST /auth/inloglink` `{email}` | inloglink mailen |
| `POST /auth/inloggen` `{token}` | link inwisselen, zet sessiecookie |
| `POST /auth/uitloggen`, `POST /auth/overal-uitloggen` | sessie(s) intrekken |
| `GET /ik` | gebruiker en alle organisaties (eigen en via partner) |
| `POST /organisaties` `{name, kind}` | organisatie aanmaken, jij wordt eigenaar |
| `GET`, `PATCH /organisaties/:org` | bekijken, naam wijzigen |
| `GET /organisaties/:org/leden`, `PATCH`/`DELETE …/leden/:user` | leden, rol wijzigen, verwijderen |
| `GET`/`POST /organisaties/:org/uitnodigingen`, `DELETE …/:inv` | uitnodigen, intrekken |
| `POST /uitnodigingen/accepteren` `{token}` | uitnodiging accepteren |
| `GET`/`POST /organisaties/:org/klanten` | klantenlijst en klant aanmaken (partner) |
| `GET`/`POST /organisaties/:org/partners`, `DELETE …/:partner` | partners van een klant |
| `GET`/`POST /organisaties/:org/domeinen`, `GET`/`DELETE …/:dom` | domeinen |
| `POST …/domeinen/:dom/verificatie/dns` | TXT-record controleren |
| `POST …/domeinen/:dom/verificatie/email` `{address}` | verificatiemail sturen |
| `POST /domeinverificatie/bevestigen` `{token}` | link uit de verificatiemail (zonder inloggen) |
| `POST …/domeinen/:dom/scans` | scan in de wachtrij (alleen geverifieerd) |
| `GET /organisaties/:org/audit?voor=&aantal=` | audit-log |

Lokaal starten:

```bash
docker compose up -d db && docker compose run --rm migrate
DATABASE_URL=postgres://qbicle:qbicle@localhost:5432/qbicle QBICLE_SECURE_COOKIES=uit npm run api
# of alles in Docker:
docker compose --profile api up api
```

E-mail gaat via Brevo als `BREVO_API_KEY` is gezet, anders naar de console. Zie [email.md](email.md).

## Tests

De tests in `packages/platform/test` en `apps/api/test` draaien tegen een echte PostgreSQL: elk testbestand krijgt een eigen verse database. Zonder `DATABASE_URL` worden ze overgeslagen; in CI staat `QBICLE_REQUIRE_DB=1`, zodat ze daar nooit stilletjes wegvallen.

```bash
DATABASE_URL=postgres://qbicle:qbicle@localhost:5432/qbicle npm test
```
