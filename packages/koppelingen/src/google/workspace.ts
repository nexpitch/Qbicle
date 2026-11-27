import { GoogleClient, redenVan, type Dekking } from './client.ts';
import { max10, sorteer, type GoogleAsset, type GoogleBevinding, type GoogleUitkomst } from './bevinding.ts';

/**
 * Google Workspace, alleen-lezen: accounts en tweestapsverificatie, beheerders,
 * domeinen, apps met toegang en instellingen voor Gmail en Drive.
 * Nooit de inhoud van mail, Drive of agenda: daarvoor vragen we geen scopes.
 */

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/cloud-identity.policies.readonly',
];

/**
 * Scopes die we zelf nooit vragen. Als Google ons er toch een token voor geeft, heeft
 * de beheerder meer toegestaan dan nodig: dan zetten we de koppeling op "let op".
 * We vragen alleen een token aan en gooien het meteen weg; er wordt niets mee gelezen.
 */
export const WORKSPACE_TE_VEEL = [
  { scope: 'https://mail.google.com/', uitleg: 'volledige toegang tot Gmail' },
  { scope: 'https://www.googleapis.com/auth/gmail.readonly', uitleg: 'mail lezen' },
  { scope: 'https://www.googleapis.com/auth/drive.readonly', uitleg: 'bestanden in Drive lezen' },
  { scope: 'https://www.googleapis.com/auth/admin.directory.user', uitleg: 'accounts wijzigen' },
];

export interface WsGebruiker {
  primaryEmail: string;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
  isEnrolledIn2Sv?: boolean;
  isEnforcedIn2Sv?: boolean;
  suspended?: boolean;
  archived?: boolean;
  lastLoginTime?: string;
  creationTime?: string;
}
export interface WsDomein {
  domainName: string;
  verified?: boolean;
  isPrimary?: boolean;
}
export interface WsApp {
  naam: string;
  clientId: string;
  scopes: string[];
  gebruikers: number;
}
export interface WsPolicy {
  policyQuery?: { orgUnit?: string };
  setting?: { type?: string; value?: Record<string, unknown> };
}

export interface WorkspaceRuw {
  gebruikers: WsGebruiker[] | null;
  domeinen: WsDomein[] | null;
  apps: WsApp[] | null;
  instellingen: WsPolicy[] | null;
  fouten: Record<string, string>;
  teVeelRechten: string[];
}

interface TokenEvent {
  actor?: { email?: string };
  events?: { name?: string; parameters?: { name: string; value?: string; multiValue?: string[] }[] }[];
}

const DIR = 'https://admin.googleapis.com/admin/directory/v1';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1';
const POLICIES = 'https://cloudidentity.googleapis.com/v1/policies';

export async function leesWorkspace(c: GoogleClient, nu: Date = new Date()): Promise<WorkspaceRuw> {
  const fouten: Record<string, string> = {};
  const poging = async <T>(onderdeel: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      fouten[onderdeel] = redenVan(e);
      return null;
    }
  };

  // Eerst het gewone token: mislukt dat, dan heeft de rest geen zin (fout gaat naar de aanroeper).
  await c.verleendeScopes();

  const velden = 'nextPageToken,users(primaryEmail,isAdmin,isDelegatedAdmin,isEnrolledIn2Sv,isEnforcedIn2Sv,suspended,archived,lastLoginTime,creationTime)';
  const gebruikers = await poging('accounts', () =>
    c.alles<WsGebruiker>(`${DIR}/users?customer=my_customer&maxResults=500&projection=basic&fields=${encodeURIComponent(velden)}`, 'users', 10_000),
  );
  const domeinen = await poging('domeinen', async () => (await c.get<{ domains?: WsDomein[] }>(`${DIR}/customer/my_customer/domains`)).domains ?? []);
  const apps = await poging('apps', async () => {
    const start = new Date(nu.getTime() - 180 * 86_400_000).toISOString();
    const items = await c.alles<TokenEvent>(`${REPORTS}/activity/users/all/applications/token?eventName=authorize&maxResults=1000&startTime=${start}`, 'items', 5_000);
    return appsUitTokens(items);
  });
  const instellingen = await poging('instellingen', () => c.alles<WsPolicy>(`${POLICIES}?pageSize=100`, 'policies', 2_000));

  const teVeelRechten: string[] = [];
  for (const t of WORKSPACE_TE_VEEL) {
    try {
      await c.tokenVoor([t.scope]);
      teVeelRechten.push(`${t.scope} (${t.uitleg})`);
    } catch {
      // Goed zo: niet toegestaan.
    }
  }
  return { gebruikers, domeinen, apps, instellingen, fouten, teVeelRechten };
}

