# Registreren, abonnementen en betalen

De klantomgeving staat in `apps/web` (Licht-stijl, server-side gerenderd). De API draait in hetzelfde proces onder `/api/v1`, dus app en API delen één adres, één sessiecookie en één CSRF-controle.

## Lokaal proberen

```
docker compose up -d db
docker compose --profile tools run --rm migrate
bash scripts/klantomgeving.sh
```

Open http://localhost:3000. Zonder Brevo-sleutel staat de inloglink in het venster waarin de app draait (zoek op `inloggen/bevestigen`).

## Prijzen wijzigen

Alle pakketten en prijzen staan in **`config/abonnementen.json`** (euro's per maand, excl. btw). De open keuze voor de ankerprijs van MKB (€49 of €39) is daar één regel: `perMaandBijJaar` en `perMaandBijMaand` bij `mkb`. Na een wijziging de app herstarten. Een lopend abonnement krijgt de nieuwe prijs bij de volgende betaling.

| Product | Pakket | Prijs (voorstel businessplan) |
|---|---|---|
| MKB | Qbicle MKB | €49 p/m bij jaarbetaling, €59 bij maandbetaling, tot 3 domeinen |
| Corporate | Qbicle Business | €149 p/m bij jaarbetaling, €179 bij maandbetaling, tot 10 domeinen, inclusief infra-inventaris |
| Qbicle Audit | Quick Scan | €1.250 per overname (online te bestellen) |
| Qbicle Audit | Deal Scan, Plus | vanaf €4.500 en €12.500, voorlopig op aanvraag |

## Hoe het werkt

1. **Registreren** (`/aanmelden`): pakket en betaalinterval kiezen, e-mailadres en bedrijfsnaam. Er komt een inloglink; pas bij het eerste inloggen maakt Qbicle de organisatie aan (gebruiker wordt eigenaar) en start de proef van 14 dagen, zonder betaalgegevens.
2. **Betalen**: de eigenaar kan tijdens de proef al betalen; de betaalde periode begint pas als de proef afloopt. Jaarbetaling rekent 12 maanden vooruit.
3. **Factuur**: bij een geslaagde betaling komt er automatisch een factuur (`QB-jaar-nummer`) met een momentopname van de factuurgegevens. Facturen zijn in de database onwijzigbaar. Testbetalingen krijgen een eigen reeks (`TEST-jaar-nummer`, kolom `invoice.test`), zodat de echte reeks bij de start met Mollie schoon begint. Testmachtigingen staan met provider `nep` in `payment_mandate`; bij de overstap naar Mollie mogen alleen Mollie-machtigingen meetellen (reviewpunt I7, vóór Mollie).
4. **Opzeggen**: een proef stopt direct; een betaald abonnement loopt door tot het einde van de periode, mits uiterlijk 1 maand (opzegtermijn) vóór dat einde opgezegd. Anders verlengt het nog één keer met een maand of een jaar. Een tweede proef is er niet.
5. **Qbicle Audit**: eenmalige opdracht per doelonderneming (naam en domeinen), direct betalen.

Rechten: alleen de **eigenaar** betaalt, wijzigt het pakket of zegt op. Een beheerder ziet abonnement en facturen. Via een IT-partner kan niemand betalen of opzeggen.

## Betaalprovider

Qbicle praat alleen met de interface `PaymentProvider` (`packages/platform/src/payments.ts`). Nu is dat de **testbetaling** (`QBICLE_BETAALPROVIDER=nep`): de "betaalpagina" is `/betalen/test/<id>` met de knoppen Betaling geslaagd en mislukt. Er gaat geen geld over. In productie staat dit uit, tenzij `QBICLE_NEPBETALING=aan` (alleen voor de gesloten bèta).

**Mollie** komt erbij zodra de BV er is: een `MollieProvider` met dezelfde twee functies (betaling aanmaken, status opvragen) en een webhook op `/api/v1/betalingen/webhook`. Qbicle vertrouwt nooit op wat de browser zegt over een betaling: de status wordt altijd bij de provider opgevraagd, en verwerken is idempotent (webhook én terugkomen geeft één factuur).

## Nog niet in deze stap

- Mollie-koppeling en automatische verlenging (incasso) – na de BV.
- Gegevens van Qbicle als leverancier op de factuur (KvK, btw-nummer, adres) – na de BV.
- Btw verlegd voor zakelijke klanten in andere EU-landen.
- Pakketlimieten afdwingen (aantal domeinen en gebruikers); `planLimits()` staat klaar.
