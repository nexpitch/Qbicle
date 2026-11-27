# Google Workspace en Google Cloud (koppeling, alleen-lezen)

Code: `packages/koppelingen/src/google/`. Grens zoals bij alle koppelingen (zie [koppelingen.md](koppelingen.md)):
alleen configuratie en metadata, nooit de inhoud van mail, Drive, agenda's, buckets of databases, en nooit schrijfrechten.

## Wat we lezen

**Google Workspace** (mail en accounts)

| Onderdeel | API | Bevindingen |
|---|---|---|
| Accounts | Directory API `users.list` | beheerders zonder tweestapsverificatie, accounts zonder tweestapsverificatie, niet verplicht, te veel of maar één superbeheerder, 90 dagen niet gebruikt |
| Domeinen | Directory API `domains.list` | niet geverifieerd; alle domeinen worden assets voor de domeinscan (SPF, DKIM met selector `google`, DMARC) |
| Apps met toegang | Reports API, `token`-logboek (180 dagen) | apps van andere partijen met toegang tot Gmail of heel Drive |
| Instellingen | Cloud Identity Policy API | Gmail: automatisch doorsturen, POP en IMAP; Drive: delen met iedereen op internet |

Scopes (alle vier readonly): `admin.directory.user.readonly`, `admin.directory.domain.readonly`,
`admin.reports.audit.readonly`, `cloud-identity.policies.readonly`.

**Google Cloud** (infrastructuur), met de rol **Security Reviewer** (`roles/iam.securityReviewer`):

| Onderdeel | API | Bevindingen |
|---|---|---|
| Opslag | Cloud Storage: buckets + IAM-beleid | bucket leesbaar voor `allUsers`/`allAuthenticatedUsers`, rechten per bestand (geen uniforme toegang) |
| Firewall | Compute `firewalls.list` | beheer- of databasepoorten (RDP, databases, SMB, VNC, alle poorten) open voor 0.0.0.0/0; SSH apart als waarschuwing |
| Servers en IP's | Compute `aggregated/instances`, `aggregated/addresses` | openbare IP-adressen als assets (gaan mee in de scan) |
| Cloud Run | Run v2 `services` + IAM | openbaar bereikbare diensten (asset, ter info) |
| Databases | Cloud SQL Admin `instances.list` | open voor heel internet, onversleutelde verbindingen toegestaan, geen back-up |

## Eerlijke dekking en te veel rechten

- Elk onderdeel heeft een eigen dekking. Weigert Google een onderdeel (geen recht, API uit), dan staat het op
  "niet gecontroleerd" met de reden. Geen bevinding betekent dus nooit vanzelf "in orde".
- **Te veel rechten, Workspace:** we vragen voor een paar scopes die we niet nodig hebben (volledige Gmail,
  mail lezen, Drive lezen, accounts wijzigen) alleen een token aan en gooien dat meteen weg. Geeft Google er een,
  dan heeft de beheerder te veel toegestaan en staat de koppeling op "let op".
- **Te veel rechten, Cloud:** `projects.testIamPermissions` met o.a. `storage.objects.get`, `compute.instances.delete`
  en `resourcemanager.projects.setIamPolicy`. Die vraagt alleen of we het recht hebben, er gebeurt niets.

## Hoe het in productie werkt (geen geheimen per klant)

Qbicle heeft één eigen serviceaccount bij Google, op de BV.

- **Workspace:** de klant geeft dat serviceaccount via domeinbrede delegatie de vier readonly-scopes
  (later via een Google Workspace Marketplace-app met "Installeren voor het hele domein"). Qbicle leest namens
  een beheerder die de klant opgeeft. Per klant bewaren we alleen dat e-mailadres.
- **Cloud:** de klant geeft het serviceaccount de rol Security Reviewer op een project of de organisatie.
  Per klant bewaren we alleen de project-id's.
- Intrekken bij Google: delegatie verwijderen in de Admin-console, of de rol weghalen in IAM.

De sleutel van het Qbicle-serviceaccount komt in productie in de kluis (bouwplan stap 2), of we gebruiken
workload identity zodat er geen sleutelbestand is.

## Testen zonder Google (testmodus)

```bash
bash scripts/google-test.sh test           # met Docker, zonder Node
npm run google -- workspace --test         # met Node
npm run google -- cloud --test --te-veel   # met nagebootste te veel rechten
```

De testmodus draait de hele leesroute (JWT ondertekenen, token, paginering, fouten) tegen een nagebootste Google
met voorbeelddata (`src/google/testmodus.ts`). De klantpagina Koppelingen gebruikt in testmodus dezelfde
beoordeling op dezelfde voorbeelddata.

## Testen met je eigen Google-omgeving (stap voor stap)

