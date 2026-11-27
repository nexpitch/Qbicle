import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelScheduledChange,
  cancelSubscription,
  changePlan,
  checkoutSubscription,
  createOrganization,
  getBilling,
  listInvoices,
  previewPlanChange,
  requestInvoicePayment,
  resumeSubscription,
  revokeMandate,
  settleTestPayment,
  startSubscription,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;
const DAY = 86_400_000;

describe.skipIf(!hasDb)('pakket wijzigen, opzeggen en betaalwijze', () => {
  let p: TestPlatform;
  let eigenaar: U;
  let org: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'sara@reclame.nl');
    org = (await createOrganization(p, eigenaar, { name: 'Reclamebureau Sara', kind: 'klant' })).id;
  });
  afterAll(async () => p?.close());

  /** Zet de lopende betaalde periode precies half om (182 dagen gehad, 183 te gaan). */
  async function halverwegeJaar() {
    await p.pool.query(
      `UPDATE subscription SET status = 'actief', trial_ends_at = now() - interval '200 days',
              current_period_start = now() - interval '182 days', current_period_end = now() + interval '183 days'
        WHERE organization_id = $1 AND status <> 'beeindigd'`,
      [org],
    );
  }

  it('tijdens de proef gaat een wissel meteen in, zonder bijbetaling', async () => {
    await startSubscription(p, eigenaar, org, { plan: 'mkb', interval: 'jaar' });
    const r = await changePlan(p, eigenaar, org, { plan: 'business', interval: 'maand' });
    expect(r.preview).toMatchObject({ soort: 'direct', bijbetalingExclCents: 0 });
    expect(r.subscription).toMatchObject({ plan: 'business', interval: 'maand', monthlyPriceCents: 17900 });
    await changePlan(p, eigenaar, org, { plan: 'mkb', interval: 'jaar' });
  });

  it('eerste betaling geeft een incassomachtiging (testmodus)', async () => {
    const { payment } = await checkoutSubscription(p, eigenaar, org);
    await settleTestPayment(p, eigenaar, payment.id, 'betaald');
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.betaalwijze.methode).toBe('incasso');
    expect(b.betaalwijze.mandaat).toMatchObject({ method: 'sepa', accountLast4: '0000' });
  });

  it('upgrade halverwege: bijbetaling naar rato, pakket pas na betalen', async () => {
    await halverwegeJaar();
    const pre = await previewPlanChange(p, eigenaar.userId, org, { plan: 'business', interval: 'jaar' });
    expect(pre.soort).toBe('upgrade');
    // (149 - 49) x 12 = €1.200 per jaar verschil, ruim de helft over.
    expect(pre.bijbetalingExclCents).toBeGreaterThan(59_000);
    expect(pre.bijbetalingExclCents).toBeLessThan(61_000);
    expect(pre.restDagen).toBe(183);

    const r = await changePlan(p, eigenaar, org, { plan: 'business', interval: 'jaar' });
    expect(r.checkoutUrl).toBeTruthy();
    expect((await getBilling(p, eigenaar.userId, org)).abonnement!.plan).toBe('mkb');

    await settleTestPayment(p, eigenaar, r.payment!.id, 'betaald');
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.abonnement).toMatchObject({ plan: 'business', monthlyPriceCents: 14900 });
    // De periode blijft gelijk.
    expect(b.dagenOver).toBe(183);
    const inv = await listInvoices(p, eigenaar.userId, org);
    expect(inv[0]!.lines[0]!.omschrijving).toMatch(/^Upgrade naar Qbicle Business, naar rato/);
  });

  it('downgrade gaat in bij de volgende periode, en kan vervallen', async () => {
    const r = await changePlan(p, eigenaar, org, { plan: 'mkb', interval: 'maand' });
    expect(r.preview).toMatchObject({ soort: 'downgrade', ingang: 'volgende_periode' });
    let b = await getBilling(p, eigenaar.userId, org);
    expect(b.abonnement!.plan).toBe('business');
    expect(b.gepland).toMatchObject({ interval: 'maand' });
    expect(b.gepland!.pakket!.id).toBe('mkb');
    expect(b.volgendeBetaling).toMatchObject({ exclCents: 5900, interval: 'maand' });

    await cancelScheduledChange(p, eigenaar, org);
    expect((await getBilling(p, eigenaar.userId, org)).gepland).toBeNull();

    // Opnieuw plannen; bij het klaarzetten van de volgende periode gaat hij in.
    await changePlan(p, eigenaar, org, { plan: 'mkb', interval: 'jaar' });
    const next = await checkoutSubscription(p, eigenaar, org);
    expect(next.payment.amountExclCents).toBe(4900 * 12);
    b = await getBilling(p, eigenaar.userId, org);
    expect(b.abonnement).toMatchObject({ plan: 'mkb', pendingPlan: null });
  });

  it('opzeggen met reden en weer intrekken', async () => {
    const s = await cancelSubscription(p, eigenaar, org, { reden: 'te_duur', toelichting: 'Even geen budget' });
    expect(s).toMatchObject({ status: 'opgezegd', cancelReason: 'te_duur' });
    expect((await getBilling(p, eigenaar.userId, org)).volgendeBetaling).toBeNull();
    const back = await resumeSubscription(p, eigenaar, org);
    expect(back).toMatchObject({ status: 'actief', cancelAtPeriodEnd: false, cancelReason: null });
    await expect(resumeSubscription(p, eigenaar, org)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('machtiging intrekken en betalen op factuur aanvragen (wordt een notitie voor de cockpit)', async () => {
    await revokeMandate(p, eigenaar, org);
    expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.mandaat).toBeNull();
    await expect(revokeMandate(p, eigenaar, org)).rejects.toMatchObject({ code: 'conflict' });

    await expect(requestInvoicePayment(p, eigenaar, org, 'nee')).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    // Factuur kan alleen bij Corporate met jaarcontract (zie factuurregel.test.ts).
    await p.pool.query(`UPDATE subscription SET plan = 'business', billing_interval = 'jaar' WHERE organization_id = $1 AND status <> 'beeindigd'`, [org]);
    await requestInvoicePayment(p, eigenaar, org, 'Wij hebben een inkoopordernummer nodig');
    const note = await p.pool.query(`SELECT body, source FROM org_note WHERE organization_id = $1`, [org]);
    expect(note.rows[0]).toMatchObject({ source: 'systeem' });
    expect(note.rows[0].body).toContain('inkoopordernummer');
    expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.factuurAangevraagdOp).toBeTruthy();
    await expect(requestInvoicePayment(p, eigenaar, org, 'Nog een keer graag')).rejects.toMatchObject({ code: 'conflict' });
    void DAY;
  });
});
