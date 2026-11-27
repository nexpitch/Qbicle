# Klantdashboard

De hoofdpagina van een organisatie (`/o/<org>/overzicht`). Opbouw, van boven naar beneden:

1. **Volgende stap**: één concrete actie (domein toevoegen, bevestigen, of de zwaarste open actie).
2. **Kerncijfers**: urgentie 0–100 met band en verschil met 30 dagen geleden, open acties, assets in beeld, opgelost in 30 dagen.
3. **Direct aandacht**: de acties met niveau urgent of aandacht (hooguit 5), urgente assets en meldingen. De overige acties staan ingeklapt onder "voor later".
4. **Alles in beeld**: één uitklapbare sectie per soort (domeinen, websites, mail, servers, cloud, netwerk, apparaten) plus extra secties
   zoals Koppelingen. Elke kop toont teller en status; de inhoud is standaard ingeklapt. Ook zonder data staan alle secties er, met
   "nog niet gescand" en wanneer de scan komt (`scanPlan`: laatste geslaagde scan + 7 dagen, gelijk aan de planner).
   Extra secties levert de route aan als `DashSection` (zie `koppelingenSectie`), zodat bijvoorbeeld het systeemregister er los bij kan.
5. **Urgentie over tijd**, **Sinds vorige maand** (opgelost en nieuw) en **Activiteit**.

Daarnaast: `/o/<org>/assets` (alle assets, filter per soort), `/o/<org>/assets/<id>` (bevindingen met zekerheid,
wat te doen, CVE's en bronnen) en `/o/<org>/domeinen` (toevoegen en bevestigen via DNS of admin@/postmaster@).

## Hoe de cijfers ontstaan

- De urgentie wordt live berekend met `@qbicle/score` over de open, niet-geaccepteerde bevindingen van actieve assets.
  Een geaccepteerde of opgeloste bevinding telt dus direct niet meer mee.
- De trend wordt teruggerekend uit de geschiedenis van bevindingen (`first_seen`, `resolved_at`, `accepted_at`),
  met hetzelfde model. Zo is de trend altijd consistent met de huidige score.
- De dekking komt uit de checks (`check_run`) van de laatste afgeronde scan per domein.
- Bronnen per bevinding staan in `finding.sources` (migratie 0013); NVD-, EUVD- en CISA KEV-links worden
  automatisch toegevoegd voor gekoppelde CVE's. Alleen https-links worden getoond.
- Compliance (cookies, toegankelijkheid) telt bewust niet mee in de urgentie en krijgt een eigen overzicht.

## Voorbeelddata

Echte cijfers komen van de scan-worker (zie [scan-worker.md](scan-worker.md)): na het bevestigen van een domein start
binnen een minuut de eerste scan. Om zonder domein te kijken: met `QBICLE_DEMODATA=aan` (staat aan in
`docker compose --profile web`, nooit in productie) toont het lege dashboard de knop **Vul met voorbeelddata**.
Die maakt een voorbeeldbedrijf op `voorbeeldbedrijf.example` met 15 assets en 12 weken geschiedenis.
Opnieuw vullen vervangt de vorige voorbeelddata.