export function appsUitTokens(items: TokenEvent[]): WsApp[] {
  const perApp = new Map<string, { naam: string; scopes: Set<string>; gebruikers: Set<string> }>();
  for (const it of items) {
    for (const ev of it.events ?? []) {
      if (ev.name !== 'authorize') continue;
      const p = Object.fromEntries((ev.parameters ?? []).map((x) => [x.name, x]));
      const id = p.client_id?.value;
      if (!id) continue;
      let a = perApp.get(id);
      if (!a) {
        a = { naam: p.app_name?.value || id, scopes: new Set(), gebruikers: new Set() };
        perApp.set(id, a);
      }
      for (const s of p.scope?.multiValue ?? (p.scope?.value ? [p.scope.value] : [])) a.scopes.add(s);
      if (it.actor?.email) a.gebruikers.add(it.actor.email);
    }
  }
  return [...perApp].map(([clientId, a]) => ({ naam: a.naam, clientId, scopes: [...a.scopes].sort(), gebruikers: a.gebruikers.size }));
}

/** Scopes waarmee een app mail of alle bestanden kan lezen of versturen. */
const RISICO_SCOPE = [/^https:\/\/mail\.google\.com\/?$/, /\/auth\/gmail\.(readonly|modify|send|compose|insert)$/, /\/auth\/drive(\.readonly)?$/];
const isRisico = (s: string) => RISICO_SCOPE.some((r) => r.test(s));

/** Instellingen uit de Policy API: waarde per OU, één regel per instelling. */
function instelling(p: WsPolicy[], type: string): Record<string, unknown>[] {
  return p.filter((x) => x.setting?.type === `settings/${type}`).map((x) => x.setting?.value ?? {});
}

