import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelSubscription,
  checkoutSubscription,
  contractEnd,
  createOrganization,
  getBilling,
  needsRenewal,
  resumeSubscription,
  settleTestPayment,
  startSubscription,
  type Subscription,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;
const DAY = 86_400_000;

describe('contractEnd (opzegtermijn van 1 maand)', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  it('maand: op tijd opgezegd stopt aan het einde van de periode', () => {
    const end = new Date('2027-01-10T12:00:00Z');
    expect(contractEnd({ currentPeriodEnd: end, interval: 'maand' }, 1, now)).toEqual(end);
  });
  it('maand: te laat opgezegd loopt nog een maand door', () => {
    const end = new Date('2026-12-10T12:00:00Z');
    expect(contractEnd({ currentPeriodEnd: end, interval: 'maand' }, 1, now).toISOString().slice(0, 10)).toBe('2027-01-10');
  });
  it('jaar: te laat opgezegd verlengt nog een jaar', () => {
    const end = new Date('2026-12-10T12:00:00Z');
    expect(contractEnd({ currentPeriodEnd: end, interval: 'jaar' }, 1, now).toISOString().slice(0, 10)).toBe('2027-12-10');
  });
  it('jaar: ruim op tijd opgezegd stopt aan het einde van het jaar', () => {
    const end = new Date('2027-06-01T12:00:00Z');
    expect(contractEnd({ currentPeriodEnd: end, interval: 'jaar' }, 1, now)).toEqual(end);
  });
  it('precies op de uiterste dag telt nog als op tijd', () => {
    const end = new Date('2026-12-27T12:00:00Z');
    expect(contractEnd({ currentPeriodEnd: end, interval: 'maand' }, 1, now)).toEqual(end);
  });
  it('needsRenewal: opgezegd zonder extra periode geeft geen incasso', () => {
    const base = { currentPeriodEnd: new Date(Date.now() + 10 * DAY), cancelAtPeriodEnd: true, endsAt: new Date(Date.now() + 10 * DAY) } as Subscription;
    expect(needsRenewal({ ...base, status: 'opgezegd' })).toBe(false);
    expect(needsRenewal({ ...base, status: 'opgezegd', cancelAtPeriodEnd: false, endsAt: new Date(Date.now() + 40 * DAY) })).toBe(true);
    expect(needsRenewal({ ...base, status: 'actief', cancelAtPeriodEnd: false, endsAt: null })).toBe(true);
    expect(needsRenewal({ ...base, status: 'beeindigd' })).toBe(false);
  });
});

describe.skipIf(!hasDb)('opzeggen met opzegtermijn en stilzwijgende verlenging', () => {
  let p: TestPlatform;
  let eigenaar: U;

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'tim@bakkerij.nl');
  });
  afterAll(async () => p?.close());

  async function betaaldAbonnement(naam: string, interval: 'maand' | 'jaar', dagenOver: number) {
    const org = (await createOrganization(p, eigenaar, { name: naam, kind: 'klant' })).id;
    await startSubscription(p, eigenaar, org, { plan: 'mkb', interval });
    const { payment } = await checkoutSubscription(p, eigenaar, org);
    await settleTestPayment(p, eigenaar, payment.id, 'betaald');
    await p.pool.query(
      `UPDATE subscription SET status = 'actief', trial_ends_at = now() - interval '60 days',
              current_period_start = now() - interval '20 days', current_period_end = now() + make_interval(days => $2)
        WHERE organization_id = $1`,
      [org, dagenOver],
    );
    return org;
  }

  it('lopend contract kondigt de verlenging en de uiterste opzegdatum aan', async () => {
    const org = await betaaldAbonnement('Bakkerij Maand', 'maand', 25);
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.opzegtermijnMaanden).toBe(1);
    expect(b.verlenging).toMatchObject({ interval: 'maand' });
    expect(b.verlenging!.opzeggenUiterlijk.getTime()).toBeLessThan(Date.now());
    expect(b.opzeggen).toMatchObject({ nogEenBetaling: true });
  });

  it('maand, op tijd opgezegd: stopt aan het einde van de periode, geen betaling meer', async () => {
    const org = await betaaldAbonnement('Bakkerij Op Tijd', 'maand', 45);
    const before = await getBilling(p, eigenaar.userId, org);
    expect(before.opzeggen).toMatchObject({ nogEenBetaling: false });
    const s = await cancelSubscription(p, eigenaar, org);
    expect(s).toMatchObject({ status: 'opgezegd', cancelAtPeriodEnd: true });
    expect(s.endsAt).toEqual(s.currentPeriodEnd);
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.volgendeBetaling).toBeNull();
    expect(b.eindigtOp).toEqual(s.currentPeriodEnd);
    expect(needsRenewal(s)).toBe(false);
    await expect(checkoutSubscription(p, eigenaar, org)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('maand, te laat opgezegd: nog één maand, daarna klaar', async () => {
    const org = await betaaldAbonnement('Bakkerij Te Laat', 'maand', 10);
    const s = await cancelSubscription(p, eigenaar, org);
    expect(s).toMatchObject({ status: 'opgezegd', cancelAtPeriodEnd: false });
    expect(s.endsAt!.getTime()).toBeGreaterThan(s.currentPeriodEnd!.getTime() + 25 * DAY);
    expect(needsRenewal(s)).toBe(true);
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.volgendeBetaling).toMatchObject({ interval: 'maand' });
    expect(b.verlenging).toBeNull();
    expect(b.eindigtOp).toEqual(s.endsAt);

    // De laatste periode wordt betaald; de opzegging blijft staan.
    const { payment } = await checkoutSubscription(p, eigenaar, org);
    expect(payment.periodEnd).toEqual(s.endsAt);
    await settleTestPayment(p, eigenaar, payment.id, 'betaald');
    const after = (await getBilling(p, eigenaar.userId, org)).abonnement!;
    expect(after).toMatchObject({ status: 'opgezegd', cancelAtPeriodEnd: true });
    expect(after.currentPeriodEnd).toEqual(s.endsAt);
    expect(needsRenewal(after)).toBe(false);
    await expect(checkoutSubscription(p, eigenaar, org)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('jaar, te laat opgezegd: verlengt nog een jaar; intrekken zet alles terug', async () => {
    const org = await betaaldAbonnement('Bakkerij Jaar', 'jaar', 10);
    const s = await cancelSubscription(p, eigenaar, org);
    expect(s.endsAt!.getTime()).toBeGreaterThan(s.currentPeriodEnd!.getTime() + 360 * DAY);
    expect((await getBilling(p, eigenaar.userId, org)).volgendeBetaling).toMatchObject({ interval: 'jaar' });
    await expect(cancelSubscription(p, eigenaar, org)).rejects.toMatchObject({ code: 'conflict' });
    const back = await resumeSubscription(p, eigenaar, org);
    expect(back).toMatchObject({ status: 'actief', cancelAtPeriodEnd: false, endsAt: null });
  });

  it('na de einddatum is er geen toegang meer', async () => {
    const org = await betaaldAbonnement('Bakkerij Voorbij', 'maand', 45);
    await cancelSubscription(p, eigenaar, org);
    await p.pool.query(`UPDATE subscription SET current_period_end = now() - interval '1 day', ends_at = now() - interval '1 day' WHERE organization_id = $1`, [org]);
    expect((await getBilling(p, eigenaar.userId, org)).toegang).toBe('geen_abonnement');
  });
});
