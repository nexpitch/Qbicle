import { extractToken } from '@qbicle/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createApi, SESSION_COOKIE } from '../src/app.ts';

const ORIGIN = 'https://app.qbicle.test';

describe.skipIf(!hasDb)('API v1', () => {
  let p: TestPlatform;
  let api: ReturnType<typeof createApi>;

  beforeAll(async () => {
    p = await createTestPlatform();
    api = createApi(p, { secureCookies: true, trustProxy: false });
  });
  afterAll(async () => p?.close());

  type JsonResponse = Omit<Response, 'json'> & { json(): Promise<any> };
  function call(
    method: string,
    path: string,
    opts: { body?: unknown; cookie?: string; origin?: string | null; contentType?: string } = {},
  ): Promise<JsonResponse> {
    const headers: Record<string, string> = {};
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (opts.body !== undefined) headers['content-type'] = opts.contentType ?? 'application/json';
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
    return Promise.resolve(
      api.request(`/api/v1${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
      }),
    ) as Promise<JsonResponse>;
  }

  async function signIn(email: string): Promise<string> {
    expect((await call('POST', '/auth/inloglink', { body: { email } })).status).toBe(202);
    const token = extractToken(p.mailer.last(email)!.text, 'qbl_')!;
    const res = await call('POST', '/auth/inloggen', { body: { token } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    return setCookie.split(';')[0]!.split('=').slice(1).join('=');
  }

  it('gezondheidscheck en beveiligingsheaders', async () => {
    const res = await call('GET', '/gezond');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('zonder sessie: 401', async () => {
    const res = await call('GET', '/ik');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ fout: 'niet_ingelogd' });
  });

  it('CSRF: wijzigende aanvragen van een andere herkomst of zonder JSON worden geweigerd', async () => {
    expect((await call('POST', '/auth/inloglink', { body: { email: 'a@b.nl' }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/auth/inloglink', { body: { email: 'a@b.nl' }, origin: null })).status).toBe(403);
    expect((await call('POST', '/auth/inloglink', { body: 'email=a@b.nl', contentType: 'application/x-www-form-urlencoded' })).status).toBe(415);
  });

  it('ongeldige invoer geeft 400 met een Nederlandse melding', async () => {
    const res = await call('POST', '/auth/inloglink', { body: '{kapot' });
    expect(res.status).toBe(400);
    const r2 = await call('POST', '/auth/inloglink', { body: { email: 12 } });
    expect(r2.status).toBe(400);
    expect((await r2.json()).bericht).toContain('email');
  });

  it('volledige flow: inloggen, organisatie, domein verifiëren, scan, audit-log', async () => {
    const cookie = await signIn('anna@bakkerij.nl');

    const me = await (await call('GET', '/ik', { cookie })).json();
    expect(me.gebruiker.email).toBe('anna@bakkerij.nl');
    expect(me.organisaties).toEqual([]);

    const org = await (await call('POST', '/organisaties', { cookie, body: { name: 'Bakkerij', kind: 'klant' } })).json();
    expect(org.id).toBeDefined();

    const domRes = await call('POST', `/organisaties/${org.id}/domeinen`, { cookie, body: { name: 'bakkerij.nl' } });
    expect(domRes.status).toBe(201);
    const dom = await domRes.json();

    const blocked = await call('POST', `/organisaties/${org.id}/domeinen/${dom.id}/scans`, { cookie, body: {} });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).fout).toBe('niet_geverifieerd');

    p.dns.set(dom.instructions.dns.name, [dom.instructions.dns.value]);
    const ver = await (await call('POST', `/organisaties/${org.id}/domeinen/${dom.id}/verificatie/dns`, { cookie, body: {} })).json();
    expect(ver.verified).toBe(true);

    const scan = await call('POST', `/organisaties/${org.id}/domeinen/${dom.id}/scans`, { cookie, body: {} });
    expect(scan.status).toBe(202);

    const log = await (await call('GET', `/organisaties/${org.id}/audit`, { cookie })).json();
    expect(log.map((l: { action: string }) => l.action)).toEqual(['scan.aangevraagd', 'domein.geverifieerd', 'domein.toegevoegd', 'org.aangemaakt']);
    expect(log[0].actor_email).toBe('anna@bakkerij.nl');
  });

  it('een andere klant krijgt 404 op andermans organisatie en domeinen', async () => {
    const anna = await signIn('anna@bakkerij.nl');
    const org = (await (await call('GET', '/ik', { cookie: anna })).json()).organisaties[0];
    const kees = await signIn('kees@garage.nl');
    for (const path of [`/organisaties/${org.id}`, `/organisaties/${org.id}/domeinen`, `/organisaties/${org.id}/leden`, `/organisaties/${org.id}/audit`]) {
      expect((await call('GET', path, { cookie: kees })).status).toBe(404);
    }
    expect((await call('GET', '/organisaties/niet-een-id', { cookie: kees })).status).toBe(404);
  });

  it('telt geslaagde API-aanroepen per klant en route, geweigerde niet', async () => {
    const anna = await signIn('anna@bakkerij.nl');
    const org = (await (await call('GET', '/ik', { cookie: anna })).json()).organisaties[0];
    const count = async () =>
      (await p.pool.query("SELECT feature, quantity::int FROM usage_daily WHERE organization_id = $1 AND metric = 'api' ORDER BY feature", [org.id])).rows;
    const before = (await count()).find((r) => r.feature === 'GET /organisaties/:org/leden')?.quantity ?? 0;
    await call('GET', `/organisaties/${org.id}/leden`, { cookie: anna });
    const kees = await signIn('kees@garage.nl');
    await call('GET', `/organisaties/${org.id}/leden`, { cookie: kees }); // 404: telt niet
    for (let i = 0; i < 50; i++) {
      const n = (await count()).find((r) => r.feature === 'GET /organisaties/:org/leden')?.quantity ?? 0;
      if (n > before) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));
    expect((await count()).find((r) => r.feature === 'GET /organisaties/:org/leden')?.quantity).toBe(before + 1);
  });

  it('uitnodiging via de API, accepteren en rol', async () => {
    const anna = await signIn('anna@bakkerij.nl');
    const org = (await (await call('GET', '/ik', { cookie: anna })).json()).organisaties[0];
    const inv = await call('POST', `/organisaties/${org.id}/uitnodigingen`, { cookie: anna, body: { email: 'piet@bakkerij.nl', role: 'lezer' } });
    expect(inv.status).toBe(201);
    const token = extractToken(p.mailer.last('piet@bakkerij.nl')!.text, 'qbu_')!;
    const piet = await signIn('piet@bakkerij.nl');
    const acc = await call('POST', '/uitnodigingen/accepteren', { cookie: piet, body: { token } });
    expect(await acc.json()).toEqual({ organizationId: org.id, role: 'lezer' });
    // Lezer mag geen domein toevoegen en het audit-log niet lezen.
    expect((await call('POST', `/organisaties/${org.id}/domeinen`, { cookie: piet, body: { name: 'x.nl' } })).status).toBe(403);
    expect((await call('GET', `/organisaties/${org.id}/audit`, { cookie: piet })).status).toBe(403);
  });

  it('IT-partner: klant aanmaken en klantenlijst', async () => {
    const sanne = await signIn('sanne@itpartner.nl');
    const msp = await (await call('POST', '/organisaties', { cookie: sanne, body: { name: 'IT Partner Zuid', kind: 'it-partner' } })).json();
    const klant = await call('POST', `/organisaties/${msp.id}/klanten`, { cookie: sanne, body: { name: 'Tandarts Smit' } });
    expect(klant.status).toBe(201);
    const list = await (await call('GET', `/organisaties/${msp.id}/klanten`, { cookie: sanne })).json();
    expect(list.map((l: { clientName: string }) => l.clientName)).toEqual(['Tandarts Smit']);
    const me = await (await call('GET', '/ik', { cookie: sanne })).json();
    expect(me.organisaties.map((o: { name: string; via: string }) => [o.name, o.via])).toEqual([
      ['IT Partner Zuid', 'lid'],
      ['Tandarts Smit', 'partner'],
    ]);
  });

  it('domein bevestigen via e-mail kan zonder in te loggen', async () => {
    const anna = await signIn('anna@bakkerij.nl');
    const org = (await (await call('GET', '/ik', { cookie: anna })).json()).organisaties[0];
    const dom = await (await call('POST', `/organisaties/${org.id}/domeinen`, { cookie: anna, body: { name: 'tweede.nl' } })).json();
    const start = await call('POST', `/organisaties/${org.id}/domeinen/${dom.id}/verificatie/email`, {
      cookie: anna,
      body: { address: 'admin@tweede.nl' },
    });
    expect(start.status).toBe(202);
    const token = extractToken(p.mailer.last('admin@tweede.nl')!.text, 'qbd_')!;
    const res = await call('POST', '/domeinverificatie/bevestigen', { body: { token } });
    expect(await res.json()).toEqual({ domain: 'tweede.nl' });
  });

  it('uitloggen maakt de cookie ongeldig', async () => {
    const cookie = await signIn('uit@bakkerij.nl');
    expect((await call('POST', '/auth/uitloggen', { cookie, body: {} })).status).toBe(204);
    expect((await call('GET', '/ik', { cookie })).status).toBe(401);
  });
});
