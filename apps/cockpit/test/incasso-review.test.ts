import { accessState, cancelSubscription, checkoutSubscription, GRACE_DAYS, isNepProvider, syncPayment, type Subscription } from '@qbicle/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { amsterdamDate } from '../src/core/collections.ts';
import { cockpitHarness } from './support.ts';

/**
 * Scenario's uit de review van PR 15: wat de klant doet tussen klaarzetten en
 * indienen, en terwijl de incasso bij de bank ligt.
 */

describe('toegang bij achterstallig (I6)', () => {
  const sub = (end: Date): Subscription =>
    ({ status: 'achterstallig', currentPeriodEnd: end, trialEndsAt: null }) as unknown as Subscription;
  it('houdt toegang tot het einde van de betaalde periode plus respijt', () => {
    const now = new Date();
    expect(accessState(sub(new Date(now.getTime() + 2 * 86_400_000)), now)).toBe('actief');
    expect(accessState(sub(new Date(now.getTime() - (GRACE_DAYS - 1) * 86_400_000)), now)).toBe('actief');
    expect(accessState(sub(new Date(now.getTime() - (GRACE_DAYS + 1) * 86_400_000)), now)).toBe('betaling_nodig');
  });
});

describe.skipIf(!hasDb)('cockpit: incasso en wat de klant ondertussen doet', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let fin: string;
  const X = '10000000-0000-4000-8000-000000000001'; // zegt op terwijl de incasso loopt
  const Y = '10000000-0000-4000-8000-000000000002'; // betaalt zelf na klaarzetten
  const Z = '10000000-0000-4000-8000-000000000003'; // gaat naar factuur na klaarzetten
  const W = '10000000-0000-4000-8000-000000000004'; // trekt machtiging in na klaarzetten
  const D = '10000000-0000-4000-8000-000000000005'; // geplande downgrade
  const owner: Record<string, string> = {};
  const today = () => amsterdamDate(new Date());
  const itemOf = async (org: string) =>
    (await h.p.pool.query('SELECT id, status, exclude_reason, failure_reason, payment_id FROM collection_item WHERE organization_id = $1', [org])).rows[0];
  const subOf = async (org: string) =>
    (await h.p.pool.query(`SELECT plan, pending_plan, status, cancel_at_period_end, current_period_end > now() + interval '20 days' AS verlengd FROM subscription WHERE organization_id = $1`, [org])).rows[0];
  const settleSelf = async (paymentId: string) => {
    const r = (await h.p.pool.query('SELECT provider_payment_id FROM payment WHERE id = $1', [paymentId])).rows[0];
    if (!isNepProvider(h.p.payments)) throw new Error('testmodus verwacht');
    h.p.payments.settle(r.provider_payment_id, 'betaald');
    return syncPayment(h.p, paymentId);
  };

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    const orgs = [X, Y, Z, W, D];
    for (const [i, id] of orgs.entries()) {
      await q.query(`INSERT INTO organization (id, name, kind, payment_method) VALUES ($1, $2, 'klant', 'incasso')`, [id, `Klant ${i + 1}`]);
      const u = (await q.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`eigenaar${i + 1}@klant.test`])).rows[0].id as string;
      await q.query(`INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')`, [id, u]);
      owner[id] = u;
    }
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end, pending_plan, pending_interval)
       SELECT id, CASE WHEN id = $2 THEN 'business' ELSE 'mkb' END, 'maand', CASE WHEN id = $2 THEN 17900 ELSE 5900 END, 'actief',
              now() - interval '1 month', now() - interval '1 hour',
              CASE WHEN id = $2 THEN 'mkb' END, CASE WHEN id = $2 THEN 'maand' END
         FROM organization WHERE id = ANY($1)`,
      [orgs, D],
    );
    fin = await h.login('fin@qbicle.test', 'financieel');
  });
  afterAll(async () => h?.close());

  it('I5: de incassodatum is begrensd', async () => {
    for (const d of ['2031-01-01', '2026-02-31', '2000-01-01', 'morgen']) {
      expect((await h.post('/api/incasso', { incassodatum: d }, fin)).status).toBe(400);
    }
  });

  let runId: string;
  it('I4: klaarzetten rekent met de downgrade maar wijzigt het abonnement niet', async () => {
    const res = await h.post('/api/incasso', { incassodatum: today() }, fin);
    expect(res.status).toBe(201);
    runId = ((await res.json()) as { batch: string }).batch;
    expect(await subOf(D)).toMatchObject({ plan: 'business', pending_plan: 'mkb' });
    expect((await h.post(`/api/incasso/${runId}/valideren`, {}, fin)).status).toBe(200);
  });

  it('I1 en I3: wat de klant na klaarzetten deed, gaat bij indienen automatisch uit de batch', async () => {
    // Y betaalt zelf, Z gaat naar factuur, W trekt de machtiging in.
    const self = await checkoutSubscription(h.p, { userId: owner[Y]! }, Y);
    expect((await settleSelf(self.payment.id)).status).toBe('betaald');
    await h.p.pool.query(`UPDATE organization SET payment_method = 'factuur', payment_method_note = 'afspraak' WHERE id = $1`, [Z]);
    await h.p.pool.query(`INSERT INTO payment_mandate (organization_id, provider, status, revoked_at) VALUES ($1, 'nep', 'ingetrokken', now())`, [W]);

    const res = await h.post(`/api/incasso/${runId}/indienen`, {}, fin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingediend: 2, automatischUitgesloten: 3 });

    expect(await itemOf(Y)).toMatchObject({ status: 'uitgesloten', exclude_reason: 'De klant heeft deze periode zelf al betaald.', payment_id: null });
    expect((await h.p.pool.query(`SELECT count(*)::int AS n FROM invoice WHERE organization_id = $1`, [Y])).rows[0].n).toBe(1);
    expect(await itemOf(Z)).toMatchObject({ status: 'uitgesloten', exclude_reason: 'Deze klant betaalt nu op factuur.' });
    const w = await itemOf(W);
    expect(w).toMatchObject({ status: 'uitgesloten', failure_reason: 'mandaat_ingetrokken' });
    expect((await h.p.pool.query('SELECT suggested_action FROM collection_followup WHERE item_id = $1', [w.id])).rows[0].suggested_action).toBe('factuur_sturen');
  });

  it('I2: zolang de incasso loopt kan de klant niet nog eens betalen, en opzeggen annuleert de incasso niet', async () => {
    await expect(checkoutSubscription(h.p, { userId: owner[X]! }, X)).rejects.toMatchObject({ code: 'conflict' });
    await cancelSubscription(h.p, { userId: owner[X]! }, X, { reden: 'te_duur' });
    const x = await itemOf(X);
    expect((await h.p.pool.query('SELECT status FROM payment WHERE id = $1', [x.payment_id])).rows[0].status).toBe('open');

    // De bank schrijft af: de periode is betaald, de opzegging blijft staan.
    const r = await h.post(`/api/incasso/regels/${x.id}/testuitkomst`, { uitkomst: 'betaald' }, fin);
    expect(((await r.json()) as { status: string }).status).toBe('betaald');
    expect(await subOf(X)).toMatchObject({ status: 'opgezegd', cancel_at_period_end: true, verlengd: true });
  });

  it('I4: de downgrade gaat in zodra de verlenging betaald is', async () => {
    const d = await itemOf(D);
    await h.post(`/api/incasso/regels/${d.id}/testuitkomst`, { uitkomst: 'betaald' }, fin);
    expect(await subOf(D)).toMatchObject({ plan: 'mkb', pending_plan: null, status: 'actief', verlengd: true });
  });
});
