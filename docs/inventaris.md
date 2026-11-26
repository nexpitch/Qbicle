# Infra- en device-inventaris (proof of concept)

Ontwerp: [Qbicle Infra & Devices: technisch ontwerp en bouwplan](https://claude.ai/artifact/VBd2meBrk2zSjGeBUPN31i).

`packages/inventory` voegt waarnemingen uit verschillende bronnen (Intune, Entra,
UniFi, de lokale connector, de bestaande scanner) samen tot één inventaris. Het
pakket doet **zelf geen netwerkverkeer**: er zit geen scan-, poortscan- of
netwerkcode in. Koppelingen en connector komen pas na akkoord op het ontwerp.

## Begrippen

| Begrip | In de code |
| --- | --- |
| Bron | `Source` (soort, product, niveau 0/1/1C/2P/2A, netwerk) |
| Waarneming | `Observation`: identifiers + kenmerken van één bron op één moment |
| Identifier | `Identifier` met sterkte (`strengthOf`): serienummer, cloud-ID, vaste MAC, FQDN, account = sterk; hostnaam, IP, privacy-MAC = zwak |
| Asset | `InventoryAsset`: soort, categorie, blootstelling, beheerd, kenmerken met herkomst, conflicten |

## Samenvoegregels (`buildInventory`)

1. Gedeelde sterke identifier = zelfde asset.
2. Zwak: alleen hostnaam én IP samen, in hetzelfde netwerk, binnen 24 uur.
3. Nooit twee verschillende serienummers in één asset (bijvoorbeeld een gedeelde USB-netwerkadapter).
4. Per kenmerk wint: bronprioriteit (MDM > RMM > identity > cloud > opgegeven > netwerk > connector/scanner > internetdata), dan zekerheid, dan recentste. Verliezers staan in `conflicts`.
5. Geen bron meldt een categorie: afleiding uit mDNS-diensten of OS, met zekerheid "mogelijk".
6. Beheerd = ja als MDM/RMM het apparaat kent; nee als er wel een MDM/RMM gekoppeld is en een laptop/telefoon er niet in staat; anders onbekend.
7. 30 dagen niet gezien = verdwenen.

## Koppeling met scanner en scoremodel

- `fromScanAsset`: elk asset van de buitenkant-scanner wordt een waarneming.
- `toScanTargets`: internetgerichte assets die de scanner nog niet kent (bijvoorbeeld het WAN-adres uit de router) worden doelen voor de niveau-0-checks. Actief scannen zit hier bewust niet in.
- `inventoryFindings`: eerste bevindingen zonder te scannen (onbeheerd apparaat, beheerder zonder MFA, updates achter).
- `exposureFactor`: voorstel voor factor z per blootstelling; gaat pas naar `packages/score` na kalibratie.

## Database

`db/migrations/0003_inventaris.sql` breidt `asset` en `asset_link` uit en voegt
`source`, `observation`, `asset_identifier`, `asset_attribute` en `component` toe.
Een bron op niveau 2A kan niet bestaan zonder verwijzing naar een getekende scanopdracht.
Geheimen staan niet in de database, alleen een verwijzing naar de kluis.

In de proof of concept is de assetsleutel de sterkste identifier. In de database
krijgt elk asset een vaste uuid en wijzen identifiers ernaar, zodat de sleutel niet
verandert als er later een serienummer bijkomt.
