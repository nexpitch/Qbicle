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
