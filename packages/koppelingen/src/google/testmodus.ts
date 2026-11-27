import { generateKeyPairSync } from 'node:crypto';
import { GoogleClient, type Fetch, type ServiceAccountSleutel } from './client.ts';
import { CLOUD_SCOPES, type CloudRuw, type GcpAddress, type GcpBucket, type GcpFirewall, type GcpInstance, type GcpRunService, type GcpSql } from './cloud.ts';
import { appsUitTokens, WORKSPACE_SCOPES, type WorkspaceRuw } from './workspace.ts';

/**
 * Testmodus (QBICLE_GOOGLE=test of --test): een nagebootste Google zonder netwerk.
 * De hele leesroute draait echt (token, paginering, foutafhandeling), alleen de
 * antwoorden komen uit de voorbeelden hieronder. Niets hiervan is echte data.
 */

export type TestVariant = 'normaal' | 'te_veel_rechten';

const NU = new Date('2026-11-27T10:00:00Z');
const dagenTerug = (d: number) => new Date(NU.getTime() - d * 86_400_000).toISOString();

const GEBRUIKERS = [
  { primaryEmail: 'eigenaar@voorbeeld.nl', isAdmin: true, isEnrolledIn2Sv: true, isEnforcedIn2Sv: false, lastLoginTime: dagenTerug(1), creationTime: dagenTerug(900) },
  { primaryEmail: 'it@voorbeeld.nl', isAdmin: true, isEnrolledIn2Sv: false, isEnforcedIn2Sv: false, lastLoginTime: dagenTerug(3), creationTime: dagenTerug(800) },
  { primaryEmail: 'boekhouding@voorbeeld.nl', isDelegatedAdmin: true, isEnrolledIn2Sv: true, lastLoginTime: dagenTerug(2), creationTime: dagenTerug(700) },
  { primaryEmail: 'sanne@voorbeeld.nl', isEnrolledIn2Sv: true, lastLoginTime: dagenTerug(0), creationTime: dagenTerug(400) },
  { primaryEmail: 'joost@voorbeeld.nl', isEnrolledIn2Sv: false, lastLoginTime: dagenTerug(5), creationTime: dagenTerug(300) },
  { primaryEmail: 'stagiair2025@voorbeeld.nl', isEnrolledIn2Sv: false, lastLoginTime: dagenTerug(200), creationTime: dagenTerug(400) },
  { primaryEmail: 'oud-medewerker@voorbeeld.nl', suspended: true, isEnrolledIn2Sv: false, lastLoginTime: dagenTerug(500), creationTime: dagenTerug(1000) },
];

const DOMEINEN = [
  { domainName: 'voorbeeld.nl', verified: true, isPrimary: true },
  { domainName: 'voorbeeld-shop.nl', verified: true, isPrimary: false },
  { domainName: 'oude-naam.nl', verified: false, isPrimary: false },
];

const TOKENS = [
  {
    actor: { email: 'sanne@voorbeeld.nl' },
    events: [{ name: 'authorize', parameters: [{ name: 'client_id', value: '111.apps.googleusercontent.com' }, { name: 'app_name', value: 'Slack' }, { name: 'scope', multiValue: ['openid', 'email'] }] }],
  },
  {
    actor: { email: 'joost@voorbeeld.nl' },
    events: [{ name: 'authorize', parameters: [{ name: 'client_id', value: '222.apps.googleusercontent.com' }, { name: 'app_name', value: 'MailMerge Pro' }, { name: 'scope', multiValue: ['https://mail.google.com/'] }] }],
  },
  {
    actor: { email: 'boekhouding@voorbeeld.nl' },
    events: [{ name: 'authorize', parameters: [{ name: 'client_id', value: '333.apps.googleusercontent.com' }, { name: 'app_name', value: 'PDF Tools Online' }, { name: 'scope', multiValue: ['https://www.googleapis.com/auth/drive'] }] }],
  },
];

