import { GoogleClient, GoogleFout, redenVan, type Dekking } from './client.ts';
import { max10, sorteer, type GoogleAsset, type GoogleBevinding, type GoogleUitkomst } from './bevinding.ts';

/**
 * Google Cloud, alleen-lezen met de rol Security Reviewer (roles/iam.securityReviewer):
 * openbare IP-adressen, firewallregels naar internet, opslagbuckets met openbare rechten,
 * Cloud Run-diensten en Cloud SQL-databases. Nooit de bestanden in buckets of gegevens
 * in databases: die rechten zitten niet in de rol, en we controleren dat.
 */

/** cloud-platform.read-only is het smalste OAuth-bereik; de echte grens is de IAM-rol. */
export const CLOUD_SCOPES = ['https://www.googleapis.com/auth/cloud-platform.read-only'];

/**
 * Rechten die Qbicle niet nodig heeft. testIamPermissions zegt alleen óf we ze hebben,
 * er wordt niets mee gedaan. Hebben we er één, dan staat de koppeling op "let op".
 */
export const CLOUD_TE_VEEL = [
  { recht: 'storage.objects.get', uitleg: 'bestanden in opslag lezen' },
  { recht: 'storage.objects.create', uitleg: 'bestanden in opslag schrijven' },
  { recht: 'storage.buckets.delete', uitleg: 'opslag verwijderen' },
  { recht: 'compute.instances.delete', uitleg: 'servers verwijderen' },
  { recht: 'compute.firewalls.update', uitleg: 'firewallregels wijzigen' },
  { recht: 'cloudsql.instances.update', uitleg: 'databases wijzigen' },
  { recht: 'iam.serviceAccountKeys.create', uitleg: 'sleutels aanmaken' },
  { recht: 'resourcemanager.projects.setIamPolicy', uitleg: 'rechten in het project wijzigen' },
];

export interface GcpFirewall {
  name: string;
  network?: string;
  direction?: string;
  disabled?: boolean;
  sourceRanges?: string[];
  allowed?: { IPProtocol: string; ports?: string[] }[];
}
export interface GcpInstance {
  name: string;
  zone?: string;
  status?: string;
  networkInterfaces?: { accessConfigs?: { natIP?: string }[] }[];
}
export interface GcpAddress {
  name: string;
  address: string;
  addressType?: string;
  status?: string;
}
export interface GcpBucket {
  name: string;
  location?: string;
  iamConfiguration?: { uniformBucketLevelAccess?: { enabled?: boolean }; publicAccessPrevention?: string };
  /** Leden met rol, uit getIamPolicy. */
  bindings?: { role: string; members: string[] }[];
}
export interface GcpRunService {
  name: string;
  uri?: string;
  ingress?: string;
  bindings?: { role: string; members: string[] }[];
}
export interface GcpSql {
  name: string;
  databaseVersion?: string;
  ipAddresses?: { type?: string; ipAddress?: string }[];
  settings?: {
    ipConfiguration?: { ipv4Enabled?: boolean; authorizedNetworks?: { value?: string; name?: string }[]; requireSsl?: boolean; sslMode?: string };
    backupConfiguration?: { enabled?: boolean };
  };
}

export interface ProjectRuw {
  projectId: string;
  firewalls: GcpFirewall[] | null;
  instances: GcpInstance[] | null;
  adressen: GcpAddress[] | null;
  buckets: GcpBucket[] | null;
  run: GcpRunService[] | null;
  sql: GcpSql[] | null;
  fouten: Record<string, string>;
  teVeelRechten: string[];
}

export interface CloudRuw {
  projecten: ProjectRuw[];
  /** Fout bij het opzoeken van projecten (als er geen project-id's waren opgegeven). */
  fout?: string;
}

