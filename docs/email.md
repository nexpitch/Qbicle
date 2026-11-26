# E-mail via Brevo

Qbicle verstuurt drie soorten mail: inloglinks, uitnodigingen en domeinverificatie. Dat gaat via **Brevo** (EU), met de **Transactional Email API v3**:

```
POST https://api.brevo.com/v3/smtp/email
api-key: <BREVO_API_KEY>
```

De code staat in `packages/platform/src/brevo.ts`. Er wordt alleen platte tekst verstuurd, zonder bijlagen of tracking-pixels.

## Werking

| Situatie | Wat er gebeurt |
|---|---|
| `BREVO_API_KEY` gezet | Mail gaat via Brevo. `QBICLE_MAIL_FROM` is dan verplicht. |
| `BREVO_API_KEY` gezet en `QBICLE_MAIL_SANDBOX=aan` | Brevo neemt de mail aan maar bezorgt hem niet (header `X-Sib-Sandbox: drop`). Handig om de koppeling te testen. |
| Geen sleutel, lokaal | Mail verschijnt in de console. |
| Geen sleutel, `NODE_ENV=production` | De API weigert te starten. Anders zouden inloglinks in de serverlogs belanden. |

Bij een tijdelijke fout (HTTP 429, 5xx of een netwerkfout) probeert Qbicle het nog twee keer, met oplopende wachttijd. Een geweigerde mail (bijvoorbeeld een ongeldige sleutel, HTTP 401) wordt niet herhaald. Foutmeldingen bevatten alleen de HTTP-status en de foutcode van Brevo, nooit de sleutel.

## Sleutel lokaal instellen

1. Maak in Brevo een API-sleutel aan: **SMTP & API → API keys → Generate a new API key**. Dat is de API-sleutel (begint met `xkeysib-`), niet de SMTP-sleutel. Geef hem een herkenbare naam, bijvoorbeeld `qbicle-lokaal`, en maak later een aparte sleutel voor productie.
2. Kopieer `.env.example` naar `.env` in de hoofdmap van de repository en vul in:

   ```
   BREVO_API_KEY=xkeysib-...
   QBICLE_MAIL_FROM=noreply@<jouw afzenderdomein>
   QBICLE_MAIL_FROM_NAME=Qbicle
   QBICLE_MAIL_SANDBOX=aan
   ```

   `.env` staat in `.gitignore` en wordt dus nooit gecommit. Zet de sleutel nooit in code, in een chat, in een issue of in een pull request.
3. Start de API met `npm run api`. Die leest `.env` zelf. De opstartregel laat zien welke mailer actief is (`mail: Brevo (sandbox)`). Met Docker: `docker compose --profile api up api` neemt dezelfde variabelen uit `.env` over.
4. Werkt het in sandboxmodus, zet dan `QBICLE_MAIL_SANDBOX=` (leeg) en vraag een inloglink aan voor je eigen adres.

Is een sleutel per ongeluk gedeeld? Trek hem dan meteen in via **SMTP & API → API keys** en maak een nieuwe aan.

In productie komt de sleutel uit de secrets-opslag van de hostingpartij, niet uit een bestand.

## Afzenderdomein instellen in Brevo

Mail uit naam van een domein komt alleen goed aan als dat domein bewijst dat Brevo namens jou mag sturen. Dat zijn precies de dingen die de Qbicle-scanner bij klanten controleert, dus ons eigen domein moet het goede voorbeeld geven.

Advies: gebruik een apart subdomein voor transactionele mail, bijvoorbeeld `mail.<domein>` met afzender `noreply@mail.<domein>`. Problemen met de bezorging raken dan niet de gewone mail van het hoofddomein.

1. **Domein toevoegen:** **Senders, Domains & Dedicated IPs → Domains → Add a domain**. Brevo toont daarna de DNS-records die je bij je DNS-beheerder zet. Neem ze precies over.
2. **Eigendom:** een TXT-record met een `brevo-code`.
3. **DKIM:** de DKIM-records die Brevo geeft (CNAME- of TXT-records onder `._domainkey`). Daarmee ondertekent Brevo de mail namens jouw domein.
4. **SPF:** heeft het (sub)domein al een SPF-record, voeg dan het `include:` toe dat Brevo noemt, bijvoorbeeld `include:spf.brevo.com`. Er mag maar één SPF-record per naam zijn. Heeft het subdomein nog geen SPF-record, maak er dan één.
5. **DMARC:** zet een DMARC-record op `_dmarc.<domein>`. Begin met monitoren, bijvoorbeeld `v=DMARC1; p=none; rua=mailto:dmarc@<domein>`, en ga na een paar weken zonder problemen naar `p=quarantine` en daarna `p=reject`.
6. **Afzender:** voeg onder **Senders** het afzenderadres toe (bijvoorbeeld `noreply@mail.<domein>`) en zet hetzelfde adres in `QBICLE_MAIL_FROM`.
7. Klik in Brevo op **Authenticate** of **Verify** tot alle records groen zijn. DNS-wijzigingen kunnen tot een paar uur nodig hebben.

Tip: controleer daarna het domein met de eigen scanner: `npm run scan -- mail.<domein> --niveau 0` toont of SPF, DKIM en DMARC goed staan.

## Aandachtspunten

- **Kliktracking uit.** Laat Brevo geen links herschrijven in transactionele mail. Anders lopen inloglinks via een server van Brevo en kan de link breken. Controleer dit in de instellingen voor transactionele e-mail in Brevo.
- **Limieten van het abonnement.** Het aantal mails per dag hangt van het Brevo-abonnement af. Qbicle beperkt zelf al het aantal inloglinks en verificatiemails (zie `docs/accounts.md`).
- **Verwerkersovereenkomst.** Brevo verwerkt e-mailadressen van gebruikers. Leg de verwerkersovereenkomst met Brevo vast en noem Brevo in de privacyverklaring.
