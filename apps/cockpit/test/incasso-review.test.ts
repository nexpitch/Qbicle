import { accessState, cancelSubscription, checkoutSubscription, GRACE_DAYS, isNepProvider, startSubscription, syncPayment, type Subscription } from '@qbicle/platform';
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

describe.skipIf(!hasDb)('cockpit: hercontrole (N1 t/m N4, N7)', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let fin: string;
  const M2J = '30000000-0000-4000-8000-000000000001'; // maand -> jaar gepland
  const J2M = '30000000-0000-4000-8000-000000000002'; // jaar -> maand gepland
  const TRUG = '30000000-0000-4000-8000-000000000003'; // trekt downgrade in na klaarzetten
  const NIEUW = '30000000-0000-4000-8000-000000000004'; // zegt op tijdens incasso, kiest nieuw pakket
  const OUD = '30000000-0000-4000-8000-000000000005'; // oude, nooit afgeronde betaalpagina
  const owner: Record<string, string> = {};
  const itemOf = async (org: string) =>
    (await h.p.pool.query(
      `SELECT id, status, exclude_reason, auto_excluded, amount_excl_cents, period_end - period_start AS lengte, payment_id FROM collection_item WHERE organization_id = $1`,
      [org],
    )).rows[0];

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    const orgs = [M2J, J2M, TRUG, NIEUW, OUD];
    for (const [i, id] of orgs.entries()) {
      await q.query(`INSERT INTO organization (id, name, kind, payment_method) VALUES ($1, $2, 'klant', 'incasso')`, [id, `Hercontrole ${i + 1}`]);
      const u = (await q.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`hc${i + 1}@klant.test`])).rows[0].id as string;
      await q.query(`INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')`, [id, u]);
      owner[id] = u;
    }
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end, pending_plan, pending_interval) VALUES
        ($1, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour', 'mkb', 'jaar'),
        ($2, 'mkb', 'jaar', 4900, 'actief', now() - interval '1 year', now() - interval '1 hour', 'mkb', 'maand'),
        ($3, 'business', 'maand', 17900, 'actief', now() - interval '1 month', now() - interval '1 hour', 'mkb', 'maand'),
        ($4, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour', NULL, NULL),
        ($5, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour', NULL, NULL)`,
      [M2J, J2M, TRUG, NIEUW, OUD],
    );
    // OUD opende twee uur geleden een betaalpagina en rondde die nooit af.
    const old = await checkoutSubscription(h.p, { userId: owner[OUD]! }, OUD);
    await q.query(`UPDATE payment SET created_at = now() - interval '2 hours' WHERE id = $1`, [old.payment.id]);
    fin = await h.login('fin@qbicle.test', 'financieel');
  });
  afterAll(async () => h?.close());

  let runId: string;
  it('N1: bij een termijnwissel horen bedrag en periode bij elkaar', async () => {
    const r = await h.post('/api/incasso', { incassodatum: amsterdamDate(new Date()) }, fin);
    runId = ((await r.json()) as { batch: string }).batch;
    const mkb = h.p.catalog.plans.find((x) => x.id === 'mkb')!;
    const m2j = await itemOf(M2J);
    expect(m2j.amount_excl_cents).toBe(mkb.maandprijsCenten.jaar * 12);
    expect([365, 366]).toContain(m2j.lengte.days);
    const j2m = await itemOf(J2M);
    expect(j2m.amount_excl_cents).toBe(mkb.maandprijsCenten.maand);
    expect(j2m.lengte.days).toBeGreaterThanOrEqual(28);
    expect(j2m.lengte.days).toBeLessThanOrEqual(31);
  });

  it('N2, N4: ingetrokken downgrade valt uit, een oude betaalpagina blokkeert niet; N7: uitval is zichtbaar', async () => {
    await h.p.pool.query(`UPDATE subscription SET pending_plan = NULL, pending_interval = NULL WHERE organization_id = $1`, [TRUG]);
    expect((await h.post(`/api/incasso/${runId}/valideren`, {}, fin)).status).toBe(200);
    const res = await h.post(`/api/incasso/${runId}/indienen`, {}, fin);
    expect(await res.json()).toEqual({ ingediend: 4, automatischUitgesloten: 1 });
    expect(await itemOf(TRUG)).toMatchObject({ status: 'uitgesloten', auto_excluded: true, exclude_reason: expect.stringContaining('gewijzigd na klaarzetten') });
    const oud = await itemOf(OUD);
    expect(oud.status).toBe('ingediend');
    // De oude betaalpagina is vervallen; de incasso loopt.
    expect((await h.p.pool.query(`SELECT count(*)::int AS n FROM payment WHERE organization_id = $1 AND status = 'open'`, [OUD])).rows[0].n).toBe(1);
    const page = await (await h.get(`/incasso/${runId}`, fin)).text();
    expect(page).toContain('vielen bij indienen automatisch uit');
  });

  it('N3: opzeggen tijdens de incasso en daarna een nieuw pakket kiezen laat de verwerking niet vastlopen', async () => {
    await cancelSubscription(h.p, { userId: owner[NIEUW]! }, NIEUW, { reden: 'anders' });
    await startSubscription(h.p, { userId: owner[NIEUW]! }, NIEUW, { plan: 'business', interval: 'maand' });
    const it = await itemOf(NIEUW);
    const r = await h.post(`/api/incasso/regels/${it.id}/testuitkomst`, { uitkomst: 'betaald' }, fin);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe('betaald');
    const subs = (await h.p.pool.query(`SELECT plan, status FROM subscription WHERE organization_id = $1 ORDER BY created_at`, [NIEUW])).rows;
    expect(subs.map((s) => s.status)).toEqual(['beeindigd', 'proef']);
    const note = (await h.p.pool.query(`SELECT body FROM org_note WHERE organization_id = $1 AND source = 'systeem'`, [NIEUW])).rows[0];
    expect(note.body).toContain('beëindigd abonnement');
  });

  it('N7: een batch waarvan alles uitvalt, is meteen afgerond', async () => {
    await h.p.pool.query(`UPDATE subscription SET current_period_end = now() - interval '1 hour', cancel_at_period_end = false WHERE organization_id = $1`, [TRUG]);
    const r = (await (await h.post('/api/incasso', { incassodatum: amsterdamDate(new Date()) }, fin)).json()) as { batch: string; regels: number };
    expect(r.regels).toBe(1);
    expect((await h.post(`/api/incasso/${r.batch}/valideren`, {}, fin)).status).toBe(200);
    await h.p.pool.query(`UPDATE organization SET payment_method = 'factuur', payment_method_note = 'x' WHERE id = $1`, [TRUG]);
    expect(await (await h.post(`/api/incasso/${r.batch}/indienen`, {}, fin)).json()).toEqual({ ingediend: 0, automatischUitgesloten: 1 });
    expect((await h.p.pool.query('SELECT status FROM collection_run WHERE id = $1', [r.batch])).rows[0].status).toBe('afgerond');
  });
});