const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const STORAGE = 'https://storage.googleapis.com/storage/v1';
const RUN = 'https://run.googleapis.com/v2';
const SQL = 'https://sqladmin.googleapis.com/v1';
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Compute geeft bij aggregated-lijsten een object per zone terug in plaats van een array. */
async function aggregated<T>(c: GoogleClient, url: string, veld: string, max = 2_000): Promise<T[]> {
  const uit: T[] = [];
  let token: string | undefined;
  do {
    const u = new URL(url);
    if (token) u.searchParams.set('pageToken', token);
    const d = await c.get<{ items?: Record<string, Record<string, unknown>>; nextPageToken?: string }>(u.toString());
    for (const groep of Object.values(d.items ?? {})) {
      const xs = groep[veld];
      if (Array.isArray(xs)) uit.push(...(xs as T[]));
    }
    token = d.nextPageToken;
  } while (token && uit.length < max);
  return uit.slice(0, max);
}

export async function leesCloud(c: GoogleClient, projectIds: string[] = []): Promise<CloudRuw> {
  await c.verleendeScopes();
  let ids = projectIds;
  if (!ids.length) {
    try {
      const ps = await c.alles<{ projectId: string }>(`${CRM}/projects?filter=${encodeURIComponent('lifecycleState:ACTIVE')}`, 'projects', 200);
      ids = ps.map((p) => p.projectId);
    } catch (e) {
      return { projecten: [], fout: redenVan(e) };
    }
    if (!ids.length) return { projecten: [], fout: 'Geen projecten gevonden waar Qbicle de rol Security Reviewer heeft.' };
  }
  const projecten: ProjectRuw[] = [];
  for (const id of ids.slice(0, 50)) {
    if (!PROJECT_ID.test(id)) throw new GoogleFout('overig', `Ongeldige project-id: ${id}`);
    projecten.push(await leesProject(c, id));
  }
  return { projecten };
}

async function leesProject(c: GoogleClient, p: string): Promise<ProjectRuw> {
  const fouten: Record<string, string> = {};
  const poging = async <T>(onderdeel: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      fouten[onderdeel] = redenVan(e);
      return null;
    }
  };
  const firewalls = await poging('firewall', () => c.alles<GcpFirewall>(`${COMPUTE}/projects/${p}/global/firewalls`, 'items'));
  const instances = await poging('servers', () => aggregated<GcpInstance>(c, `${COMPUTE}/projects/${p}/aggregated/instances`, 'instances'));
  const adressen = await poging('ip-adressen', () => aggregated<GcpAddress>(c, `${COMPUTE}/projects/${p}/aggregated/addresses`, 'addresses'));
  const buckets = await poging('opslag', async () => {
    const bs = await c.alles<GcpBucket>(`${STORAGE}/b?project=${p}&projection=noAcl`, 'items', 500);
    for (const b of bs) {
      // Alleen de rechten van de bucket, niet de inhoud. Lukt het niet, dan blijft bindings leeg en zeggen we dat.
      b.bindings = await c
        .get<{ bindings?: { role: string; members: string[] }[] }>(`${STORAGE}/b/${encodeURIComponent(b.name)}/iam`)
        .then((x) => x.bindings ?? [])
        .catch(() => undefined);
    }
    return bs;
  });
  const run = await poging('cloud-run', async () => {
    const ss = await c.alles<GcpRunService>(`${RUN}/projects/${p}/locations/-/services`, 'services', 500);
    for (const s of ss) {
      s.bindings = await c
        .get<{ bindings?: { role: string; members: string[] }[] }>(`${RUN}/${s.name}:getIamPolicy`)
        .then((x) => x.bindings ?? [])
        .catch(() => undefined);
    }
    return ss;
  });
  const sql = await poging('databases', () => c.alles<GcpSql>(`${SQL}/projects/${p}/instances`, 'items', 500));

  const teVeelRechten: string[] = [];
  try {
    const r = await c.post<{ permissions?: string[] }>(`${CRM}/projects/${p}:testIamPermissions`, { permissions: CLOUD_TE_VEEL.map((x) => x.recht) });
    for (const recht of r.permissions ?? []) {
      const t = CLOUD_TE_VEEL.find((x) => x.recht === recht);
      teVeelRechten.push(`${recht} (${t?.uitleg ?? 'niet nodig'})`);
    }
  } catch (e) {
    fouten['rechten'] = redenVan(e);
  }
  return { projectId: p, firewalls, instances, adressen, buckets, run, sql, fouten, teVeelRechten };
}

