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

    // Pakket wijzigen: eerst een voorbeeld met kosten, opzeggen met uitleg.
    const wijz = await (await web.request(`/o/${org}/abonnement/wijzigen?pakket=business&interval=maand`, { headers: { cookie } })).text();
    expect(wijz).toContain('Controleer je wijziging');
    expect((await web.request(`/o/${org}/abonnement/wijzigen?pakket=bestaatniet&interval=maand`, { headers: { cookie } })).status).toBe(302);
    expect(await (await web.request(`/o/${org}/abonnement/opzeggen`, { headers: { cookie } })).text()).toContain('Wat er gebeurt');
    expect(abo).toContain('SEPA-machtiging');
    expect(abo).toContain('Je contract verlengt op');

    // Facturen: overzicht, csv en pdf.
    const fact = await (await web.request(`/o/${org}/facturen`, { headers: { cookie } })).text();
    expect(fact).toMatch(/QB-\d{4}-\d{6}/);
    const invId = fact.match(/facturen\/([0-9a-f-]{36})\/pdf/)![1]!;
    const csv = await web.request(`/o/${org}/facturen/export.csv`, { headers: { cookie } });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('Factuurnummer;Omschrijving');
    const pdf = await web.request(`/o/${org}/facturen/${invId}/pdf`, { headers: { cookie } });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await web.request(`/o/${org}/facturen/${invId}/pdf`)).status).toBe(302);
    expect((await web.request(`/o/${org}/account`)).status).toBe(302);

    // Een ander ziet niets van deze organisatie.
    expect((await web.request(`/o/${org}/abonnement`)).status).toBe(302);
  });

  it('dashboard: lege staat, voorbeelddata, assets, detail per asset en domeinen', async () => {
    process.env.QBICLE_DEMODATA = 'aan';
    try {
      expect((await json('/api/v1/registratie', { email: 'dash@test.nl', organisatie: 'Dash BV', pakket: 'business', interval: 'jaar' })).status).toBe(202);
      const login = await json('/api/v1/auth/inloggen', { token: extractToken(p.mailer.last('dash@test.nl')!.text, 'qbl_')! });
      const org = ((await login.json()) as any).registratie.organizationId as string;
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const get = (path: string) => web.request(path, { headers: { cookie } });

      let html = await (await get(`/o/${org}/overzicht`)).text();
      expect(html).toContain('Voeg je domein toe');
      expect(html).toContain('Vul met voorbeelddata');
      // Lege staat toont al alle onderdelen, ingeklapt, met wanneer de scan komt.
      expect(html).toContain('Alles in beeld');
      expect(html.match(/<details class="sect"/g)?.length).toBe(9);
      expect(html).toContain('Nog niets vastgelegd');
      expect(html).toContain('Nog niet gescand');
      expect(html).toContain('Voeg een domein toe om te starten');

      expect((await json(`/api/v1/organisaties/${org}/demodata`, {}, cookie)).status).toBe(201);
      html = await (await get(`/o/${org}/overzicht`)).text();
      expect(html).toContain('Direct aandacht');
      expect(html).toContain('id="sectie-koppelingen"');
      expect(html).not.toMatch(/<details class="sect"[^>]* open/);
      expect(html).toContain('Urgentie over tijd');
      expect(html).toContain('Netwerkapparatuur');
      expect(html).not.toMatch(/style="/);

      const assets = await (await get(`/o/${org}/assets?soort=netwerk`)).text();
      expect(assets).toContain('KPN Box 12');
      expect(assets).not.toContain('Synology');
      const vpn = assets.match(/href="(\/o\/[^"]+\/assets\/[0-9a-f-]{36})"/);
      expect(vpn).toBeTruthy();
      const detail = await get(vpn![1]!);
      expect(detail.status).toBe(200);
      expect(await detail.text()).toContain('Bevindingen');

      expect(await (await get(`/o/${org}/domeinen`)).text()).toContain('voorbeeldbedrijf.example');
      await json(`/api/v1/organisaties/${org}/domeinen/lijst`, { domeinen: 'kopieer-test.nl' }, cookie);
      const dom = await (await get(`/o/${org}/domeinen`)).text();
      expect(dom).toContain('data-kopieer="_qbicle-verificatie.kopieer-test.nl"');
      expect(dom).toContain('data-kopieer="_qbicle-verificatie"');
      expect(dom).toMatch(/data-kopieer="qbicle-verificatie=[0-9a-f]{32}"/);
      expect((await get(`/o/${org}/assets/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    } finally {
      delete process.env.QBICLE_DEMODATA;
    }
  });
});
