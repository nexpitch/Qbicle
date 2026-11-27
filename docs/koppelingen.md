# Koppelingen (alleen-lezen toegang tot systemen van de klant)

Ontwerp: Claude Doc "Qbicle: systemen en opslag beoordelen (koppelingen)", 27-11-2026.

## Grens

- Alleen lezen, nooit schrijfrechten.
- Alleen configuratie en metadata, nooit inhoud van mails, bestanden, chats of databases.
  `VERBODEN_RECHTEN` in `packages/koppelingen/src/catalogus.ts` en de test bewaken dat.
- De klant (eigenaar of beheerder) start een koppeling; IT verleent toestemming bij de dienst zelf.
- Intrekken met één klik in Qbicle, plus uitleg hoe IT het bij de dienst zelf intrekt.

## Wat er nu is (testmodus)

- `packages/koppelingen`: catalogus (Microsoft 365, Google Workspace, AWS, Azure, Google Cloud,
  Intune, UniFi, Meraki, Qbicle Connector, RMM) en een teststand in het geheugen.
- API onder `/api/v1/organisaties/:org/koppelingen` (lijst, starten, deellink, test-toestemming,
  intrekken, interesse). Wijzigen vraagt `domeinen:beheren` (eigenaar of beheerder).
- Pagina's: `/o/:org/koppelingen`, `/o/:org/koppelingen/:koppeling` en de openbare
  `/it/:token` (stappenplan voor de IT-beheerder, 7 dagen geldig, zonder klantgegevens).
- Er wordt niets echt verbonden. De stand is weg na een herstart.
- Google Workspace en Google Cloud: echte alleen-lezen leesroute met testmodus en opdrachtregel, zie [google.md](google.md).
  Op de klantpagina gebruikt de testmodus de echte beoordeling op voorbeelddata.

## Volgende stappen

1. Opslag in de database, logboek per ophaalactie, versleutelde tokens (kluis).
2. Register bedrijfskritische systemen (ERP, webshop, boekhouding) met impact op operatie en reputatie.
3. Microsoft 365 echt koppelen (Entra-app op de BV, Publisher Verification).
4. AWS-leesrol via CloudFormation (SecurityAudit + ExternalId).

## Register bedrijfskritische systemen

- Tabel `systeem` (migratie 0015; 0010 t/m 0014 zijn op andere branches in gebruik).
- `packages/platform/src/systemen.ts`: toevoegen, wijzigen, verwijderen (audit-log), en `beoordeelSysteem`:
  impact hoog / middel / laag en acties in gewone taal (MFA, terugvalplan, updates, verwerkersovereenkomst,
  gegevens buiten de EU, eigenaar).
- MKB tot 5 systemen, Business onbeperkt (afgedwongen met een lock per organisatie).
- Pagina's `/o/:org/systemen`, `/o/:org/systemen/nieuw`, `/o/:org/systemen/:id`. API onder
  `/api/v1/organisaties/:org/systemen`. Wijzigen vraagt `domeinen:beheren`.
- Nog niet: impact meewegen in de urgentiescore, voorstellen uit DNS en apps in Microsoft 365.
