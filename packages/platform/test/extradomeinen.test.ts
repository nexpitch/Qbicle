import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkoutSubscription, createOrganization, extraDomainCharge, getBilling, listInvoices, previewPlanChange, settleTestPayment, startSubscription } from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

describe.skipIf(!hasDb)('add-on extra domeinen', () => {
  let p: TestPlatform;
  let eigenaar: Awaited<ReturnType<typeof loginAs>>;
  let org: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'lisa@kapsalon.nl');
    org = (await createOrganization(p, eigenaar, { name: 'Kapsalon Lisa', kind: 'klant' })).id;
    await startSubscription(p, eigenaar, org, { plan: 'mkb', interval: 'maand' }); // 3 domeinen
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      await p.pool.query(`INSERT INTO domain (organization_id, name, verification_token) VALUES ($1, $2, 'tok-' || $2)`, [org, `kapsalon-${n}.nl`]);
    }
  });
  afterAll(async () => p?.close());

  it('telt domeinen boven de limiet en toont ze in de volgende betaling', async () => {
    expect(p.catalog.extraDomeinCenten).toBe(500);
    expect(await extraDomainCharge(p, eigenaar.userId, org)).toEqual({ extra: 2, perMaandCenten: 1000, limiet: 3 });
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.volgendeBetaling).toMatchObject({ extraDomeinen: 2, extraDomeinenExclCents: 1000, exclCents: 5900 + 1000 });
  });

  it('komt als aparte regel op betaling en factuur', async () => {
    const { payment } = await checkoutSubscription(p, eigenaar, org);
    expect(payment.amountExclCents).toBe(6900);
    await settleTestPayment(p, eigenaar, payment.id, 'betaald');
    const [inv] = await listInvoices(p, eigenaar.userId, org);
    expect(inv!.lines).toHaveLength(2);
    expect(inv!.lines[1]).toMatchObject({ aantal: 2, prijsExclCenten: 500, totaalExclCenten: 1000 });
    expect(inv!.lines[1]!.omschrijving).toMatch(/^Extra domeinen boven 3/);
    expect(inv!.amountExclCents).toBe(6900);
  });

  it('jaarbetaling: 12 maanden per extra domein; Business heeft ruimte genoeg', async () => {
    const jaar = await previewPlanChange(p, eigenaar.userId, org, { plan: 'mkb', interval: 'jaar' });
    expect(jaar.volgendeBetaling.exclCents).toBe(4900 * 12 + 2 * 500 * 12);
    expect(jaar.waarschuwingen.join(' ')).toMatch(/2 extra domeinen kosten elk €\s?5 per maand/);
    const biz = await previewPlanChange(p, eigenaar.userId, org, { plan: 'business', interval: 'maand' });
    expect(biz.volgendeBetaling.exclCents).toBe(17900);
    expect(biz.waarschuwingen).toEqual([]);
  });
});
