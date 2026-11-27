import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractToken } from '@qbicle/platform';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createWeb } from '../src/app.tsx';

const ORIGIN = 'https://app.qbicle.test';

describe.skipIf(!hasDb)('koppelingen (testmodus)', () => {
  let p: TestPlatform;
  let web: ReturnType<typeof createWeb>;
  let cookie: string;
  let org: string;

  const json = (path: string, body: unknown, c = cookie) =>
    web.request(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...(c ? { cookie: c } : {}) },
      body: JSON.stringify(body),
    });
  const page = (path: string, c = cookie) => web.request(path, { headers: c ? { cookie: c } : {} });

  beforeAll(async () => {
    p = await createTestPlatform();
    web = createWeb(p, { secureCookies: true, trustProxy: false });
    await json('/api/v1/registratie', { email: 'kop@test.nl', organisatie: 'Koppel BV', pakket: 'mkb', interval: 'jaar' }, '');
    const token = extractToken(p.mailer.last('kop@test.nl')!.text, 'qbl_')!;
    const login = await json('/api/v1/auth/inloggen', { token }, '');
    org = ((await login.json()) as any).registratie.organizationId;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  afterAll(async () => p?.close());

  it('overzicht toont categorieën, testmodus en de grens alleen-lezen', async () => {
    const res = await page(`/o/${org}/koppelingen`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Testmodus');
    expect(html).toContain('Microsoft 365');
    expect(html).toContain('Cloud, servers en opslag');
    expect(html).toContain('nooit de inhoud');
    expect(html).toContain(`/o/${org}/koppelingen/aws`);
  });

  it('route Microsoft 365: starten, link voor IT, toestemming, intrekken', async () => {
    const base = `/api/v1/organisaties/${org}/koppelingen/microsoft365`;
    expect((await json(`${base}/starten`, {})).status).toBe(200);
    const link = (await (await json(`${base}/deellink`, {})).json()) as any;
    expect(link.link).toMatch(/\/it\/qbk_/);

    const it = await page(new URL(link.link).pathname, '');
    expect(it.status).toBe(200);
    const itHtml = await it.text();
    expect(itHtml).toContain('Microsoft 365 koppelen aan Qbicle');
    expect(itHtml).not.toContain('Koppel BV');
    expect(it.headers.get('referrer-policy')).toBe('no-referrer');

    expect(((await (await json(`${base}/test-toestemming`, { uitkomst: 'gelukt' })).json()) as any).status).toBe('actief');
    const detail = await (await page(`/o/${org}/koppelingen/microsoft365`)).text();
    expect(detail).toContain('Wat we vonden');
    expect(detail).toContain('Koppeling intrekken');

    expect(((await (await json(`${base}/intrekken`, {})).json()) as any).status).toBe('ingetrokken');
    expect((await page(new URL(link.link).pathname, '')).status).toBe(404);
  });

  it('MKB kan geen Business-koppeling starten; onbekende koppeling 404', async () => {
    const r = await json(`/api/v1/organisaties/${org}/koppelingen/aws/starten`, {});
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).bericht).toContain('Business');
    expect((await json(`/api/v1/organisaties/${org}/koppelingen/bestaat-niet/starten`, {})).status).toBe(404);
    expect((await page(`/o/${org}/koppelingen/bestaat-niet`)).status).toBe(404);
  });

  it('zonder inloggen of van een andere herkomst niets', async () => {
    expect((await page(`/o/${org}/koppelingen`, '')).status).toBe(302);
    expect((await json(`/api/v1/organisaties/${org}/koppelingen/microsoft365/starten`, {}, '')).status).toBe(401);
    const vreemd = await web.request(`/api/v1/organisaties/${org}/koppelingen/microsoft365/starten`, {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(vreemd.status).toBe(403);
  });
});