const IEDEREEN = new Set(['allUsers', 'allAuthenticatedUsers']);
const isInternet = (r: string) => r === '0.0.0.0/0' || r === '::/0';

/** Poorten die je nooit open voor heel internet wilt (beheer, databases), met naam. */
const GEVAARLIJK: Record<number, string> = {
  22: 'SSH',
  23: 'Telnet',
  3389: 'extern bureaublad (RDP)',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  1433: 'SQL Server',
  27017: 'MongoDB',
  6379: 'Redis',
  9200: 'Elasticsearch',
  5900: 'VNC',
  445: 'Windows-bestandsdeling (SMB)',
};

/** Welke gevaarlijke poorten opent een firewallregel? 'alles' als alle poorten open staan. */
export function openPoorten(f: GcpFirewall): string[] {
  const uit = new Set<string>();
  for (const a of f.allowed ?? []) {
    const proto = a.IPProtocol.toLowerCase();
    if (proto === 'all' || ((proto === 'tcp' || proto === 'udp' || proto === '6' || proto === '17') && !a.ports?.length)) {
      uit.add('alle poorten');
      continue;
    }
    if (proto !== 'tcp' && proto !== '6') continue;
    for (const p of a.ports ?? []) {
      const [van, tot] = p.split('-').map(Number);
      if (van === undefined || Number.isNaN(van)) continue;
      const eind = tot ?? van;
      for (const [poort, naam] of Object.entries(GEVAARLIJK)) {
        const n = Number(poort);
        if (n >= van && n <= eind) uit.add(`${n} (${naam})`);
      }
    }
  }
  return [...uit];
}

