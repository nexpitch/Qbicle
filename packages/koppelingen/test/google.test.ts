import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  beoordeelCloud,
  beoordeelWorkspace,
  CLOUD_SCOPES,
  GoogleClient,
  GoogleFout,
  KoppelingenTeststand,
  leesCloud,
  leesSleutel,
  leesWorkspace,
  maakJwt,
  openPoorten,
  TEST_NU,
  testClient,
  testFetch,
  testSleutelVoorTestmodus,
  VERBODEN_RECHTEN,
  WORKSPACE_SCOPES,
  type Fetch,
} from '../src/index.ts';

const codes = (u: { bevindingen: { code: string }[] }) => u.bevindingen.map((b) => b.code);

describe('Google: scopes', () => {
  it('vraagt alleen readonly-scopes en nooit Gmail- of Drive-inhoud', () => {
    for (const s of [...WORKSPACE_SCOPES, ...CLOUD_SCOPES]) {
      expect(s, s).toMatch(/readonly|read-only/);
      const kort = s.replace('https://www.googleapis.com/auth/', '');
      for (const re of VERBODEN_RECHTEN) expect(re.test(kort), s).toBe(false);
    }
  });
});

describe('Google: sleutel en JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('leest alleen serviceaccount-sleutels', () => {
    expect(() => leesSleutel('{"type":"authorized_user"}')).toThrow(GoogleFout);
    expect(() => leesSleutel('geen json')).toThrow(/geen geldige JSON/);
    expect(leesSleutel(JSON.stringify({ type: 'service_account', client_email: 'a@b.iam.gserviceaccount.com', private_key: pem })).client_email).toBe('a@b.iam.gserviceaccount.com');
  });

  it('ondertekent de JWT met RS256 en zet sub alleen voor Workspace', () => {
    const jwt = maakJwt({ client_email: 'qb@x.iam.gserviceaccount.com', private_key: pem }, WORKSPACE_SCOPES, 'admin@voorbeeld.nl', TEST_NU);
    const [kop, claims, sig] = jwt.split('.');
    expect(createVerify('RSA-SHA256').update(`${kop}.${claims}`).verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    const c = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    expect(c).toMatchObject({ iss: 'qb@x.iam.gserviceaccount.com', sub: 'admin@voorbeeld.nl', aud: 'https://oauth2.googleapis.com/token' });
    expect(c.exp - c.iat).toBe(3600);
    const zonder = JSON.parse(Buffer.from(maakJwt({ client_email: 'x', private_key: pem }, CLOUD_SCOPES, undefined, TEST_NU).split('.')[1]!, 'base64url').toString());
    expect(zonder.sub).toBeUndefined();
  });

  it('praat alleen met googleapis.com', async () => {
    const c = testClient('cloud');
    await expect(c.get('https://evil.example/x')).rejects.toThrow(/Alleen Google/);
    await expect(c.get('http://compute.googleapis.com/x')).rejects.toThrow(/Alleen Google/);
  });
});

describe('Google Workspace (testmodus)', () => {
  it('leest via de nagebootste Google en beoordeelt in gewone taal', async () => {
    const u = beoordeelWorkspace(await leesWorkspace(testClient('workspace'), TEST_NU), TEST_NU);
    expect(codes(u)).toEqual(
      expect.arrayContaining(['gw.2sv.beheerders', 'gw.2sv.accounts', 'gw.2sv.niet_verplicht', 'gw.accounts.slapend', 'gw.apps.risico', 'gw.gmail.doorsturen', 'gw.gmail.pop_imap', 'gw.drive.openbaar', 'gw.domein.niet_geverifieerd']),
    );
    expect(u.bevindingen[0]!.urgentie).toBe('crit');
    const accounts = u.bevindingen.find((b) => b.code === 'gw.2sv.accounts')!;
    // Opgeschort account telt niet mee; beheerder staat in een eigen bevinding.
    expect(accounts.titel).toBe('2 van de 6 accounts loggen in zonder tweestapsverificatie');
    expect(accounts.bewijs).not.toContain('oud-medewerker@voorbeeld.nl');
    expect(u.bevindingen.find((b) => b.code === 'gw.apps.risico')!.bewijs.join()).not.toContain('Slack');
    expect(u.bevindingen.find((b) => b.code === 'gw.gmail.pop_imap')!.titel).toBe('IMAP staat aan voor mail');
    expect(u.assets.map((a) => a.waarde)).toEqual(['voorbeeld.nl', 'voorbeeld-shop.nl', 'oude-naam.nl']);
    expect(u.dekking.every((d) => d.status === 'gecontroleerd')).toBe(true);
    expect(u.teVeelRechten).toEqual([]);
  });

  it('meldt te veel rechten als Google ons een token voor Drive-inhoud geeft', async () => {
    const u = beoordeelWorkspace(await leesWorkspace(testClient('workspace', 'te_veel_rechten'), TEST_NU), TEST_NU);
    expect(u.teVeelRechten).toEqual(['https://www.googleapis.com/auth/drive.readonly (bestanden in Drive lezen)']);
  });

  it('eerlijke dekking: onderdeel zonder recht is "niet gecontroleerd", niet "in orde"', async () => {
    const basis = testFetch();
    // Policy API weigert: instellingen niet gecontroleerd, rest wel.
    const f: Fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('cloudidentity')) return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 });
      return basis(input, init);
    }) as Fetch;
    const c = new GoogleClient({ sleutel: testSleutelVoorTestmodus(), scopes: WORKSPACE_SCOPES, namens: 'a@voorbeeld.nl', fetch: f, nu: () => TEST_NU });
    const u = beoordeelWorkspace(await leesWorkspace(c, TEST_NU), TEST_NU);
    expect(u.dekking.find((d) => d.onderdeel === 'instellingen')).toEqual({ onderdeel: 'instellingen', status: 'niet_gecontroleerd', reden: 'Geen leesrecht voor dit onderdeel.' });
    expect(codes(u)).not.toContain('gw.gmail.doorsturen');
    expect(codes(u)).toContain('gw.2sv.accounts');
  });

  it('alles in orde: groene bevinding, geen waarschuwingen', () => {
    const u = beoordeelWorkspace(
      {
        gebruikers: [
          { primaryEmail: 'a@x.nl', isAdmin: true, isEnrolledIn2Sv: true, isEnforcedIn2Sv: true, lastLoginTime: TEST_NU.toISOString(), creationTime: TEST_NU.toISOString() },
          { primaryEmail: 'b@x.nl', isAdmin: true, isEnrolledIn2Sv: true, isEnforcedIn2Sv: true, lastLoginTime: TEST_NU.toISOString(), creationTime: TEST_NU.toISOString() },
        ],
        domeinen: [],
        apps: [],
        instellingen: [],
        fouten: {},
        teVeelRechten: [],
      },
      TEST_NU,
    );
    expect(codes(u)).toEqual(['gw.2sv.ok']);
  });
});