const POLICIES = [
  { policyQuery: { orgUnit: 'orgUnits/root' }, setting: { type: 'settings/gmail.auto_forwarding', value: { enableAutoForwarding: true } } },
  { policyQuery: { orgUnit: 'orgUnits/root' }, setting: { type: 'settings/gmail.pop_access', value: { enablePopAccess: false } } },
  { policyQuery: { orgUnit: 'orgUnits/root' }, setting: { type: 'settings/gmail.imap_access', value: { enableImapAccess: true } } },
  { policyQuery: { orgUnit: 'orgUnits/root' }, setting: { type: 'settings/drive_and_docs.external_sharing', value: { externalSharingMode: 'ALLOWED', allowPublishingFiles: true } } },
];

const PROJECT = 'voorbeeld-webshop';

const CLOUD: Record<string, unknown> = {
  [`/v1/projects`]: { projects: [{ projectId: PROJECT }] },
  [`/compute/v1/projects/${PROJECT}/global/firewalls`]: {
    items: [
      { name: 'default-allow-ssh', direction: 'INGRESS', sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }] },
      { name: 'default-allow-rdp', direction: 'INGRESS', sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['3389'] }] },
      { name: 'web', direction: 'INGRESS', sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['80', '443'] }] },
      { name: 'intern', direction: 'INGRESS', sourceRanges: ['10.128.0.0/9'], allowed: [{ IPProtocol: 'all' }] },
    ],
  },
  [`/compute/v1/projects/${PROJECT}/aggregated/instances`]: {
    items: {
      'zones/europe-west4-a': { instances: [{ name: 'webserver-1', status: 'RUNNING', networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }] }] },
      'zones/europe-west4-b': { warning: { code: 'NO_RESULTS_ON_PAGE' } },
    },
  },
  [`/compute/v1/projects/${PROJECT}/aggregated/addresses`]: {
    items: { 'regions/europe-west4': { addresses: [{ name: 'web-ip', address: '203.0.113.10', addressType: 'EXTERNAL', status: 'IN_USE' }, { name: 'oud-ip', address: '203.0.113.99', addressType: 'EXTERNAL', status: 'RESERVED' }] } },
  },
  [`/storage/v1/b`]: {
    items: [
      { name: 'voorbeeld-facturen-backup', iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'inherited' } },
      { name: 'voorbeeld-website-afbeeldingen', iamConfiguration: { uniformBucketLevelAccess: { enabled: false }, publicAccessPrevention: 'inherited' } },
      { name: 'voorbeeld-logs', iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } },
    ],
  },
  [`/storage/v1/b/voorbeeld-facturen-backup/iam`]: { bindings: [{ role: 'roles/storage.objectViewer', members: ['allUsers'] }] },
  [`/storage/v1/b/voorbeeld-website-afbeeldingen/iam`]: { bindings: [{ role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:voorbeeld-webshop'] }] },
  [`/storage/v1/b/voorbeeld-logs/iam`]: { bindings: [] },
  [`/v2/projects/${PROJECT}/locations/-/services`]: {
    services: [{ name: `projects/${PROJECT}/locations/europe-west4/services/shop-api`, uri: 'https://shop-api-abc123-ez.a.run.app', ingress: 'INGRESS_TRAFFIC_ALL' }],
  },
  [`/v2/projects/${PROJECT}/locations/europe-west4/services/shop-api:getIamPolicy`]: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
  [`/v1/projects/${PROJECT}/instances`]: {
    items: [
      {
        name: 'shop-db',
        databaseVersion: 'MYSQL_8_0',
        ipAddresses: [{ type: 'PRIMARY', ipAddress: '203.0.113.20' }],
        settings: { ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [{ name: 'iedereen', value: '0.0.0.0/0' }], sslMode: 'ALLOW_UNENCRYPTED_AND_ENCRYPTED' }, backupConfiguration: { enabled: false } },
      },
    ],
  },
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Scope uit de JWT halen (handtekening controleren we in de nep-Google niet). */
function scopesUitJwt(body: string): string[] {
  const assertion = new URLSearchParams(body).get('assertion') ?? '';
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()) as { scope?: string };
  return (claims.scope ?? '').split(' ');
}

export function testFetch(variant: TestVariant = 'normaal'): Fetch {
  const toegestaan = new Set([...WORKSPACE_SCOPES, ...CLOUD_SCOPES]);
  if (variant === 'te_veel_rechten') toegestaan.add('https://www.googleapis.com/auth/drive.readonly');
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'oauth2.googleapis.com') {
      const scopes = scopesUitJwt(String(init?.body ?? ''));
      if (!scopes.every((s) => toegestaan.has(s))) return json(401, { error: 'unauthorized_client' });
      return json(200, { access_token: 'test-token', expires_in: 3600, scope: scopes.join(' '), token_type: 'Bearer' });
    }
    const pad = url.pathname;
    if (url.hostname === 'admin.googleapis.com') {
      if (pad.endsWith('/users')) {
        // Twee pagina's, om de paginering te testen.
        if (!url.searchParams.get('pageToken')) return json(200, { users: GEBRUIKERS.slice(0, 4), nextPageToken: 'p2' });
        return json(200, { users: GEBRUIKERS.slice(4) });
      }
      if (pad.endsWith('/domains')) return json(200, { domains: DOMEINEN });
      if (pad.includes('/applications/token')) return json(200, { items: TOKENS });
    }
    if (url.hostname === 'cloudidentity.googleapis.com') return json(200, { policies: POLICIES });
    if (url.hostname === 'cloudresourcemanager.googleapis.com' && pad.endsWith(':testIamPermissions')) {
      return json(200, variant === 'te_veel_rechten' ? { permissions: ['storage.objects.get'] } : {});
    }
    const d = CLOUD[pad];
    if (d) return json(200, d);
    return json(404, { error: { message: `Niet in de testdata: ${pad}` } });
  }) as Fetch;
}