export function beoordeelCloud(r: CloudRuw): GoogleUitkomst {
  const b: GoogleBevinding[] = [];
  const dekking: Dekking[] = [];
  const assets: GoogleAsset[] = [];
  const teVeel: string[] = [];

  if (r.fout) dekking.push({ onderdeel: 'projecten', status: 'niet_gecontroleerd', reden: r.fout });

  const verzamel = {
    bucketsOpenbaar: [] as string[],
    bucketsOnbekend: [] as string[],
    bucketsGeenUniform: [] as string[],
    firewallKritiek: [] as string[],
    firewallSsh: [] as string[],
    sqlOpen: [] as string[],
    sqlZonderTls: [] as string[],
    sqlZonderBackup: [] as string[],
    runOpenbaar: [] as string[],
  };

  for (const p of r.projecten) {
    const dek = (onderdeel: string, ok: boolean) =>
      dekking.push(ok ? { onderdeel: `${p.projectId}: ${onderdeel}` , status: 'gecontroleerd' } : { onderdeel: `${p.projectId}: ${onderdeel}`, status: 'niet_gecontroleerd', reden: p.fouten[onderdeel] ?? 'Niet gelezen.' });
    for (const x of p.teVeelRechten) teVeel.push(`${p.projectId}: ${x}`);

    dek('firewall', p.firewalls !== null);
    for (const f of p.firewalls ?? []) {
      if (f.disabled || (f.direction ?? 'INGRESS') !== 'INGRESS' || !(f.sourceRanges ?? []).some(isInternet)) continue;
      const open = openPoorten(f);
      const alleenSsh = open.length === 1 && open[0]!.startsWith('22 ');
      if (alleenSsh) verzamel.firewallSsh.push(`${p.projectId}/${f.name}`);
      else if (open.length) verzamel.firewallKritiek.push(`${p.projectId}/${f.name}: ${open.join(', ')}`);
    }

    dek('servers', p.instances !== null);
    for (const i of p.instances ?? [])
      for (const ni of i.networkInterfaces ?? [])
        for (const ac of ni.accessConfigs ?? [])
          if (ac.natIP) assets.push({ soort: 'server', waarde: ac.natIP, bron: `Google Cloud ${p.projectId}: server ${i.name}`, openbaar: true });

    dek('ip-adressen', p.adressen !== null);
    for (const a of p.adressen ?? [])
      if ((a.addressType ?? 'EXTERNAL') === 'EXTERNAL' && !assets.some((x) => x.waarde === a.address))
        assets.push({ soort: 'ip', waarde: a.address, bron: `Google Cloud ${p.projectId}: vast IP ${a.name}${a.status === 'RESERVED' ? ' (niet in gebruik)' : ''}`, openbaar: true });

    dek('opslag', p.buckets !== null);
    for (const bk of p.buckets ?? []) {
      const naam = `${p.projectId}/${bk.name}`;
      const voorkomen = bk.iamConfiguration?.publicAccessPrevention === 'enforced';
      const openbaar = !voorkomen && (bk.bindings ?? []).some((x) => x.members.some((m) => IEDEREEN.has(m)));
      assets.push({ soort: 'bucket', waarde: `gs://${bk.name}`, bron: `Google Cloud ${p.projectId}`, openbaar });
      if (openbaar) verzamel.bucketsOpenbaar.push(naam);
      else if (bk.bindings === undefined && !voorkomen) verzamel.bucketsOnbekend.push(naam);
      if (bk.iamConfiguration?.uniformBucketLevelAccess?.enabled === false && !voorkomen) verzamel.bucketsGeenUniform.push(naam);
    }

    dek('cloud-run', p.run !== null);
    for (const s of p.run ?? []) {
      const kort = s.name.split('/').pop() ?? s.name;
      const vanInternet = (s.ingress ?? 'INGRESS_TRAFFIC_ALL') === 'INGRESS_TRAFFIC_ALL';
      const zonderLogin = (s.bindings ?? []).some((x) => x.role === 'roles/run.invoker' && x.members.some((m) => IEDEREEN.has(m)));
      if (s.uri) assets.push({ soort: 'url', waarde: s.uri, bron: `Google Cloud ${p.projectId}: Cloud Run ${kort}`, openbaar: vanInternet && zonderLogin });
      if (vanInternet && zonderLogin) verzamel.runOpenbaar.push(`${p.projectId}/${kort}${s.uri ? ` (${s.uri})` : ''}`);
    }

    dek('databases', p.sql !== null);
    for (const d of p.sql ?? []) {
      const naam = `${p.projectId}/${d.name}`;
      const ip = d.settings?.ipConfiguration;
      const publiek = ip?.ipv4Enabled !== false && (d.ipAddresses ?? []).some((x) => x.type === 'PRIMARY');
      for (const a of d.ipAddresses ?? []) if (a.type === 'PRIMARY' && a.ipAddress) assets.push({ soort: 'database', waarde: a.ipAddress, bron: `Google Cloud ${naam} (${d.databaseVersion ?? 'Cloud SQL'})`, openbaar: true });
      if (publiek && (ip?.authorizedNetworks ?? []).some((n) => n.value && isInternet(n.value))) verzamel.sqlOpen.push(naam);
      const tls = ip?.sslMode ? ip.sslMode !== 'ALLOW_UNENCRYPTED_AND_ENCRYPTED' : ip?.requireSsl === true;
      if (publiek && !tls) verzamel.sqlZonderTls.push(naam);
      if (d.settings?.backupConfiguration?.enabled === false) verzamel.sqlZonderBackup.push(naam);
    }
  }

  const v = verzamel;
  if (v.bucketsOpenbaar.length)
    b.push({ code: 'gc.opslag.openbaar', onderdeel: 'opslag', urgentie: 'crit', titel: `${v.bucketsOpenbaar.length} opslagbucket${v.bucketsOpenbaar.length === 1 ? ' is' : 's zijn'} leesbaar voor iedereen`, actie: 'Haal "allUsers" en "allAuthenticatedUsers" weg bij de rechten van de bucket en zet "Openbare toegang voorkomen" aan, tenzij de bestanden bewust openbaar zijn (zoals afbeeldingen van een website).', bewijs: max10(v.bucketsOpenbaar) });
  if (v.firewallKritiek.length)
    b.push({ code: 'gc.firewall.open', onderdeel: 'firewall', urgentie: 'crit', titel: `${v.firewallKritiek.length} firewallregel${v.firewallKritiek.length === 1 ? ' zet' : 's zetten'} beheer- of databasepoorten open voor heel internet`, actie: 'Sta deze poorten alleen toe vanaf het IP-adres van kantoor of via een VPN of Identity-Aware Proxy.', bewijs: max10(v.firewallKritiek) });
  if (v.sqlOpen.length)
    b.push({ code: 'gc.sql.open', onderdeel: 'databases', urgentie: 'crit', titel: `${v.sqlOpen.length} database${v.sqlOpen.length === 1 ? ' is' : 's zijn'} bereikbaar vanaf heel internet`, actie: 'Haal 0.0.0.0/0 weg uit "Geautoriseerde netwerken", of gebruik alleen een privé-IP.', bewijs: max10(v.sqlOpen) });
  if (v.firewallSsh.length)
    b.push({ code: 'gc.firewall.ssh', onderdeel: 'firewall', urgentie: 'warn', titel: `SSH (poort 22) open voor heel internet in ${v.firewallSsh.length} regel${v.firewallSsh.length === 1 ? '' : 's'}`, actie: 'Gebruik Identity-Aware Proxy voor SSH (bron 35.235.240.0/20) of beperk tot het IP-adres van kantoor.', bewijs: max10(v.firewallSsh) });
  if (v.sqlZonderTls.length)
    b.push({ code: 'gc.sql.tls', onderdeel: 'databases', urgentie: 'warn', titel: `${v.sqlZonderTls.length} database${v.sqlZonderTls.length === 1 ? ' accepteert' : 's accepteren'} onversleutelde verbindingen`, actie: 'Zet in Cloud SQL → Verbindingen "Alleen versleutelde verbindingen toestaan" aan.', bewijs: max10(v.sqlZonderTls) });
  if (v.sqlZonderBackup.length)
    b.push({ code: 'gc.sql.backup', onderdeel: 'databases', urgentie: 'warn', titel: `${v.sqlZonderBackup.length} database${v.sqlZonderBackup.length === 1 ? '' : 's'} zonder automatische back-up`, actie: 'Zet automatische back-ups aan in Cloud SQL → Back-ups.', bewijs: max10(v.sqlZonderBackup) });
  if (v.bucketsGeenUniform.length)
    b.push({ code: 'gc.opslag.uniform', onderdeel: 'opslag', urgentie: 'warn', titel: `${v.bucketsGeenUniform.length} bucket${v.bucketsGeenUniform.length === 1 ? '' : 's'} met rechten per bestand`, actie: 'Zet "Uniforme toegang op bucketniveau" aan. Rechten per bestand kunnen we niet zien zonder de bestanden te openen, en zijn makkelijk te vergeten.', bewijs: max10(v.bucketsGeenUniform) });
  if (v.bucketsOnbekend.length)
    b.push({ code: 'gc.opslag.onbekend', onderdeel: 'opslag', urgentie: 'warn', titel: `Van ${v.bucketsOnbekend.length} bucket${v.bucketsOnbekend.length === 1 ? '' : 's'} konden we de rechten niet lezen`, actie: 'Controleer of Qbicle de rol Security Reviewer heeft op het hele project.', bewijs: max10(v.bucketsOnbekend) });
  if (v.runOpenbaar.length)
    b.push({ code: 'gc.run.openbaar', onderdeel: 'cloud-run', urgentie: 'ok', titel: `${v.runOpenbaar.length} Cloud Run-dienst${v.runOpenbaar.length === 1 ? ' is' : 'en zijn'} openbaar bereikbaar`, actie: 'Prima als het een website of openbare API is. We nemen het adres mee in de scan.', bewijs: max10(v.runOpenbaar) });

  return { bevindingen: sorteer(b), dekking, assets, teVeelRechten: teVeel };
}
