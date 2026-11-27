/**
 * Catalogus van koppelingen: alleen-lezen toegang tot systemen van de klant
 * (Microsoft 365, cloudopslag, routers, ...). Per koppeling staat hier in gewone
 * taal wat we zien, wat we bewust niet zien, welke rechten we vragen en hoe de
 * IT-beheerder het verleent en weer intrekt.
 *
 * Grens (ontwerp 27-11-2026): alleen configuratie en metadata, nooit inhoud van
 * bestanden, mail of databases, en nooit schrijfrechten. Rechten die inhoud kunnen
 * lezen staan daarom niet in deze lijst; de test bewaakt dat.
 */

export type KoppelingId =
  | 'microsoft365'
  | 'google-workspace'
  | 'aws'
  | 'azure'
  | 'google-cloud'
  | 'intune'
  | 'unifi'
  | 'meraki'
  | 'connector'
  | 'rmm';

export type Categorie = 'accounts' | 'cloud' | 'netwerk' | 'beheer';

export const CATEGORIEEN: { id: Categorie; naam: string; uitleg: string }[] = [
  { id: 'accounts', naam: 'Kantoor en accounts', uitleg: 'Mail, bestanden delen, inloggen en de apps die daar toegang toe hebben.' },
  { id: 'cloud', naam: 'Cloud, servers en opslag', uitleg: 'Opslag, servers en databases bij een cloudleverancier.' },
  { id: 'netwerk', naam: 'Netwerk en apparaten', uitleg: 'Routers, NAS, camera’s, printers en andere apparaten op kantoor.' },
  { id: 'beheer', naam: 'Laptops en servers in beheer', uitleg: 'Updates en beveiliging van apparaten die al centraal beheerd worden.' },
];

/** testmodus: de hele flow is te proberen met nepdata. binnenkort: alleen uitleg en "laat me weten". */
export type Beschikbaarheid = 'testmodus' | 'binnenkort';
export type Pakket = 'mkb' | 'business';

export interface Recht {
  /** Technische naam zoals de IT-beheerder hem in het toestemmingsscherm ziet. */
  naam: string;
  /** Wat het in gewone taal betekent. */
  uitleg: string;
}

export interface VoorbeeldBevinding {
  urgentie: 'crit' | 'warn' | 'ok';
  titel: string;
  actie: string;
}

export interface Koppeling {
  id: KoppelingId;
  naam: string;
  categorie: Categorie;
  /** Eén zin voor de kaart in het overzicht. */
  kort: string;
  beschikbaarheid: Beschikbaarheid;
  /** Vanaf welk pakket de koppeling inbegrepen is. */
  pakket: Pakket;
  /** Wie het moet doen, bijv. "Globale beheerder van Microsoft 365". */
  wie: string;
  duur: string;
  /** Hoe de klant toegang geeft, in één woord voor de kaart. */
  methode: string;
  zien: string[];
  nietZien: string[];
  rechten: Recht[];
  /** Stappenplan voor de IT-beheerder of IT-partner. */
  stappen: string[];
  /** Hoe IT het aan de kant van de dienst zelf intrekt (los van Qbicle). */
  intrekkenBijDienst: string;
  voorbeeldBevindingen: VoorbeeldBevinding[];
}

