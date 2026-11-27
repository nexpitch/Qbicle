import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkoutSubscription, createOrganization, getBillingHistory, retryPayment, settleTestPayment, startSubscription } from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe.skipIf(!hasDb)('facturen en betalingen (klantkant)', () => {
  let p: TestPlatform;
  let eigenaar: U;
  let vreemde: U;
  let org: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'tom@garage.nl');
    vreemde = await loginAs(p, 'iemand@anders.nl');
    org = (await createOrganization(p, eigenaar, { name: 'Garage Tom', kind: 'klant' })).id;
    await startSubscription(p, eigenaar, org, { plan: 'mkb', interval: 'maand' });
  });
  afterAll(async () => p?.close());

  it('mislukte betaling vraagt om actie, opnieuw betalen lost het op', async () => {
    const first = await checkoutSubscription(p, eigenaar, org);
    await settleTestPayment(p, eigenaar, first.payment.id, 'mislukt');
    let h = await getBillingHistory(p, eigenaar.userId, org);
    expect(h.actieNodig.map((r) => r.payment.id)).toEqual([first.payment.id]);
    expect(h.rows[0]!.status).toBe('mislukt');

    const again = await retryPayment(p, eigenaar, org, first.payment.id);
    expect(again.payment.amountInclCents).toBe(first.payment.amountInclCents);
    expect(again.payment.periodStart).toEqual(first.payment.periodStart);
    // Zolang de nieuwe open staat, geen tweede herinnering.
    h = await getBillingHistory(p, eigenaar.userId, org);
    expect(h.actieNodig).toEqual([]);
    await expect(retryPayment(p, eigenaar, org, first.payment.id)).rejects.toMatchObject({ code: 'conflict' });

    await settleTestPayment(p, eigenaar, again.payment.id, 'betaald');
    h = await getBillingHistory(p, eigenaar.userId, org);
    expect(h.totaal).toMatchObject({ aantal: 1, exclCents: 5900, inclCents: 5900 + 1239 });
    expect(h.rows[0]).toMatchObject({ status: 'betaald' });
    expect(h.rows[0]!.invoiceNumber).toMatch(/^QB-\d{4}-\d{6}$/);
  });

  it('zoeken, filteren en terugbetaald', async () => {
    const h0 = await getBillingHistory(p, eigenaar.userId, org);
    const nr = h0.rows[0]!.invoiceNumber!;
    expect((await getBillingHistory(p, eigenaar.userId, org, { zoek: nr })).rows).toHaveLength(1);
    expect((await getBillingHistory(p, eigenaar.userId, org, { status: 'mislukt' })).rows).toHaveLength(1);
    expect((await getBillingHistory(p, eigenaar.userId, org, { jaar: 1999 })).rows).toHaveLength(0);
    await p.pool.query(`UPDATE payment SET refunded_cents = 1000, refunded_at = now() WHERE id = $1`, [h0.rows[0]!.payment.id]);
    const h = await getBillingHistory(p, eigenaar.userId, org, { status: 'terugbetaald' });
    expect(h.rows[0]).toMatchObject({ status: 'deels_terugbetaald', refundedCents: 1000 });
  });

  it('een ander ziet niets', async () => {
    await expect(getBillingHistory(p, vreemde.userId, org)).rejects.toMatchObject({ code: 'niet_gevonden' });
  });
});
