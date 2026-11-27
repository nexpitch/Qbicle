# Scan-worker en planner

De scan-worker (`packages/worker`) zorgt dat het klantdashboard echte cijfers krijgt.
Hij draait op de achtergrond en doet elke minuut:

1. **Plannen** (`planScans`): bevestigde domeinen in de wachtrij zetten.
   - Net bevestigd en nog nooit gescand: meteen (eerste scan).
   - Klant met abonnement (proef, actief, achterstallig of opgezegd maar nog lopend): opnieuw
     als de laatste geslaagde scan ouder is dan 7 dagen (`QBICLE_SCAN_INTERVAL_DAGEN`).
   - Mislukt: opnieuw na 6 uur, hooguit 3 keer achter elkaar. Daarna wacht het domein op een mens
     (knop in de klantomgeving of "opnieuw" in de cockpit).
   - Nooit: domeinen die niet (meer) bevestigd zijn of op de opt-outlijst staan.
2. **Scannen** (`drainQueue`): de oudste scan uit de wachtrij pakken (`FOR UPDATE SKIP LOCKED`,
   dus meerdere workers kunnen naast elkaar), de passieve scanner draaien en het resultaat opslaan.
   Na 10 minuten (`QBICLE_SCAN_TIMEOUT_MINUTEN`) breekt hij af en is de scan mislukt.
3. **Hartslag** in `worker_heartbeat`, zodat de cockpit ziet of er een worker draait.

## Scangrenzen

De worker gebruikt alleen de bestaande passieve scanner (niveau 0 en 1: DNS, één TLS-verbinding,
de homepage en security.txt). Geen poortscans, geen inlogpogingen, nooit kwetsbaarheden uitproberen.
Actief poorten scannen vraagt een scanopdracht per netwerk en zit hier bewust niet in. Vlak voor het
scannen controleert de worker opnieuw of het domein nog bevestigd is en niet op de opt-outlijst staat.

## Wat er wordt opgeslagen

| Wat | Tabel | Regel |
|---|---|---|
| Domein en gevonden websites | `asset` (bron `scanner`, blootstelling `internet`) | Website die met zekerheid weg is: status `verdwenen` |
| Elke check | `check_run` | Voor de dekking op het dashboard |
| Bevindingen | `finding` (+ `finding_vuln`, `vuln`) | Zie hieronder |
| Score van deze scan | `score_snapshot` | Reproduceerbaar rapport |
| Scan zelf | `scan` | `klaar` of `mislukt` met uitleg in `error` |

Bevindingen hebben episodes, zodat de trend en "opgelost sinds vorige keer" kloppen:

- Zelfde fout op hetzelfde asset (`scan_fingerprint`) zolang hij open staat: één rij, `last_seen` schuift op.
- **Opgelost** alleen als dezelfde check op hetzelfde asset deze keer echt draaide (ok of finding) en de
  fout niet meer zag. Kon de check niet (DNS-storing, time-out), dan blijft de bevinding open.
- Komt een opgeloste fout terug, dan is dat een nieuwe rij. De oude blijft opgelost in de geschiedenis.
- Een geaccepteerde bevinding blijft geaccepteerd zolang hij open staat.

Alles van één scan gaat in één transactie, samen met het afronden. Heeft de Bewaker de scan intussen
opnieuw in de wachtrij gezet, dan slaat deze worker niets op (`claimed_by`).

Na de eerste geslaagde scan van een domein krijgen eigenaren en beheerders een mail met een link naar het overzicht.

## In de cockpit

Gezondheid toont naast wachtrij, bezig, vast en mislukt nu ook **Scan-worker: draait of stil**.
Staan er scans klaar en draait er geen worker, dan is het oordeel "storing". Onverwachte fouten
(geen "domein bestaat niet") komen in de foutenlijst met de klant erbij. Vastgelopen scans zet
de Bewaker opnieuw in de wachtrij, zoals al bestond.

## Wat de klant ziet

- **Domeinen**: per bevestigd domein de laatste scan en de volgende geplande scan (dag, datum en tijd, Nederlandse tijd),
  met uitleg ("De eerste scan start binnen een minuut", "We scannen elke week automatisch opnieuw"). Draait de scanner
  niet, dan staat dat er ook.
- **Scan nu starten**: start direct een scan. Daarna kan dat pas weer na 5 minuten, en hooguit 6 keer per dag per domein.
- **Scanpagina** (`/o/<org>/scans/<id>`): live voortgang per stap (Domein en DNS, E-mail, Certificaat, Website en software).
  De worker schrijft de voortgang in `scan.progress`; de pagina vraagt die elke 2 seconden op. Na afloop toont hij de
  urgentie en gaat hij vanzelf door naar het overzicht met de resultaten. Een mislukte scan zegt waarom (zonder technische details).

## Lokaal

```bash
bash scripts/klantomgeving.sh                 # start web, database én de worker
docker compose --profile web logs -f worker   # meekijken wat de worker doet
docker compose run --rm worker --eenmalig     # of: één ronde met de hand
```
