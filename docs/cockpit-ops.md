# Cockpit: gebruik, gezondheid, support en agents

De cockpit is het interne beheerdashboard van Qbicle. Dit deel (`packages/ops`)
levert de technische en support-kant. De shell, klanten, abonnementen en incasso
zitten in `apps/cockpit` (aparte PR).

## Gebruiksmeting

| Wat | Waar vastgelegd |
| --- | --- |
| Scans (gelukt/mislukt) | tabel `scan` (bestond al) |
| Assets en domeinen | tabellen `asset`, `domain` |
| API-aanroepen per klant, per route | `usage_daily` (metric `api`), automatisch in `apps/api` |
| AI-aanroepen, tokens en kosten per klant en functie | `ai_call` (per aanroep) + `usage_daily` (metric `ai`) |
| Verstuurde mails | `mail_event` + `usage_daily` (metric `mail`) |

Elke AI-aanroep gaat via `meteredAiCall()`:

```ts
const antwoord = await meteredAiCall(ctx, { organizationId, feature: 'samenvatting', model: 'claude-opus-5-5' },
  () => client.messages.create({ model: 'claude-opus-5-5', max_tokens: 16000, messages }));
```

Die controleert eerst het maandbudget van de klant (weigert boven de limiet),
voert de aanroep uit en legt tokens, kosten, duur en uitkomst vast, ook bij een
fout. De prompt en het antwoord worden nooit opgeslagen.

Limieten per pakket, AI-prijzen en drempels staan in `config/gebruik.json`.
Afwijkende limiet voor één klant: tabel `usage_limit_override`, alleen te zetten
via een goedgekeurd voorstel `limiet.aanpassen`.

Marge per klant = maandbedrag van het abonnement min geschatte kosten (AI +
scans + mail) over dezelfde periode (`usageOverview`).

## Technische gezondheid

- Scanjobs: wachtrij, bezig, vast (langer dan `scanVastNaMinuten` bezig), mislukt, gemiddelde duur (`scanHealth`, `listScanJobs`).
- Fouten: `recordError()` groepeert gelijke fouten (ids en getallen eruit) en telt op (`system_error`).
- Mail: `LoggingMailer` om de bestaande mailer heen; `applyBrevoEvent()` verwerkt Brevo-webhooks (afgeleverd, bounce, spam). Koppeling van de webhook-URL volgt met de cockpitpagina.
- `healthSummary()` geeft één oordeel: goed, aandacht of storing, met redenen.

## Support

Klein ticketmodel: `support_ticket` + `support_message` (met interne notities).
Een ticket koppelt zichzelf via het mailadres aan de klant. `ticketContext()`
geeft in één keer: account, abonnement, leden, domeinen, laatste scans, open
bevindingen, fouten, mails aan die klant, gebruik en limieten, betalingen en
eerdere tickets.

## Agents: veilig samenwerken

Uitgangspunt: agents doen het beheer en de bewaking, mensen beslissen over alles
met gevolgen voor klanten of geld.

1. **Een agent kan alleen lezen en voorstellen.** Hij kan niet goedkeuren; dat kan
   alleen een ingelogde medewerker (cockpit met MFA).
2. **Vaste soorten voorstellen.** Elke soort (`registerProposalKind`) heeft eigen
   validatie en uitvoering in code. Een agent kan geen nieuwe acties verzinnen.
3. **Impact bepaalt wie beslist.**
   - `geen` (intern, omkeerbaar): mag automatisch, bijv. `scan.opnieuw`, `ticket.melding`.
   - `klant` (mail aan klant): rol support of beheerder.
   - `financieel` (limieten, incasso): rol financieel of beheerder.
   De database staat automatisch goedkeuren alleen toe bij impact `geen`.
4. **Bevroren inhoud.** Na aanmaken kan de inhoud niet meer veranderen (trigger +
   sha256-controle bij uitvoeren). Uitgevoerd wordt precies wat is goedgekeurd,
   precies één keer. Een voorstel verloopt na 7 dagen.
5. **Eén knop.** Goedkeuren voert standaard direct uit (`decideProposal`).
6. **Noodrem.** Een beheerder pauzeert een agent; die kan dan niets meer voorstellen.
   Per agent een maximum aan openstaande voorstellen.
7. **Alles in het audit-log**, met actor `agent:<sleutel>` of de medewerker.
   Voorstellen worden nooit verwijderd. Een afgewezen voorstel komt niet elke ronde terug.

Standaardsoorten: `scan.opnieuw`, `ticket.melding`, `ticket.antwoord`,
`klant.bericht` (alleen naar eigenaren van die klant, nooit een vrij adres),
`limiet.aanpassen`. Andere modules registreren hun eigen soort, bijv.
`incasso.batch` met `ref_id` naar de incassorun.

### De Bewaker

`ops-bewaker` draait regelgebaseerd (zonder AI) en doet per ronde:

- vastgelopen scans opnieuw in de wachtrij (max 3 pogingen), daarna een interne melding;
- afwijkend gebruik (vandaag meer dan 3x het gemiddelde) als interne melding;
- klant nadert of zit over een limiet: voorstel om de eigenaar te mailen (mens keurt goed);
- fouten die 10 keer of vaker voorkwamen: interne melding;
- verlopen voorstellen opruimen.

Lokaal één ronde draaien:

```bash
docker compose run --rm migrate
docker compose run --rm bewaker
```

## In de cockpit

Vier schermen onder "Techniek en support" (`apps/cockpit/src/modules/`):

- **Gebruik**: kosten, tokens, scans en API per klant, marge, AI per functie, signalen. Per klant de limieten met balk; financieel/beheerder kan een limiet aanpassen.
- **Gezondheid**: één oordeel bovenaan, scanjobs (vast/mislukt, opnieuw starten), fouten (opgelost markeren) en mailbezorging.
- **Support**: tickets met filters; per ticket het gesprek, antwoorden (mailt de klant) of interne notitie, en rechts alle klantcontext.
- **Agents**: de wachtrij met voorstellen (goedkeuren en uitvoeren of afwijzen), de agents met noodrem, geschiedenis en activiteit.

Starten zoals de cockpit zelf: `bash scripts/cockpit.sh` en dan `http://localhost:3100`.
