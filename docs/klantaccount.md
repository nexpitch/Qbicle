# Klantaccount: gegevens, contactpersonen, gebruikers

Eén plek in de klantomgeving: **Account** (`/o/<organisatie>/account`).

| Onderdeel | Wie ziet het | Wie wijzigt |
|---|---|---|
| Naam in Qbicle | iedereen | eigenaar, beheerder |
| Factuurgegevens (naam op factuur, e-mail voor facturen, KvK, btw, adres, referentie) | eigenaar, beheerder | eigenaar |
| Contactpersonen (algemeen, financieel, technisch, urgent lek) | iedereen | eigenaar, beheerder |
| Gebruikers en rollen, uitnodigingen | iedereen (uitnodigingen: beheerder+) | eigenaar, beheerder (eigenaren alleen door een eigenaar) |

- Contactpersonen zijn geen gebruikers: ze loggen niet in. Eén per soort, met e-mail of telefoon (tabel `org_contact`, migratie 0012).
- De referentie (inkoopordernummer of kenmerk) komt op elke nieuwe factuur. Facturen zijn een momentopname: wijzigen geldt alleen voor nieuwe facturen.
- Het pakket begrenst het aantal gebruikers (leden plus openstaande uitnodigingen), zie `limieten.gebruikers` in `config/abonnementen.json`. Zonder abonnement geldt geen grens.
- De link in de uitnodigingsmail (`/uitnodiging#token=…`) werkt nu in de web-app; wie nog niet is ingelogd, logt eerst in en gaat daarna automatisch verder.

API: `GET /api/v1/organisaties/:org/contactpersonen`, `PUT|DELETE /api/v1/organisaties/:org/contactpersonen/:soort`.

## Abonnement en betalen (`/o/<organisatie>/abonnement`)

- **Je pakket**: status, prijs, betaald tot, volgende betaling (bedrag incl./excl. btw, datum, hoe), gebruik van gebruikers en domeinen.
- **Pakket wijzigen** via een bevestigingspagina (`/abonnement/wijzigen?pakket=…&interval=…`) die vooraf zegt wat het kost en wanneer het ingaat. Afspraak (Erik, 27-11-2026):
  - tijdens de proef of zonder betaalde periode: meteen, zonder bijbetaling;
  - upgrade tijdens een betaalde periode: meteen, na een bijbetaling naar rato voor de resterende dagen (`payment.plan_change`; het pakket verandert pas als die betaald is);
  - downgrade of andere betaaltermijn: gaat in bij de volgende periode (`subscription.pending_plan` / `pending_interval`), terug te draaien tot die datum.
- **Let op voor de incassobatch (cockpit):** roep `applyScheduledChange(p, q, subscriptionId, periodeStart)` aan voordat je een verlenging klaarzet, anders wordt het oude pakket geïncasseerd.
- **Opzeggen** (`/abonnement/opzeggen`) met uitleg wat er gebeurt en een reden (`subscription.cancel_reason`, `cancel_feedback`); opzegging intrekken kan tot de einddatum.
- **Opzegtermijn en stilzwijgende verlenging** (`opzegtermijnMaanden` in `config/abonnementen.json`, nu 1). Maand- en jaarcontracten verlengen automatisch met dezelfde termijn, tenzij de klant uiterlijk één opzegtermijn vóór het einde van de periode opzegt. Te laat opgezegd: het contract verlengt nog één keer (een maand of een jaar) en die laatste periode wordt nog geïncasseerd. De pagina toont vooraf "Je contract verlengt op … tenzij je uiterlijk op … opzegt" en na opzeggen "Opgezegd, eindigt op …".
  - Datamodel: `subscription.ends_at` is de einddatum (exclusief). `cancel_at_period_end = true` betekent "de huidige periode is de laatste"; status `opgezegd` met `cancel_at_period_end = false` betekent dat er nog één verlenging betaald moet worden. Na die betaling zet `syncPayment` `cancel_at_period_end` op true.
  - Incasso en betalen: gebruik `needsRenewal(sub)` om te bepalen of er een volgende periode geïncasseerd moet worden (ook in de incassobatch van de cockpit). `contractEnd()` rekent de einddatum uit.
  - Juridisch: de algemene voorwaarden moeten deze regel bevatten (B2B, stilzwijgende verlenging). Laat een jurist dit nakijken.
- **Betaalwijze**: incasso (standaard) met de machtiging uit de eerste geslaagde betaling (`payment_mandate`, alleen laatste 4 tekens van de rekening), intrekken kan. Op factuur betalen stelt alleen Qbicle in (cockpit); de klant kan het aanvragen en dat komt als notitie (`org_note`, bron `systeem`) bij de klant in de cockpit.
- Migratie 0014.

## Facturen (`/o/<organisatie>/facturen`)

- Alle betalingen met factuurnummer, status in gewone taal (betaald, wacht op betaling, mislukt, niet betaald, (deels) terugbetaald), zoeken op nummer of omschrijving, filter op status en jaar, totaal excl./incl. btw.
- **Pdf** per factuur (`/facturen/<id>/pdf`, zonder externe bibliotheek) en een **csv** voor de boekhouding (`/facturen/export.csv`).
- **Mislukte betaling**: melding bovenaan Facturen en Abonnement met een knop **Nu betalen**; dat maakt een nieuwe betaling voor precies hetzelfde (`retryPayment`). Een herinneringsmail stuurt nog niemand automatisch: bij mislukte incasso's bereidt de cockpit een conceptmail voor die een medewerker verstuurt.
- Facturen versturen per e-mail naar het factuuradres zit er nog niet in (volgt met de Mollie-koppeling).

## Add-on extra domeinen

- Elk domein boven de limiet van het pakket kost `extraDomeinPerMaand` (config/abonnementen.json, nu €5) per maand excl. btw (keuze Erik 27-11-2026).
- Het aantal telt op het moment dat een verlenging klaargezet wordt; halverwege een periode bijtellen doen we niet. Bij jaarbetaling: 12 maanden per extra domein.
- Het komt als aparte regel op betaling en factuur (`payment.lines`, migratie 0020). De abonnementspagina en de voorbeeldpagina bij een pakketwissel rekenen het mee.
- **Voor de incassobatch (cockpit):** gebruik dezelfde regels, anders wordt de add-on niet geïncasseerd.