let testSleutel: ServiceAccountSleutel | undefined;
/** Een wegwerpsleutel die alleen in het geheugen bestaat, zodat de JWT echt ondertekend wordt. */
export function testSleutelVoorTestmodus(): ServiceAccountSleutel {
  if (!testSleutel) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    testSleutel = { client_email: 'qbicle-test@voorbeeld.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  }
  return testSleutel;
}

export function testClient(soort: 'workspace' | 'cloud', variant: TestVariant = 'normaal'): GoogleClient {
  return new GoogleClient({
    sleutel: testSleutelVoorTestmodus(),
    scopes: soort === 'workspace' ? WORKSPACE_SCOPES : CLOUD_SCOPES,
    namens: soort === 'workspace' ? 'eigenaar@voorbeeld.nl' : undefined,
    fetch: testFetch(variant),
    nu: () => NU,
  });
}

export const TEST_NU = NU;

/**
 * Dezelfde voorbeelddata, direct als ruwe uitkomst (zonder nagebootst netwerk),
 * voor de teststand van de klantpagina Koppelingen, die synchroon werkt.
 */
export function testRuwWorkspace(): WorkspaceRuw {
  return { gebruikers: structuredClone(GEBRUIKERS), domeinen: structuredClone(DOMEINEN), apps: appsUitTokens(TOKENS), instellingen: structuredClone(POLICIES), fouten: {}, teVeelRechten: [] };
}

export function testRuwCloud(): CloudRuw {
  const c = structuredClone(CLOUD) as Record<string, { items?: unknown; services?: unknown; bindings?: unknown }>;
  const p = (pad: string) => c[pad]!;
  const lijst = <T>(pad: string, veld: string) => Object.values((p(pad).items ?? {}) as Record<string, Record<string, T[]>>).flatMap((g) => g[veld] ?? []);
  const buckets = (p('/storage/v1/b').items as GcpBucket[]).map((b) => ({ ...b, bindings: p(`/storage/v1/b/${b.name}/iam`).bindings as GcpBucket['bindings'] }));
  const run = (p(`/v2/projects/${PROJECT}/locations/-/services`).services as GcpRunService[]).map((s) => ({ ...s, bindings: p(`/v2/${s.name}:getIamPolicy`).bindings as GcpRunService['bindings'] }));
  return {
    projecten: [
      {
        projectId: PROJECT,
        firewalls: p(`/compute/v1/projects/${PROJECT}/global/firewalls`).items as GcpFirewall[],
        instances: lijst<GcpInstance>(`/compute/v1/projects/${PROJECT}/aggregated/instances`, 'instances'),
        adressen: lijst<GcpAddress>(`/compute/v1/projects/${PROJECT}/aggregated/addresses`, 'addresses'),
        buckets,
        run,
        sql: p(`/v1/projects/${PROJECT}/instances`).items as GcpSql[],
        fouten: {},
        teVeelRechten: [],
      },
    ],
  };
}