Je maakt een eigen test-serviceaccount aan dat de rol van het Qbicle-serviceaccount speelt. Het sleutelbestand
blijft op je laptop, in de map `geheim` (staat in `.gitignore`). Plak het nooit in een chat of mail.

### A. Serviceaccount maken (één keer, ongeveer 10 minuten)

1. Ga naar <https://console.cloud.google.com> en log in met je beheerdersaccount van Google Workspace.
2. Klik bovenaan op de projectkiezer → **Nieuw project**. Naam: `qbicle-test`. Klik op **Maken** en kies daarna dit project.
   Noteer de **project-id** (staat onder de naam, bijvoorbeeld `qbicle-test-123456`).
3. Ga naar **API's en services → Bibliotheek** en zet deze API's aan (zoeken, openen, **Inschakelen**):
   - Admin SDK API
   - Cloud Identity API
   - Cloud Resource Manager API
   - Compute Engine API
   - Cloud SQL Admin API
   - Cloud Run Admin API
4. Ga naar **IAM en beheer → Serviceaccounts → Serviceaccount maken**. Naam: `qbicle-lezen`. Klik op
   **Maken en doorgaan**, sla de rollen over en klik op **Klaar**.
5. Klik op het nieuwe serviceaccount. Noteer op het tabblad **Details** de **Unieke ID** (een lang getal) en het
   **e-mailadres** (eindigt op `iam.gserviceaccount.com`).
6. Tabblad **Sleutels → Sleutel toevoegen → Nieuwe sleutel maken → JSON → Maken**. Er wordt een bestand gedownload.
7. Maak in de map `qbicle` op je laptop een map `geheim` en zet het bestand daar neer als `google-sleutel.json`:

   ```bash
   cd ~/Claude/qbicle
   mkdir -p geheim
   mv ~/Downloads/qbicle-test-*.json geheim/google-sleutel.json
   ```

> Lukt stap 6 niet ("Het maken van serviceaccountsleutels is uitgeschakeld")? Dan staat het organisatiebeleid
> `iam.disableServiceAccountKeyCreation` aan. Ga naar **IAM en beheer → Organisatiebeleid**, zoek
> "Disable service account key creation", kies **Beleid beheren → Overschrijven → Niet afdwingen** voor dit project
> en sla op. Lukt dat niet, geef jezelf dan eerst de rol "Beheerder van organisatiebeleid" op de organisatie.

### B. Google Workspace testen

1. Ga naar <https://admin.google.com> → **Beveiliging → Toegangs- en gegevensbeheer → API-beheer**.
2. Klik op **Domeinbrede delegatie beheren → Nieuwe toevoegen**.
3. Client-ID: de **Unieke ID** uit stap A5. OAuth-bereiken: plak deze regel in zijn geheel:

   ```
   https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.domain.readonly,https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/cloud-identity.policies.readonly
   ```

4. Klik op **Autoriseren**. Het werkt meestal binnen een paar minuten (soms tot een uur).
5. In Terminal, met je eigen beheerdersadres:

   ```bash
   cd ~/Claude/qbicle
   bash scripts/google-test.sh workspace jouw-naam@jouwdomein.nl
   ```

### C. Google Cloud testen

1. In <https://console.cloud.google.com>, kies het project dat je wilt laten controleren (het testproject, of een
   project met echte servers of opslag).
2. **IAM en beheer → IAM → Toegang verlenen.** Nieuwe principal: het e-mailadres van het serviceaccount (stap A5).
   Rol: **Security Reviewer**. Opslaan.
3. In Terminal:

   ```bash
   bash scripts/google-test.sh cloud project-id
   ```

   Is het testproject leeg, dan zie je vooral "gecontroleerd" zonder bevindingen. Maak eventueel een bucket aan om te
   zien dat hij gevonden wordt.

### Na het testen opruimen

- Admin-console → API-beheer → Domeinbrede delegatie → de regel met de Unieke ID → **Verwijderen**.
- Cloud-console → Serviceaccounts → `qbicle-lezen` → Sleutels → sleutel verwijderen (of het hele project verwijderen).
- Verwijder `geheim/google-sleutel.json` van je laptop.

## Nog te doen

1. Instellingen uit de Policy API controleren tegen een echte omgeving (namen als `settings/gmail.auto_forwarding`).
2. Koppeling in de klantomgeving echt laten controleren (na opslag en kluis, bouwplan stap 2): beheerdersadres of
   project-id invullen, ronde draaien, uitkomst opslaan, assets naar "Alles in beeld" en domeinen naar de domeinscan.
3. Qbicle-serviceaccount op de BV en Marketplace-app voor Workspace (geen handmatige delegatie meer).
4. Bevindingen meewegen in de urgentiescore.
