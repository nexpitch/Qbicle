import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractToken } from '@qbicle/platform';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createWeb } from '../src/app.tsx';

const ORIGIN = 'https://app.qbicle.test';

describe.skipIf(!hasDb)('register systemen (web)', () => {
  let p: TestPlatform;
  let web: ReturnType<typeof createWeb>;
  let cookie: string;
  let org: string;

  const send = (method: string, path: string, body: unknown, c = cookie) =>
    web.request(path, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...(c ? { cookie: c } : {}) },
      body: JSON.stringify(body),
    });
  const page = (path: string, c = cookie) => web.request(path, { headers: c ? { cookie: c } : {} });

  beforeAll(async () => {
    p = await createTestPlatform();
    web = createWeb(p, { secureCookies: true, trustProxy: false });
    await send('POST', '/api/v1/registratie', { email: 'sys@test.nl', organisatie: 'Systeem BV', pakket: 'mkb', interval: 'jaar' }, '');
    const token = extractToken(p.mailer.last('sys@test.nl')!.text, 'qbl_')!;
    const login = await send('POST', '/api/v1/auth/inloggen', { token }, '');
    org = ((await login.json()) as any).registratie.organizationId;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  afterAll(async () => p?.close());

  it('lege pagina nodigt uit om te beginnen', async () => {
    const html = await (await page(`/o/${org}/systemen`)).text();
    expect(html).toContain('Nog geen systemen');
    expect(html).toContain(`/o/${org}/systemen/nieuw`);
    expect((await page(`/o/${org}/systemen/nieuw`)).status).toBe(200);
  });

  it('toevoegen via de API, zien op de pagina, wijzigen en verwijderen', async () => {
    const r = await send('POST', `/api/v1/organisaties/${org}/systemen`, {
      naam: 'Shopify',
      soort: 'webshop',
      hosting: 'saas',
      impactUitval: 'stil',
      gegevens: ['klanten', 'betaalgegevens'],
      inloggen: 'wachtwoord',
      leverancier: '',
      eigenaar: '',
    });
    expect(r.status).toBe(201);
    const s = (await r.json()) as any;

    const lijst = await (await page(`/o/${org}/systemen`)).text();
    expect(lijst).toContain('Shopify');
    expect(lijst).toContain('Hoge impact');
    expect(lijst).toContain('Nu oppakken');

    const detail = await (await page(`/o/${org}/systemen/${s.id}`)).text();
    expect(detail).toContain('Wat je kunt doen');
    expect(detail).toContain('tweestapsverificatie');

    expect((await send('PUT', `/api/v1/organisaties/${org}/systemen/${s.id}`, { naam: 'Shopify', soort: 'webshop', impactUitval: 'laag', gegevens: [] })).status).toBe(200);
    expect((await send('DELETE', `/api/v1/organisaties/${org}/systemen/${s.id}`, {})).status).toBe(204);
    expect((await page(`/o/${org}/systemen/${s.id}`)).status).toBe(404);
  });

  it('ongeldige invoer en vreemde herkomst worden geweigerd', async () => {
    expect((await send('POST', `/api/v1/organisaties/${org}/systemen`, { naam: 'X', soort: 'raket', impactUitval: 'laag' })).status).toBe(400);
    expect((await send('POST', `/api/v1/organisaties/${org}/systemen`, { naam: 'X', soort: 'erp', impactUitval: 'laag', gegevens: ['dna'] })).status).toBe(400);
    const vreemd = await web.request(`/api/v1/organisaties/${org}/systemen`, {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ naam: 'X', soort: 'erp', impactUitval: 'laag' }),
    });
    expect(vreemd.status).toBe(403);
    expect((await page(`/o/${org}/systemen`, '')).status).toBe(302);
  });
});