export const KOPPELINGEN: Koppeling[] = [
  {
    id: 'microsoft365',
    naam: 'Microsoft 365',
    categorie: 'accounts',
    kort: 'MFA, beheerders, gasten, delen van bestanden en apps met toegang tot je omgeving.',
    beschikbaarheid: 'testmodus',
    pakket: 'mkb',
    wie: 'Globale beheerder van Microsoft 365',
    duur: 'ongeveer 5 minuten',
    methode: 'Toestemming via Microsoft',
    zien: [
      'Welke accounts er zijn en of ze tweestapsverificatie (MFA) gebruiken',
      'Wie beheerder is, en hoeveel globale beheerders er zijn',
      'Gastaccounts van buiten het bedrijf',
      'Oude inlogmethoden zonder MFA (zoals IMAP en POP)',
      'Of bestanden in SharePoint en OneDrive met iedereen gedeeld mogen worden',
      'Apps van andere partijen die toegang hebben tot mail of bestanden',
      'Je Microsoft Secure Score en accounts die lang niet zijn gebruikt',
    ],
    nietZien: ['De inhoud van mails, bestanden, chats of agenda’s', 'Wachtwoorden', 'Wijzigen kunnen we niets: alle rechten zijn alleen-lezen'],
    rechten: [
      { naam: 'User.Read.All', uitleg: 'Lijst van accounts lezen (naam, status, laatste inlog).' },
      { naam: 'Directory.Read.All', uitleg: 'Groepen, rollen en beheerders lezen.' },
      { naam: 'Policy.Read.All', uitleg: 'Beveiligingsregels lezen, zoals wanneer MFA verplicht is.' },
      { naam: 'Reports.Read.All', uitleg: 'Rapport lezen wie MFA heeft ingesteld.' },
      { naam: 'AuditLog.Read.All', uitleg: 'Inlogpogingen en wijzigingen in beheer lezen (geen inhoud).' },
      { naam: 'SecurityEvents.Read.All', uitleg: 'Secure Score en beveiligingsmeldingen van Microsoft lezen.' },
      { naam: 'Application.Read.All', uitleg: 'Lezen welke apps toegang hebben gekregen.' },
      { naam: 'SharePointTenantSettings.Read.All', uitleg: 'De deelinstellingen van SharePoint en OneDrive lezen, niet de bestanden.' },
    ],
    stappen: [
      'Log in op Qbicle of open de link die je hebt gekregen, en kies Microsoft 365.',
      'Klik op "Toestemming geven bij Microsoft". Je komt op de inlogpagina van Microsoft zelf.',
      'Log in met een account dat Globale beheerder is.',
      'Microsoft toont de lijst met rechten van de app "Qbicle". Controleer dat er alleen ".Read" in staat en klik op Accepteren.',
      'Je komt terug bij Qbicle. Binnen een paar minuten staat de eerste uitkomst klaar.',
    ],
    intrekkenBijDienst: 'Microsoft Entra-beheercentrum → Bedrijfstoepassingen → Qbicle → Eigenschappen → Verwijderen.',
    voorbeeldBevindingen: [
      { urgentie: 'crit', titel: '3 van de 14 medewerkers loggen in zonder MFA', actie: 'Zet MFA verplicht aan voor iedereen.' },
      { urgentie: 'warn', titel: '5 globale beheerders, advies is maximaal 2', actie: 'Geef 3 mensen een lichtere beheerdersrol.' },
      { urgentie: 'warn', titel: 'Bestanden mogen gedeeld worden met "iedereen met de link"', actie: 'Beperk delen tot mensen binnen of bekend bij het bedrijf.' },
      { urgentie: 'ok', titel: 'Oude inlogmethoden (IMAP, POP) staan uit', actie: 'Niets doen.' },
    ],
  },
  {
    id: 'google-workspace',
    naam: 'Google Workspace',
    categorie: 'accounts',
    kort: 'Tweestapsverificatie, beheerders, Gmail-instellingen, delen in Drive en apps met toegang.',
    beschikbaarheid: 'testmodus',
    pakket: 'mkb',
    wie: 'Superbeheerder van Google Workspace',
    duur: 'ongeveer 5 minuten',
    methode: 'Toestemming via Google',
    zien: [
      'Welke accounts er zijn en of ze tweestapsverificatie gebruiken',
      'Wie (super)beheerder is, en accounts die lang niet zijn gebruikt',
      'Gmail-instellingen: automatisch doorsturen naar buiten, POP en IMAP',
      'Of Drive-bestanden met iedereen op internet gedeeld mogen worden',
      'Apps van andere partijen met toegang tot mail of Drive',
      'Je domeinen, zodat de domeinscan ook SPF, DKIM en DMARC van je mail controleert',
    ],
    nietZien: ['De inhoud van mails, documenten, chats of agenda’s', 'Wachtwoorden', 'Wijzigen kunnen we niets: alle rechten zijn alleen-lezen'],
    rechten: [
      { naam: 'admin.directory.user.readonly', uitleg: 'Lijst van accounts lezen, met beheerdersrol, tweestapsverificatie en laatste inlog.' },
      { naam: 'admin.directory.domain.readonly', uitleg: 'Domeinen in de omgeving lezen.' },
      { naam: 'admin.reports.audit.readonly', uitleg: 'Logboek lezen welke apps toegang kregen (geen inhoud).' },
      { naam: 'cloud-identity.policies.readonly', uitleg: 'Instellingen van Gmail en Drive lezen, zoals doorsturen en delen.' },
    ],
    stappen: [
      'Kies in Qbicle Google Workspace. Je ziet de Client-ID van Qbicle en vier rechten die allemaal eindigen op "readonly".',
      'Log in op admin.google.com als superbeheerder en ga naar Beveiliging → Toegangs- en gegevensbeheer → API-beheer.',
      'Klik op "Domeinbrede delegatie beheren" → "Nieuwe toevoegen". Plak de Client-ID en de vier rechten (kommagescheiden) en klik op Autoriseren.',
      'Vul in Qbicle het e-mailadres van een beheerder in. Qbicle leest namens dat account, alleen-lezen. Klik op "Controleren".',
    ],
    intrekkenBijDienst: 'Google Admin-console → Beveiliging → API-beheer → Domeinbrede delegatie beheren → Qbicle → Verwijderen.',
    voorbeeldBevindingen: [
      { urgentie: 'crit', titel: '2 beheerders zonder tweestapsverificatie', actie: 'Zet tweestapsverificatie verplicht aan voor beheerders.' },
      { urgentie: 'warn', titel: 'Medewerkers mogen mail automatisch doorsturen naar buiten', actie: 'Zet automatisch doorsturen uit in de Gmail-instellingen.' },
      { urgentie: 'warn', titel: 'Drive mag delen met iedereen op internet', actie: 'Beperk delen tot het eigen domein en vertrouwde partijen.' },
    ],
  },
  {
    id: 'aws',
    naam: 'Amazon Web Services (AWS)',
    categorie: 'cloud',
    kort: 'Openbare opslag (S3), open poorten op servers, oude toegangssleutels en logging.',
    beschikbaarheid: 'testmodus',
    pakket: 'business',
    wie: 'Iemand met beheerdersrechten in het AWS-account',
    duur: 'ongeveer 10 minuten',
    methode: 'Leesrol via sjabloon',
    zien: [
      'Per opslagbucket: openbaar of niet, versleuteld, versiebeheer aan',
      'Servers en databases die vanaf heel internet bereikbaar zijn',
      'Of het hoofdaccount (root) MFA heeft',
      'Toegangssleutels die lang niet vervangen zijn',
      'Of logging (CloudTrail) aan staat',
    ],
    nietZien: ['Bestanden in opslag of gegevens in databases', 'Wachtwoorden of geheime sleutels', 'Wijzigen kunnen we niets'],
    rechten: [
      { naam: 'SecurityAudit (door AWS beheerd beleid)', uitleg: 'Instellingen van alle diensten lezen, niet de gegevens zelf.' },
      { naam: 'ExternalId', uitleg: 'Een geheime code die alleen voor jouw account geldt, zodat niemand anders deze rol kan gebruiken.' },
    ],
    stappen: [
      'Kies in Qbicle AWS en klik op "Sjabloon openen in AWS". Je komt in CloudFormation van je eigen account.',
      'Het sjabloon maakt één rol "QbicleLezen" aan met het beleid SecurityAudit en jouw ExternalId. Controleer dat en klik op "Stack maken".',
      'Wacht tot de status "CREATE_COMPLETE" is en kopieer de rol-ARN uit het tabblad Uitvoer.',
      'Plak de rol-ARN in Qbicle en klik op "Controleren".',
    ],
    intrekkenBijDienst: 'AWS-console → CloudFormation → stack "Qbicle" → Verwijderen. De rol verdwijnt dan direct.',
    voorbeeldBevindingen: [
      { urgentie: 'crit', titel: 'Bucket "facturen-backup" is voor iedereen leesbaar', actie: 'Zet "Block Public Access" aan op deze bucket.' },
      { urgentie: 'crit', titel: 'Extern bureaublad (poort 3389) open voor heel internet', actie: 'Sta alleen het IP-adres van kantoor of de VPN toe.' },
      { urgentie: 'warn', titel: 'Toegangssleutel al 400 dagen niet vervangen', actie: 'Maak een nieuwe sleutel en verwijder de oude.' },
    ],
  },
  {
    id: 'azure',
    naam: 'Microsoft Azure',
    categorie: 'cloud',
    kort: 'Openbare opslag (Blob), open poorten, adviezen van Defender for Cloud.',
    beschikbaarheid: 'binnenkort',
    pakket: 'business',
    wie: 'Eigenaar van het Azure-abonnement',
    duur: 'ongeveer 10 minuten',
    methode: 'Leesrol op abonnement',
    zien: ['Opslagaccounts met openbare toegang', 'Netwerkregels die poorten openzetten naar internet', 'Adviezen van Defender for Cloud', 'Versleuteling en back-up van servers'],
    nietZien: ['Bestanden in opslag of gegevens in databases', 'Sleutels van opslagaccounts', 'Wijzigen kunnen we niets'],
    rechten: [
      { naam: 'Reader', uitleg: 'Instellingen van alle onderdelen lezen. Geeft geen toegang tot gegevens of sleutels.' },
      { naam: 'Security Reader', uitleg: 'Beveiligingsadviezen van Microsoft lezen.' },
    ],
    stappen: [
      'Geef eerst toestemming voor de Qbicle-app bij Microsoft 365 (zelfde app).',
      'Ga in Azure naar Abonnementen → je abonnement → Toegangsbeheer (IAM) → Roltoewijzing toevoegen.',
      'Kies de rollen Reader en Security Reader en wijs ze toe aan "Qbicle".',
      'Ga terug naar Qbicle en klik op "Controleren".',
    ],
    intrekkenBijDienst: 'Azure-portal → Abonnement → Toegangsbeheer (IAM) → Roltoewijzingen → Qbicle verwijderen.',
    voorbeeldBevindingen: [{ urgentie: 'crit', titel: 'Opslagaccount staat openbare toegang toe', actie: 'Zet "Allow Blob public access" uit.' }],
  },
  {
    id: 'google-cloud',
    naam: 'Google Cloud',
    categorie: 'cloud',
    kort: 'Openbare opslag, open poorten, servers, Cloud Run en databases in je projecten.',
    beschikbaarheid: 'testmodus',
    pakket: 'business',
    wie: 'Eigenaar van het Google Cloud-project of de organisatie',
    duur: 'ongeveer 5 minuten',
    methode: 'Leesrol op project',
    zien: [
      'Opslagbuckets die voor iedereen leesbaar zijn (allUsers)',
      'Firewallregels die beheer- of databasepoorten openzetten naar internet',
      'Servers en vaste IP-adressen die vanaf internet bereikbaar zijn (die gaan mee in de scan)',
      'Cloud Run-diensten die openbaar zijn',
      'Cloud SQL-databases: bereikbaar vanaf internet, versleutelde verbindingen, back-ups',
    ],
    nietZien: ['Bestanden in opslag of gegevens in databases', 'Sleutels en wachtwoorden', 'Wijzigen kunnen we niets'],
    rechten: [{ naam: 'roles/iam.securityReviewer', uitleg: 'Lijsten en instellingen van alle onderdelen lezen, plus wie welke rechten heeft. Niet de gegevens zelf.' }],
    stappen: [
      'Kies in Qbicle Google Cloud en kopieer het e-mailadres van het Qbicle-serviceaccount.',
      'Ga in console.cloud.google.com naar IAM en beheer → IAM en kies bovenaan het project (of de hele organisatie).',
      'Klik op "Toegang verlenen", plak het serviceaccount en kies de rol "Security Reviewer". Opslaan.',
      'Vul in Qbicle de project-id in (of laat leeg voor alle projecten) en klik op "Controleren".',
    ],
    intrekkenBijDienst: 'Google Cloud-console → IAM en beheer → IAM → het Qbicle-serviceaccount → Toegang verwijderen.',
    voorbeeldBevindingen: [
      { urgentie: 'crit', titel: 'Bucket is leesbaar voor iedereen (allUsers)', actie: 'Verwijder allUsers uit de rechten van de bucket.' },
      { urgentie: 'crit', titel: 'Extern bureaublad (poort 3389) open voor heel internet', actie: 'Sta alleen het IP-adres van kantoor of een VPN toe.' },
    ],
  },
  {
    id: 'intune',
    naam: 'Microsoft Intune',
    categorie: 'beheer',
    kort: 'Laptops en telefoons: versleuteling, besturingssysteem en of ze aan de regels voldoen.',
    beschikbaarheid: 'binnenkort',
    pakket: 'business',
    wie: 'Globale beheerder of Intune-beheerder',
    duur: 'ongeveer 2 minuten (bovenop Microsoft 365)',
    methode: 'Extra toestemming via Microsoft',
    zien: ['Welke laptops en telefoons er zijn', 'Schijfversleuteling aan of uit', 'Versie van het besturingssysteem', 'Laatste keer gezien'],
    nietZien: ['Bestanden of apps op het apparaat', 'Locatie van het apparaat', 'Wijzigen of wissen kunnen we niets'],
    rechten: [
      { naam: 'DeviceManagementManagedDevices.Read.All', uitleg: 'Lijst van beheerde apparaten en hun status lezen.' },
      { naam: 'DeviceManagementConfiguration.Read.All', uitleg: 'Ingestelde regels lezen.' },
    ],
    stappen: ['Zorg dat Microsoft 365 al gekoppeld is.', 'Klik in Qbicle op "Intune toevoegen" en accepteer de twee extra rechten bij Microsoft.'],
    intrekkenBijDienst: 'Zelfde als Microsoft 365: verwijder de app Qbicle in Entra.',
    voorbeeldBevindingen: [{ urgentie: 'warn', titel: '4 laptops zonder schijfversleuteling', actie: 'Zet BitLocker of FileVault aan via Intune.' }],
  },
  {
    id: 'unifi',
    naam: 'UniFi (Ubiquiti)',
    categorie: 'netwerk',
    kort: 'Routers, access points en welke apparaten er in je netwerk hangen.',
    beschikbaarheid: 'testmodus',
    pakket: 'business',
    wie: 'Eigenaar of beheerder van de UniFi Site Manager',
    duur: 'ongeveer 3 minuten',
    methode: 'API-sleutel (alleen-lezen)',
    zien: ['Firmware van routers en access points', 'Poorten die naar binnen zijn doorgezet', 'Apparaten in het netwerk (soort en merk)'],
    nietZien: ['Wat er over het netwerk verstuurd wordt', 'Wifi-wachtwoorden', 'Wijzigen kunnen we niets'],
    rechten: [{ naam: 'Site Manager API-sleutel', uitleg: 'Een sleutel die alleen kan lezen. UniFi biedt geen schrijfrechten via deze sleutel.' }],
    stappen: [
      'Log in op unifi.ui.com en ga naar API.',
      'Klik op "Create API Key", noem hem "Qbicle" en kopieer de sleutel.',
      'Plak de sleutel in Qbicle en klik op "Controleren".',
    ],
    intrekkenBijDienst: 'unifi.ui.com → API → sleutel "Qbicle" → Verwijderen.',
    voorbeeldBevindingen: [
      { urgentie: 'warn', titel: 'Poort 8080 doorgezet naar een camera', actie: 'Haal de doorzetting weg en gebruik de app van de fabrikant of een VPN.' },
      { urgentie: 'ok', titel: 'Firmware van router is actueel', actie: 'Niets doen.' },
    ],
  },
  {
    id: 'meraki',
    naam: 'Cisco Meraki',
    categorie: 'netwerk',
    kort: 'Firewalls, switches en access points: firmware en open poorten.',
    beschikbaarheid: 'testmodus',
    pakket: 'business',
    wie: 'Organisatiebeheerder in het Meraki-dashboard',
    duur: 'ongeveer 5 minuten',
    methode: 'API-sleutel (alleen-lezen)',
    zien: ['Firmware van apparaten', 'Firewallregels en doorgezette poorten', 'Apparaten in het netwerk'],
    nietZien: ['Netwerkverkeer', 'Wijzigen kunnen we niets'],
    rechten: [{ naam: 'API-sleutel van een account met "Read-only" op de organisatie', uitleg: 'Maak een apart account met alleen leesrechten en gebruik daarvan de sleutel.' }],
    stappen: [
      'Maak in het Meraki-dashboard een beheerder "qbicle@jouwbedrijf.nl" met organisatierechten "Read-only".',
      'Log in als die beheerder, ga naar Mijn profiel → API-toegang en maak een sleutel.',
      'Plak de sleutel in Qbicle en klik op "Controleren".',
    ],
    intrekkenBijDienst: 'Meraki-dashboard → Organisatie → Beheerders → qbicle verwijderen.',
    voorbeeldBevindingen: [{ urgentie: 'warn', titel: 'Firmware van firewall is 2 versies achter', actie: 'Plan de update in het Meraki-dashboard.' }],
  },
  {
    id: 'connector',
    naam: 'Qbicle Connector',
    categorie: 'netwerk',
    kort: 'Een kleine app in je netwerk die NAS, printers, camera’s en andere apparaten herkent.',
    beschikbaarheid: 'testmodus',
    pakket: 'business',
    wie: 'Iemand met een computer op kantoor die aan blijft staan',
    duur: 'ongeveer 5 minuten',
    methode: 'App met koppelcode',
    zien: ['Apparaten in het netwerk: soort, merk en model', 'Firmwareversie van NAS en camera’s (waar het apparaat die zelf laat zien)', 'Of beheerpagina’s van apparaten van buiten bereikbaar zijn'],
    nietZien: ['Bestanden op de NAS of computers', 'Netwerkverkeer', 'Namen van apparaten en MAC-adressen gaan niet naar Qbicle', 'Actief zoeken alleen met een getekende scanopdracht'],
    rechten: [{ naam: 'Koppelcode (15 minuten geldig)', uitleg: 'Koppelt de app aan jouw organisatie. Per Connector een eigen sleutel die je kunt intrekken.' }],
    stappen: [
      'Kies in Qbicle Connector en klik op "Koppelcode maken".',
      'Download de app voor Mac of Windows (of de Docker-versie voor IT-partners) en start hem.',
      'Vul de koppelcode in. De app zoekt rustig naar apparaten zonder iets te testen of aan te passen.',
    ],
    intrekkenBijDienst: 'Verwijder de app van de computer. Intrekken in Qbicle maakt de sleutel direct ongeldig.',
    voorbeeldBevindingen: [
      { urgentie: 'crit', titel: 'NAS (Synology) met firmware met bekend lek', actie: 'Installeer de update via DSM → Configuratiescherm → Bijwerken.' },
      { urgentie: 'warn', titel: 'Printer met beheerpagina zonder wachtwoord', actie: 'Stel een beheerderswachtwoord in op de printer.' },
    ],
  },
  {
    id: 'rmm',
    naam: 'Beheertool van je IT-partner',
    categorie: 'beheer',
    kort: 'Updates en antivirus van servers en laptops via NinjaOne, Datto of N-able.',
    beschikbaarheid: 'binnenkort',
    pakket: 'business',
    wie: 'Je IT-partner',
    duur: 'ongeveer 10 minuten',
    methode: 'Lees-API van de beheertool',
    zien: ['Ontbrekende updates per server en laptop', 'Antivirus aan of uit', 'Systemen zonder ondersteuning (bijv. Windows Server 2012)'],
    nietZien: ['Bestanden op apparaten', 'Op afstand meekijken of ingrijpen kunnen we niet'],
    rechten: [{ naam: 'API-sleutel met alleen leesrechten', uitleg: 'Je IT-partner maakt een sleutel aan die alleen apparaten en hun status kan lezen.' }],
    stappen: ['Je IT-partner maakt in de beheertool een API-sleutel met alleen leesrechten.', 'Je IT-partner plakt de sleutel in Qbicle bij jouw organisatie.'],
    intrekkenBijDienst: 'In de beheertool de API-sleutel "Qbicle" verwijderen.',
    voorbeeldBevindingen: [{ urgentie: 'crit', titel: 'Server mist beveiligingsupdates van 3 maanden', actie: 'Laat je IT-partner de updates deze week installeren.' }],
  },
];

/** Rechten die inhoud lezen of iets wijzigen. Mogen nooit in de catalogus staan. */
export const VERBODEN_RECHTEN = [
  /^Mail\./i,
  /^Files\./i,
  /^Sites\.Read/i,
  /^Chat\./i,
  /^Calendars\./i,
  /ReadWrite/i,
  /s3:GetObject/i,
  /Storage Blob Data/i,
  /^drive(\.|$)/i,
  /^gmail/i,
];

export function vindKoppeling(id: string): Koppeling | undefined {
  return KOPPELINGEN.find((k) => k.id === id);
}

/** Is de koppeling inbegrepen bij het pakket van de klant? */
export function inPakket(k: Koppeling, plan: string | null | undefined): boolean {
  if (k.pakket === 'mkb') return true;
  return plan === 'business';
}