export function beoordeelWorkspace(r: WorkspaceRuw, nu: Date = new Date()): GoogleUitkomst {
  const b: GoogleBevinding[] = [];
  const dekking: Dekking[] = [];
  const assets: GoogleAsset[] = [];
  const dek = (onderdeel: string, ok: boolean) => dekking.push(ok ? { onderdeel, status: 'gecontroleerd' } : { onderdeel, status: 'niet_gecontroleerd', reden: r.fouten[onderdeel] ?? 'Niet gelezen.' });

  // Accounts en tweestapsverificatie
  dek('accounts', r.gebruikers !== null);
  if (r.gebruikers) {
    const actief = r.gebruikers.filter((u) => !u.suspended && !u.archived);
    const beheerders = actief.filter((u) => u.isAdmin || u.isDelegatedAdmin);
    const superBeheerders = actief.filter((u) => u.isAdmin);
    const beheerZonder = beheerders.filter((u) => !u.isEnrolledIn2Sv);
    const zonder = actief.filter((u) => !u.isEnrolledIn2Sv && !(u.isAdmin || u.isDelegatedAdmin));
    if (beheerZonder.length)
      b.push({
        code: 'gw.2sv.beheerders',
        onderdeel: 'accounts',
        urgentie: 'crit',
        titel: `${beheerZonder.length} ${beheerZonder.length === 1 ? 'beheerder' : 'beheerders'} zonder tweestapsverificatie`,
        actie: 'Laat deze beheerders vandaag tweestapsverificatie instellen, liefst met een beveiligingssleutel of de Google-app.',
        bewijs: max10(beheerZonder.map((u) => u.primaryEmail)),
      });
    if (zonder.length)
      b.push({
        code: 'gw.2sv.accounts',
        onderdeel: 'accounts',
        urgentie: 'crit',
        titel: `${zonder.length} van de ${actief.length} accounts loggen in zonder tweestapsverificatie`,
        actie: 'Zet tweestapsverificatie verplicht aan in de Admin-console (Beveiliging → Verificatie → Tweestapsverificatie).',
        bewijs: max10(zonder.map((u) => u.primaryEmail)),
      });
    if (actief.length && !actief.some((u) => u.isEnforcedIn2Sv))
      b.push({
        code: 'gw.2sv.niet_verplicht',
        onderdeel: 'accounts',
        urgentie: 'warn',
        titel: 'Tweestapsverificatie is niet verplicht',
        actie: 'Maak tweestapsverificatie verplicht voor iedereen, zodat nieuwe accounts het ook moeten instellen.',
        bewijs: [],
      });
    if (!beheerZonder.length && !zonder.length && actief.length)
      b.push({ code: 'gw.2sv.ok', onderdeel: 'accounts', urgentie: 'ok', titel: `Alle ${actief.length} accounts gebruiken tweestapsverificatie`, actie: 'Niets doen.', bewijs: [] });
    if (superBeheerders.length > 3)
      b.push({
        code: 'gw.beheerders.te_veel',
        onderdeel: 'accounts',
        urgentie: 'warn',
        titel: `${superBeheerders.length} superbeheerders, advies is 2 of 3`,
        actie: 'Geef de anderen een beperkte beheerdersrol (bijvoorbeeld Gebruikersbeheer).',
        bewijs: max10(superBeheerders.map((u) => u.primaryEmail)),
      });
    if (superBeheerders.length === 1)
      b.push({
        code: 'gw.beheerders.een',
        onderdeel: 'accounts',
        urgentie: 'warn',
        titel: 'Maar één superbeheerder',
        actie: 'Maak een tweede superbeheerder aan (met tweestapsverificatie), zodat je niet wordt buitengesloten als dit account niet werkt.',
        bewijs: superBeheerders.map((u) => u.primaryEmail),
      });
    const grens = nu.getTime() - 90 * 86_400_000;
    const slapend = actief.filter((u) => {
      const login = u.lastLoginTime ? Date.parse(u.lastLoginTime) : 0;
      const gemaakt = u.creationTime ? Date.parse(u.creationTime) : 0;
      return login < grens && gemaakt < grens;
    });
    if (slapend.length)
      b.push({
        code: 'gw.accounts.slapend',
        onderdeel: 'accounts',
        urgentie: 'warn',
        titel: `${slapend.length} ${slapend.length === 1 ? 'account is' : 'accounts zijn'} al 90 dagen niet gebruikt`,
        actie: 'Schort accounts van oud-medewerkers op of verwijder ze. Een vergeten account is een makkelijke ingang.',
        bewijs: max10(slapend.map((u) => u.primaryEmail)),
      });
  }

  // Domeinen: worden assets, mail-authenticatie (SPF, DKIM met selector "google", DMARC) controleert de domeinscan.
  dek('domeinen', r.domeinen !== null);
  for (const d of r.domeinen ?? []) assets.push({ soort: 'domein', waarde: d.domainName.toLowerCase(), bron: 'Google Workspace', openbaar: true });
  const nietGeverifieerd = (r.domeinen ?? []).filter((d) => d.verified === false);
  if (nietGeverifieerd.length)
    b.push({
      code: 'gw.domein.niet_geverifieerd',
      onderdeel: 'domeinen',
      urgentie: 'warn',
      titel: `${nietGeverifieerd.length} domein${nietGeverifieerd.length === 1 ? '' : 'en'} in Workspace niet geverifieerd`,
      actie: 'Verifieer het domein in de Admin-console of verwijder het als het niet meer in gebruik is.',
      bewijs: nietGeverifieerd.map((d) => d.domainName),
    });

  // Apps van andere partijen met toegang tot mail of Drive
  dek('apps', r.apps !== null);
  if (r.apps) {
    const risico = r.apps.filter((a) => a.scopes.some(isRisico));
    if (risico.length)
      b.push({
        code: 'gw.apps.risico',
        onderdeel: 'apps',
        urgentie: 'warn',
        titel: `${risico.length} ${risico.length === 1 ? 'app van een andere partij heeft' : 'apps van andere partijen hebben'} toegang tot mail of alle bestanden`,
        actie: 'Kijk of je deze apps kent en nog gebruikt. Blokkeer onbekende apps in de Admin-console (Beveiliging → API-beheer → Apps van derden).',
        bewijs: max10(risico.map((a) => `${a.naam} (${a.gebruikers} ${a.gebruikers === 1 ? 'gebruiker' : 'gebruikers'})`)),
      });
  }

  // Instellingen voor Gmail en Drive (per organisatie-eenheid; één keer "aan" telt).
  dek('instellingen', r.instellingen !== null);
  if (r.instellingen) {
    const p = r.instellingen;
    if (instelling(p, 'gmail.auto_forwarding').some((v) => v.enableAutoForwarding === true))
      b.push({
        code: 'gw.gmail.doorsturen',
        onderdeel: 'instellingen',
        urgentie: 'warn',
        titel: 'Medewerkers mogen mail automatisch doorsturen naar buiten',
        actie: 'Zet automatisch doorsturen uit (Apps → Gmail → Gebruikersinstellingen). Inbrekers gebruiken dit om stil mee te lezen.',
        bewijs: [],
      });
    const oud = [
      ...(instelling(p, 'gmail.pop_access').some((v) => v.enablePopAccess === true) ? ['POP'] : []),
      ...(instelling(p, 'gmail.imap_access').some((v) => v.enableImapAccess === true) ? ['IMAP'] : []),
    ];
    if (oud.length)
      b.push({
        code: 'gw.gmail.pop_imap',
        onderdeel: 'instellingen',
        urgentie: 'warn',
        titel: `${oud.join(' en ')} staat aan voor mail`,
        actie: 'Zet POP en IMAP uit als niemand een los mailprogramma gebruikt (Apps → Gmail → Eindgebruikerstoegang).',
        bewijs: [],
      });
    if (instelling(p, 'drive_and_docs.external_sharing').some((v) => v.externalSharingMode === 'ALLOWED' && v.allowPublishingFiles !== false))
      b.push({
        code: 'gw.drive.openbaar',
        onderdeel: 'instellingen',
        urgentie: 'warn',
        titel: 'Drive-bestanden mogen met iedereen op internet gedeeld worden',
        actie: 'Beperk delen tot het eigen domein en vertrouwde partijen (Apps → Drive en Documenten → Instellingen voor delen).',
        bewijs: [],
      });
  }

  return { bevindingen: sorteer(b), dekking, assets, teVeelRechten: r.teVeelRechten };
}
