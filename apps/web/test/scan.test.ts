import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractToken } from '@qbicle/platform';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { fakeNet, healthyConfig } from '../../../packages/scanner/test/fake-net.ts';
import { drainQueue, heartbeat } from '../../../packages/worker/src/index.ts';
import { createWeb } from '../src/app.tsx';

const ORIGIN = 'https://app.qbicle.test';
const D = 'scanbedrijf.nl';

describe.skipIf(!hasDb)('scans zichtbaar in de web-app', () => {
  let p: TestPlatform;
  let web: ReturnType<typeof createWeb>;
  let org: string;
  let cookie: string;
  let domainId: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    web = createWeb(p, { secureCookies: true, trustProxy: false });
    const post = (path: string, body: unknown) =>
      web.request(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/v1/registratie', { email: 'eva@scanbedrijf.nl', organisatie: 'Scanbedrijf', pakket: 'mkb', interval: 'maand' });
    const login = await post('/api/v1/auth/inloggen', { token: extractToken(p.mailer.last('eva@scanbedrijf.nl')!.text, 'qbl_')! });
    org = ((await login.json()) as any).registratie.organizationId;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    domainId = (
      await p.pool.query(
        `INSERT INTO domain (organization_id, name, verified_at, verification_method, verification_token) VALUES ($1, $2, now(), 'dns-txt', 't') RETURNING id`,
        [org, D],
      )
    ).rows[0].id;
  });
  afterAll(async () => p?.close());

  const get = (path: string) => web.request(path, { headers: { cookie } });
  const post = (path: string) => web.request(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie }, body: '{}' });

  it('bevestigd domein: eerste scan gepland, knop nu scannen, melding als de scanner niet draait', async () => {
    const html = await (await get(`/o/${org}/domeinen`)).text();
    expect(html).toContain('Nog niet gescand');
    expect(html).toContain('De eerste scan start binnen een minuut.');
    expect(html).toContain('Scan nu starten');
    expect(html).toContain('De scanner draait op dit moment niet');
  });

  it('scan starten, live voortgang, resultaat en daarna laatste en volgende scan', async () => {
    await heartbeat(p.pool, 'test-worker');
    const start = await post(`/api/v1/organisaties/${org}/domeinen/${domainId}/scans`);
    expect(start.status).toBe(202);
    const scanId = ((await start.json()) as any).id;

    const page = await (await get(`/o/${org}/scans/${scanId}`)).text();
    expect(page).toContain(`Scan van ${D} staat klaar`);
    expect(page).toContain('Domein en DNS');
    expect(page).toContain('data-scan=');
    expect(await (await get(`/o/${org}/domeinen`)).text()).toContain('Bekijk de scan die nu loopt');

    const cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [];
    await drainQueue({ pool: p.pool, net: fakeNet(cfg), workerId: 'test-worker', timeoutMinutes: 1 });

    const s = (await (await get(`/api/v1/organisaties/${org}/scans/${scanId}`)).json()) as any;
    expect(s.status).toBe('klaar');
    expect(s.pct).toBe(100);
    expect(s.steps.every((x: any) => x.status === 'klaar')).toBe(true);
    expect(s.result.urgency).toBeGreaterThan(0);
    // Tijdens het scannen schreef de worker de voortgang per stap.
    const prog = (await p.pool.query('SELECT progress FROM scan WHERE id = $1', [scanId])).rows[0].progress;
    expect(prog.stappen['e-mail']).toEqual({ totaal: 3, klaar: 3 });

    const klaar = await (await get(`/o/${org}/scans/${scanId}`)).text();
    expect(klaar).toContain('Bekijk de resultaten');

    const dom = await (await get(`/o/${org}/domeinen`)).text();
    expect(dom).toMatch(/Laatste scan<\/dt><dd>\w+dag \d+ \w+ 2026 om \d\d:\d\d/);
    expect(dom).toContain('We scannen elke week automatisch opnieuw.');
    expect(dom).toContain('Net gescand');

    // Niet te snel opnieuw.
    const again = await post(`/api/v1/organisaties/${org}/domeinen/${domainId}/scans`);
    expect(again.status).toBe(429);
    expect(((await again.json()) as any).bericht).toMatch(/net gescand/);
  });

  it('een scan van een andere organisatie is niet te zien', async () => {
    const other = (await p.pool.query(`INSERT INTO organization (name, kind) VALUES ('Ander', 'klant') RETURNING id`)).rows[0].id;
    const d = (await p.pool.query(`INSERT INTO domain (organization_id, name, verified_at, verification_method, verification_token) VALUES ($1, 'ander.nl', now(), 'dns-txt', 't') RETURNING id`, [other])).rows[0].id;
    const s = (await p.pool.query(`INSERT INTO scan (domain_id, trigger) VALUES ($1, 'handmatig') RETURNING id`, [d])).rows[0].id;
    expect((await get(`/api/v1/organisaties/${org}/scans/${s}`)).status).toBe(404);
    expect((await get(`/api/v1/organisaties/${other}/scans/${s}`)).status).toBe(404);
  });
});
