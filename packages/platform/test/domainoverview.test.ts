import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDomains, createOrganization, domainOverview, kiesSuggesties, listDomains, registrableDomain, seedDemoData, splitDomainList, wijsSuggestieAf } from '../src/index.ts';
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

describe('Hoort dit ook bij jullie? (suggesties kiezen)', () => {
  const cert = (via: string) => ({ soort: 'certificaat' as const, via });
  const website = (domein: string, via = 'www.nexpitch.com') => ({ domein, dienst: 'website' as const, bewijs: [cert(via)] });

  it('www.nexpitch.com in de lijst: nexpitch.com wordt nooit voorgesteld', () => {
    const domains = [{ name: 'www.nexpitch.com', verified: true }];
    expect(kiesSuggesties(domains, [{ bronDomein: 'www.nexpitch.com', verwant: [website('nexpitch.com'), website('shop.nexpitch.com')] }], [])).toEqual([]);
  });

  it('met bewijs en een website: voorstellen, met de reden erbij', () => {
    const domains = [{ name: 'nexpitch.com', verified: true }];
    expect(kiesSuggesties(domains, [{ bronDomein: 'nexpitch.com', verwant: [website('nexpitch.nl', 'www.nexpitch.com')] }], [])).toEqual([
      { domein: 'nexpitch.nl', redenen: ['Staat op hetzelfde beveiligingscertificaat als www.nexpitch.com.'], dienst: 'Er draait een website.' },
    ]);
  });

  it('geen dubbelen, niets van onbevestigde domeinen, niets wat al in de lijst staat of is afgewezen', () => {
    const domains = [
      { name: 'nexpitch.com', verified: true },
      { name: 'qbicle.nl', verified: false },
    ];
    const gevonden = [
      { bronDomein: 'nexpitch.com', verwant: [website('nexpitch.nl', 'nexpitch.com'), website('www.nexpitch.nl', 'www.nexpitch.com'), website('qbicle.nl'), website('oud.nl')] },
      { bronDomein: 'qbicle.nl', verwant: [website('iets-anders.nl')] },
    ];
    const r = kiesSuggesties(domains, gevonden, ['oud.nl']);
    expect(r.map((s) => s.domein)).toEqual(['nexpitch.nl']);
    expect(r[0]!.redenen).toHaveLength(2);
  });

  it('zonder bewijs geen suggestie', () => {
    const domains = [{ name: 'nexpitch.com', verified: true }];
    expect(kiesSuggesties(domains, [{ bronDomein: 'nexpitch.com', verwant: [{ domein: 'x.nl', dienst: 'website', bewijs: [] }] }], [])).toEqual([]);
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
    expect(ov).toMatchObject({ gebruikt: 3, limiet: 1, plan: null, extra: 2, extraDomeinCenten: 500 });
  });

  it('per domein assets en bevindingen; losse assets van andere domeinen worden geen suggestie', async () => {
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
    expect(ov.suggesties).toEqual([]);
  });

  it('suggestie uit de scan van een bevestigd domein, en "Niet van ons" haalt hem weg', async () => {
    const jo = await loginAs(p, 'jo@nexpitch.com');
    const org = (await createOrganization(p, jo, { name: 'Nexpitch', kind: 'klant' })).id;
    await addDomains(p, jo, org, 'nexpitch.com');
    const [dom] = await listDomains(p, jo.userId, org);
    await p.pool.query("UPDATE domain SET verified_at = now(), verification_method = 'dns-txt' WHERE id = $1", [dom!.id]);
    const a = await p.pool.query<{ id: string }>(
      `INSERT INTO asset (organization_id, domain_id, type, value, source, visibility) VALUES ($1, $2, 'domein', 'nexpitch.com', 'scanner', 'primair') RETURNING id`,
      [org, dom!.id],
    );
    const verwant = [
      { domein: 'nexpitch.nl', dienst: 'website', bewijs: [{ soort: 'certificaat', via: 'www.nexpitch.com' }] },
      { domein: 'www.nexpitch.com', dienst: 'website', bewijs: [{ soort: 'certificaat', via: 'nexpitch.com' }] },
    ];
    await p.pool.query(
      `INSERT INTO asset_attribute (asset_id, key, value, observed_at, certainty) VALUES ($1, 'domein.verwant', $2, now(), 'vastgesteld')`,
      [a.rows[0]!.id, JSON.stringify(verwant)],
    );
    const domains = await listDomains(p, jo.userId, org);
    expect((await domainOverview(p, jo.userId, org, domains)).suggesties.map((s) => s.domein)).toEqual(['nexpitch.nl']);

    await wijsSuggestieAf(p, jo, org, 'www.nexpitch.nl');
    expect((await domainOverview(p, jo.userId, org, domains)).suggesties).toEqual([]);
  });
});
