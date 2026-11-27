import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractToken } from '@qbicle/platform';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createWeb } from '../src/app.tsx';

const ORIGIN = 'https://app.qbicle.test';

describe.skipIf(!hasDb)('web-app', () => {
  let p: TestPlatform;
  let web: ReturnType<typeof createWeb>;

  beforeAll(async () => {
    p = await createTestPlatform();
    web = createWeb(p, { secureCookies: true, trustProxy: false });
  });
  afterAll(async () => p?.close());

  const json = (path: string, body: unknown, cookie?: string) =>
    web.request(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it('pakketpagina met prijzen uit het prijzenbestand en een strikte CSP', async () => {
    const res = await web.request('/aanmelden');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Qbicle MKB');
    expect(html).toContain('Qbicle Business');
    expect(html).toContain('Qbicle Audit Quick Scan');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(html).not.toMatch(/fonts\.googleapis|style="/);
  });

  it('statische bestanden en lettertypen komen van onze eigen server', async () => {
    expect((await web.request('/static/app.css')).status).toBe(200);
    expect((await web.request('/static/inter.woff2')).headers.get('content-type')).toBe('font/woff2');
    expect((await web.request('/static/../package.json')).status).toBe(404);
  });

  it('zonder inloggen naar de inlogpagina; onbekende pagina 404', async () => {
    expect((await web.request('/overzicht')).headers.get('location')).toBe('/inloggen');
    expect((await web.request('/bestaat-niet')).status).toBe(404);
  });

  it('hele route: registreren, inloggen, welkom, testbetaling, factuur', async () => {
    expect((await json('/api/v1/registratie', { email: 'web@test.nl', organisatie: 'Web BV', pakket: 'mkb', interval: 'maand' })).status).toBe(202);
    const token = extractToken(p.mailer.last('web@test.nl')!.text, 'qbl_')!;
    const login = await json('/api/v1/auth/inloggen', { token });
    const body = (await login.json()) as any;
    const org = body.registratie.organizationId as string;
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const welkom = await web.request(`/o/${org}/welkom`, { headers: { cookie } });
    expect(await welkom.text()).toContain('Welkom bij Qbicle, Web BV');

    const pay = (await (await json(`/api/v1/organisaties/${org}/abonnement/betalen`, {}, cookie)).json()) as any;
    expect(pay.betaalpagina).toBe(`${ORIGIN}/betalen/test/${pay.betaling.id}`);
    expect((await web.request(`/betalen/test/${pay.betaling.id}`, { headers: { cookie } })).status).toBe(200);
    await json(`/api/v1/betalingen/${pay.betaling.id}/test-uitkomst`, { uitkomst: 'betaald' }, cookie);

    const done = await (await web.request(`/betaling/${pay.betaling.id}`, { headers: { cookie } })).text();
    expect(done).toContain('je betaling is gelukt');
    const abo = await (await web.request(`/o/${org}/abonnement`, { headers: { cookie } })).text();
    expect(abo).toMatch(/QB-\d{4}-\d{6}/);

    // Account: gegevens, contactpersonen en gebruikers op één plek.
    const acc = await (await web.request(`/o/${org}/account`, { headers: { cookie } })).text();
    expect(acc).toContain('Bedrijfsgegevens');
    expect(acc).toContain('Contact bij een urgent lek');
    expect(acc).toContain('1 van 5 gebruikers');
    expect(acc).toContain('Vul nog in:');
    const put = await web.request(`/api/v1/organisaties/${org}/contactpersonen/security`, {
      method: 'PUT',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie },
      body: JSON.stringify({ naam: 'Kees', email: 'kees@web.nl', telefoon: '' }),
    });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await (await web.request(`/o/${org}/account`, { headers: { cookie } })).text()).toContain('kees@web.nl');
    expect((await web.request('/uitnodiging')).status).toBe(200);
    expect((await web.request(`/o/${org}/account`)).status).toBe(302);

    // Een ander ziet niets van deze organisatie.
    expect((await web.request(`/o/${org}/abonnement`)).status).toBe(302);
  });
});
