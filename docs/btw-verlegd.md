# Btw verlegd voor EU-klanten buiten Nederland

Besluit Erik (27-11-2026): een zakelijke klant met een factuuradres in een ander EU-land en een
btw-nummer dat **VIES** (de btw-nummercheck van de EU) als geldig bevestigt, betaalt **0% btw,
"btw verlegd"**. Nederland en landen buiten de EU: gewoon 21%.

## Regels

| Situatie | Btw |
|---|---|
| Land NL (met of zonder btw-nummer) | 21% |
| Land buiten de EU (bijv. GB, CH, US) | 21% |
| EU buiten NL, geen btw-nummer | 21% |
| EU buiten NL, VIES zegt ongeldig | 21% |
| EU buiten NL, VIES in storing en geen recente geldige controle | 21% |
| EU buiten NL, geldige VIES-controle van max. 31 dagen oud | **0%, btw verlegd** |

Nooit stilzwijgend 0%: zonder geldige, recente controle rekenen we btw. De klant kan op
**Account → Bedrijfsgegevens → Opnieuw controleren bij VIES** het later nog eens proberen; de
cockpit heeft dezelfde knop bij de klant.

## Wanneer controleren we?

* Bij het invullen of wijzigen van land of btw-nummer (registratie en bedrijfsgegevens).
* Vóór elke betaling (afrekenen, upgrade naar rato, Qbicle Audit, opnieuw betalen) als de laatste
  uitslag ouder is dan 31 dagen (`vatCheckMaxDays`).
* Bij **elke verlenging**: het klaarzetten van de incassobatch vraagt VIES opnieuw (max. 1 keer per dag).
* Wordt een nummer ongeldig (of is VIES te lang niet bereikbaar), dan stopt verleggen: nieuwe
  betalingen met 21%, een systeemnotitie bij de klant en de melding **Btw verlegd gestopt** op het
  overzicht van de cockpit.

## Bewijs

Elke controle staat in `vat_check` (onwijzigbaar): nummer, land, uitslag, tijdstip, het
**consultatienummer** (`request_identifier`) van VIES en naam/adres zoals VIES ze geeft. VIES geeft
een consultatienummer alleen als Qbicle zijn eigen btw-nummer meestuurt: zet `QBICLE_BTW_NUMMER`
zodra de BV er is.

Per betaling, incassoregel en factuur staan los opgeslagen: `vat_code` (`nl_standaard` of
`eu_verlegd`), `vat_rate` en `vat_check_id`. De factuur neemt de btw over van de betaling (wat de
klant betaald heeft) en vermeldt bij verlegging "Btw verlegd / reverse charge (art. 196
Btw-richtlijn)" met de btw-nummers van klant en Qbicle.

## Instellingen

* `QBICLE_VIES` leeg = echte VIES-dienst; `test` = nep-VIES zonder netwerk (nummers met `000000`
  zijn ongeldig, met `999999` is VIES "in storing", de rest geldig).
* `QBICLE_BTW_NUMMER` = btw-nummer van Qbicle (na oprichting BV).

## Aandachtspunten voor boekhouder en jurist

* **OSS** (digitale diensten aan particulieren in andere EU-landen) valt hierbuiten. Qbicle verkoopt
  alleen zakelijk; een buitenlandse klant zonder btw-nummer betaalt nu 21% NL-btw. Laten toetsen
  of dat zo mag blijven of dat OSS nodig is.
* Verlegde omzet moet in de **opgaaf intracommunautaire prestaties (ICP)** en in de btw-aangifte
  (rubriek 3b). Exporteer daarvoor betalingen met `vat_code = 'eu_verlegd'`.
* Een echte factuur met verlegging vereist het btw-nummer van Qbicle; tot de BV er is, blijven het
  testfacturen.
* Creditnota's bestaan nog niet; als ze komen, nemen ze `vat_code` en `vat_rate` over van de
  oorspronkelijke factuur.
* Mollie/boekhouding later: gebruik de opgeslagen `vat_code` per betaling/factuur als btw-code.