describe('Google Cloud (testmodus)', () => {
  it('vindt openbare opslag, open poorten en databases, en de assets', async () => {
    const u = beoordeelCloud(await leesCloud(testClient('cloud')));
    expect(codes(u)).toEqual(['gc.opslag.openbaar', 'gc.firewall.open', 'gc.sql.open', 'gc.firewall.ssh', 'gc.sql.tls', 'gc.sql.backup', 'gc.opslag.uniform', 'gc.run.openbaar']);
    expect(u.bevindingen.find((b) => b.code === 'gc.opslag.openbaar')!.bewijs).toEqual(['voorbeeld-webshop/voorbeeld-facturen-backup']);
    // publicAccessPrevention=enforced: niet openbaar en geen waarschuwing.
    expect(u.assets.find((a) => a.waarde === 'gs://voorbeeld-logs')!.openbaar).toBe(false);
    expect(u.assets.filter((a) => a.soort === 'server' || a.soort === 'ip').map((a) => a.waarde)).toEqual(['203.0.113.10', '203.0.113.99']);
    expect(u.assets.find((a) => a.soort === 'url')!.waarde).toBe('https://shop-api-abc123-ez.a.run.app');
    expect(u.teVeelRechten).toEqual([]);
  });

  it('zoekt zelf projecten als er geen project-id is, en meldt te veel rechten', async () => {
    const r = await leesCloud(testClient('cloud', 'te_veel_rechten'));
    expect(r.projecten.map((p) => p.projectId)).toEqual(['voorbeeld-webshop']);
    expect(beoordeelCloud(r).teVeelRechten).toEqual(['voorbeeld-webshop: storage.objects.get (bestanden in opslag lezen)']);
  });

  it('weigert vreemde project-id’s', async () => {
    await expect(leesCloud(testClient('cloud'), ['../../evil'])).rejects.toThrow(/Ongeldige project-id/);
  });

  it('herkent gevaarlijke poorten in reeksen en "alles"', () => {
    expect(openPoorten({ name: 'x', allowed: [{ IPProtocol: 'tcp', ports: ['3000-4000'] }] })).toEqual(['3306 (MySQL)', '3389 (extern bureaublad (RDP))']);
    expect(openPoorten({ name: 'x', allowed: [{ IPProtocol: 'all' }] })).toEqual(['alle poorten']);
    expect(openPoorten({ name: 'x', allowed: [{ IPProtocol: 'tcp', ports: ['443'] }] })).toEqual([]);
    expect(openPoorten({ name: 'x', allowed: [{ IPProtocol: 'icmp' }] })).toEqual([]);
  });
});

describe('teststand: Google gebruikt de echte beoordeling', () => {
  it('laat bevindingen uit de voorbeelddata zien', () => {
    const t = new KoppelingenTeststand(() => TEST_NU);
    t.starten('o', 'google-workspace', 'mkb', 'x');
    const s = t.testToestemming('o', 'google-workspace', 'gelukt');
    expect(s.bevindingen.some((b) => b.titel.includes('doorsturen'))).toBe(true);
    t.starten('o', 'google-cloud', 'business', 'x');
    const c = t.testToestemming('o', 'google-cloud', 'te_veel_rechten');
    expect(c.status).toBe('let_op');
    expect(c.verleendeRechten).toContain('roles/storage.objectViewer');
    expect(c.bevindingen[0]!.urgentie).toBe('crit');
  });
});
