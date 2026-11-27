import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDomains, createOrganization, domainOverview, listDomains, registrableDomain, seedDemoData, splitDomainList } from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

describe('meerdere domeinen: hulpfuncties', () => {
  it('splitst een geplakte lijst en haalt dubbelen weg', () => {
    expect(splitDomainList('a.nl, b.nl\nc.nl;a.nl  d.nl')).toEqual(['a.nl', 'b.nl', 'c.nl', 'd.nl']);
  });
  it('vindt het hoofddomein', () => {
    expect(registrableDomain('https://shop.bakkerij.nl/pad')).toBe('bakkerij.nl');
    expect(registrableDomain('www.voorbeeld.co.uk')).toBe('voorbeeld.co.uk');
    expect(registrableDomain('KPN Box 12 (modem)')).toBeNull();
  });
});

describe.skipIf(!hasDb)('meerdere domeinen', () => {
  let p: TestPlatform;
  beforeAll(async () => {
    process.env.QBICLE_DEMODATA = 'aan';
    p = await createTestPlatform();
  });
  afterAll(async () => {
    delete process.env.QBICLE_DEMODATA;
    await p?.close();
  });

  it('voegt een lijst toe en meldt per naam wat er gebeurde', async () => {
    const eva = await loginAs(p, 'eva@bureau.nl');
    const org = (await createOrganization(p, eva, { name: 'Bureau Eva', kind: 'klant' })).id;
    const r = await addDomains(p, eva, org, 'bureau.nl\nwww.klant-een.nl, klant-twee.nl\nbureau.nl\nniet geldig!');
    expect(r.map((x) => x.status)).toEqual(['toegevoegd', 'toegevoegd', 'toegevoegd', 'ongeldig', 'ongeldig']);
    expect(r[1]!.domein).toBe('klant-een.nl');
    expect((await addDomains(p, eva, org, ['bureau.nl']))[0]!.status).toBe('bestaat_al');

    const domains = await listDomains(p, eva.userId, org);
    const ov = await domainOverview(p, eva.userId, org, domains);
    expect(ov).toMatchObject({ gebruikt: 3, limiet: 1, plan: null });
  });

  it('per domein assets en bevindingen, en suggesties uit wat we zien', async () => {
    const ad = await loginAs(p, 'ad@winkel.nl');
    const org = (await createOrganization(p, ad, { name: 'Winkel', kind: 'klant' })).id;
    await seedDemoData(p, ad, org);
    await p.pool.query(
      `INSERT INTO asset (organization_id, type, value, source, visibility) VALUES ($1, 'website', 'https://www.andere-winkel.nl', 'demo', 'primair')`,
      [org],
    );
    const domains = await listDomains(p, ad.userId, org);
    const ov = await domainOverview(p, ad.userId, org, domains);
    const sm = ov.summaries.get(domains[0]!.id)!;
    expect(sm.assets).toBe(15);
    expect(sm.openFindings).toBeGreaterThan(5);
    expect(ov.suggesties).toEqual(['andere-winkel.nl']);
  });
});