describe.skipIf(!hasDb)('cockpit: incasso en opzegtermijn van 1 maand', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let fin: string;
  const LAAT = '20000000-0000-4000-8000-000000000001'; // te laat opgezegd: nog één verlenging
  const OP_TIJD = '20000000-0000-4000-8000-000000000002'; // op tijd opgezegd: huidige periode is de laatste
  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(`INSERT INTO organization (id, name, kind, payment_method) VALUES ($1, 'Te Laat BV', 'klant', 'incasso'), ($2, 'Op Tijd BV', 'klant', 'incasso')`, [LAAT, OP_TIJD]);
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end, cancel_at_period_end, ends_at, canceled_at) VALUES
        ($1, 'mkb', 'maand', 5900, 'opgezegd', now() - interval '1 month', now() - interval '1 hour', false, now() - interval '1 hour' + interval '1 month', now()),
        ($2, 'mkb', 'maand', 5900, 'opgezegd', now() - interval '1 month', now() - interval '1 hour', true, now() - interval '1 hour', now() - interval '2 months')`,
      [LAAT, OP_TIJD],
    );
    fin = await h.login('fin@qbicle.test', 'financieel');
  });
  afterAll(async () => h?.close());

  it('incasseert de laatste verlenging binnen de opzegtermijn, daarna niet meer', async () => {
    const res = await h.post('/api/incasso', { incassodatum: amsterdamDate(new Date()) }, fin);
    const run = ((await res.json()) as { batch: string; regels: number });
    expect(run.regels).toBe(1);
    const items = (await h.p.pool.query('SELECT id, organization_id FROM collection_item WHERE run_id = $1', [run.batch])).rows;
    expect(items.map((i) => i.organization_id)).toEqual([LAAT]);
    expect((await h.post(`/api/incasso/${run.batch}/valideren`, {}, fin)).status).toBe(200);
    expect(await (await h.post(`/api/incasso/${run.batch}/indienen`, {}, fin)).json()).toEqual({ ingediend: 1, automatischUitgesloten: 0 });
    await h.post(`/api/incasso/regels/${items[0].id}/testuitkomst`, { uitkomst: 'betaald' }, fin);
    const sub = (await h.p.pool.query('SELECT status, cancel_at_period_end FROM subscription WHERE organization_id = $1', [LAAT])).rows[0];
    expect(sub).toEqual({ status: 'opgezegd', cancel_at_period_end: true });
  });
});
