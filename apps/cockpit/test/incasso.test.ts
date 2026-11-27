import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { prepareRun } from '../src/core/collections.ts';
import { parseEuro } from '../src/modules/incasso.tsx';
import { cockpitHarness } from './support.ts';

describe('parseEuro', () => {
  it('leest Nederlandse en gewone notatie', () => {
    expect(parseEuro('49')).toBe(4900);
    expect(parseEuro('49,5')).toBe(4950);
    expect(parseEuro('€ 1.234,56')).toBe(123456);
    expect(parseEuro('12.50')).toBe(1250);
    expect(Number.isNaN(parseEuro('abc'))).toBe(true);
  });
});

describe.skipIf(!hasDb)('cockpit: incassobatch', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let admin: string;
  let fin: string;
  let support: string;
  const A = '11111111-1111-4111-8111-111111111111'; // maand, vervalt
  const B = '22222222-2222-4222-8222-222222222222'; // jaar, vervalt
  const C = '33333333-3333-4333-8333-333333333333'; // betaalt op factuur
  const D = '44444444-4444-4444-8444-444444444444'; // vervalt pas later
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(
      `INSERT INTO organization (id, name, kind, payment_method, payment_method_note) VALUES
        ($1, 'Bakkerij De Korst', 'klant', 'incasso', NULL), ($2, 'Van Dijk Advocaten', 'klant', 'incasso', NULL),
        ($3, 'Groep Noord Holding', 'klant', 'factuur', 'raamovereenkomst'), ($4, 'Later BV', 'klant', 'incasso', NULL)`,
      [A, B, C, D],
    );
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end) VALUES
        ($1, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour'),
        ($2, 'business', 'jaar', 14900, 'actief', now() - interval '1 year', now() - interval '1 hour'),
        ($3, 'business', 'maand', 17900, 'actief', now() - interval '1 month', now() - interval '1 hour'),
        ($4, 'mkb', 'maand', 5900, 'actief', now(), now() + interval '20 days')`,
      [A, B, C, D],
    );
    admin = await h.login('beheer@qbicle.test', 'beheerder');
    fin = await h.login('fin@qbicle.test', 'financieel');
    support = await h.login('support@qbicle.test', 'support');
  });
  afterAll(async () => h?.close());

  let runId: string;
  let items: Array<{ id: string; organization_id: string; amount_excl_cents: number; amount_incl_cents: number }>;

  it('klaarzetten: alleen incasso-klanten die vervallen, juiste bedragen met btw', async () => {
    expect((await h.post('/api/incasso', { incassodatum: today() }, support)).status).toBe(403);
    const res = await h.post('/api/incasso', { incassodatum: today() }, fin);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { batch: string; regels: number; overgeslagenFactuur: number };
    expect(body.regels).toBe(2);
    expect(body.overgeslagenFactuur).toBe(1);
    runId = body.batch;
    items = (await h.p.pool.query('SELECT id, organization_id, amount_excl_cents, amount_incl_cents FROM collection_item WHERE run_id = $1', [runId])).rows;
    const a = items.find((i) => i.organization_id === A)!;
    const b = items.find((i) => i.organization_id === B)!;
    expect(a.amount_excl_cents).toBe(5900);
    expect(a.amount_incl_cents).toBe(7139);
    expect(b.amount_excl_cents).toBe(14900 * 12);

    // Nog een keer klaarzetten levert geen dubbele regels op.
    expect((await h.post('/api/incasso', { incassodatum: today() }, fin)).status).toBe(409);
    expect(await prepareRun(h.p, { collectionDate: today(), source: 'agent' }, { userId: null })).toBeUndefined();

    const page = await (await h.get(`/incasso/${runId}`, admin)).text();
    expect(page).toContain('Bakkerij De Korst');
    expect(page).not.toContain('Groep Noord Holding');
    expect(page).not.toContain('Later BV');
  });

  it('controleren: uitsluiten, terugzetten en bedrag aanpassen met reden', async () => {
    const a = items.find((i) => i.organization_id === A)!;
    const b = items.find((i) => i.organization_id === B)!;
    expect((await h.post(`/api/incasso/${runId}/regels/${b.id}/uitsluiten`, { reden: '' }, fin)).status).toBe(400);
    expect((await h.post(`/api/incasso/${runId}/regels/${b.id}/uitsluiten`, { reden: 'Klant belt eerst' }, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/${runId}/regels/${b.id}/terugzetten`, {}, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/${runId}/regels/${a.id}/bedrag`, { bedrag: 'veel', reden: 'x' }, fin)).status).toBe(400);
    expect((await h.post(`/api/incasso/${runId}/regels/${a.id}/bedrag`, { bedrag: '29,50', reden: '50% korting deze maand' }, fin)).status).toBe(200);
    const row = (await h.p.pool.query('SELECT amount_excl_cents, vat_cents, amount_incl_cents, original_excl_cents FROM collection_item WHERE id = $1', [a.id])).rows[0];
    expect(row).toEqual({ amount_excl_cents: 2950, vat_cents: 620, amount_incl_cents: 3570, original_excl_cents: 5900 });
  });

  it('indienen kan pas na valideren, en maar één keer', async () => {
    expect((await h.post(`/api/incasso/${runId}/indienen`, {}, fin)).status).toBe(409);
    expect((await h.post(`/api/incasso/${runId}/valideren`, {}, support)).status).toBe(403);
    expect((await h.post(`/api/incasso/${runId}/valideren`, {}, fin)).status).toBe(200);
    // Na valideren niets meer wijzigen.
    const a = items.find((i) => i.organization_id === A)!;
    expect((await h.post(`/api/incasso/${runId}/regels/${a.id}/uitsluiten`, { reden: 'toch niet' }, fin)).status).toBe(409);

    const page = await (await h.get(`/incasso/${runId}`, admin)).text();
    expect(page).toContain('Indienen: 2 incasso');

    const [r1, r2] = await Promise.all([h.post(`/api/incasso/${runId}/indienen`, {}, admin), h.post(`/api/incasso/${runId}/indienen`, {}, admin)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const pays = await h.p.pool.query(`SELECT status, provider_payment_id FROM payment WHERE description LIKE 'Incasso:%'`);
    expect(pays.rows).toHaveLength(2);
    expect(pays.rows.every((x) => x.status === 'open' && x.provider_payment_id)).toBe(true);
  });

  it('uitkomsten (testmodus): betaald verlengt en maakt factuur, mislukt maakt achterstallig', async () => {
    const a = items.find((i) => i.organization_id === A)!;
    const b = items.find((i) => i.organization_id === B)!;
    const okRes = await h.post(`/api/incasso/regels/${a.id}/testuitkomst`, { uitkomst: 'betaald' }, fin);
    expect(((await okRes.json()) as { status: string }).status).toBe('betaald');
    const failRes = await h.post(`/api/incasso/regels/${b.id}/testuitkomst`, { uitkomst: 'mislukt', reden: 'geen_dekking' }, fin);
    expect(((await failRes.json()) as { status: string }).status).toBe('mislukt');

    const subA = (await h.p.pool.query(`SELECT status, current_period_end > now() + interval '20 days' AS verlengd FROM subscription WHERE organization_id = $1`, [A])).rows[0];
    expect(subA).toEqual({ status: 'actief', verlengd: true });
    expect((await h.p.pool.query('SELECT count(*)::int AS n FROM invoice WHERE organization_id = $1', [A])).rows[0].n).toBe(1);
    expect((await h.p.pool.query('SELECT status FROM subscription WHERE organization_id = $1', [B])).rows[0].status).toBe('achterstallig');
    const item = (await h.p.pool.query('SELECT failure_reason FROM collection_item WHERE id = $1', [b.id])).rows[0];
    expect(item.failure_reason).toBe('geen_dekking');
    expect((await h.p.pool.query('SELECT status FROM collection_run WHERE id = $1', [runId])).rows[0].status).toBe('afgerond');

    const overzicht = await (await h.get('/incasso', admin)).text();
    expect(overzicht).toContain('1 mislukt');

    const log = (await h.p.pool.query(`SELECT action FROM audit_log WHERE action LIKE 'cockpit.incasso%' ORDER BY id`)).rows.map((r) => r.action);
    expect(log).toEqual([
      'cockpit.incasso_klaargezet',
      'cockpit.incasso_regel_uitgesloten',
      'cockpit.incasso_regel_teruggezet',
      'cockpit.incasso_regel_aangepast',
      'cockpit.incasso_gevalideerd',
      'cockpit.incasso_ingediend',
      'cockpit.incasso_mislukt',
    ]);
  });

  it('annuleren geeft de periode weer vrij voor een nieuwe batch', async () => {
    await h.p.pool.query(`UPDATE subscription SET current_period_end = now() - interval '1 hour' WHERE organization_id = $1`, [D]);
    const r = (await (await h.post('/api/incasso', { incassodatum: today() }, fin)).json()) as { batch: string; regels: number };
    expect(r.regels).toBe(1);
    expect((await h.post(`/api/incasso/${r.batch}/annuleren`, {}, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/${r.batch}/indienen`, {}, admin)).status).toBe(409);
    expect((await h.post('/api/incasso', { incassodatum: today() }, fin)).status).toBe(201);
  });
});

describe.skipIf(!hasDb)('cockpit: incassobatch en klantaccount (pakketwissel, machtiging, extra domeinen)', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let fin: string;
  const E = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // downgrade gepland
  const F = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // 5 domeinen, limiet 3
  const G = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // machtiging ingetrokken
  const H = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // open bijbetaling voor upgrade
  const today = () => new Date().toISOString().slice(0, 10);
  const item = async (org: string) =>
    (await h.p.pool.query('SELECT id, description, amount_excl_cents, status, failure_reason, lines FROM collection_item WHERE organization_id = $1', [org])).rows;

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(
      `INSERT INTO organization (id, name, kind, payment_method) VALUES
        ($1, 'Downgrade BV', 'klant', 'incasso'), ($2, 'Veel Domeinen BV', 'klant', 'incasso'),
        ($3, 'Zonder Machtiging BV', 'klant', 'incasso'), ($4, 'Upgrade BV', 'klant', 'incasso')`,
      [E, F, G, H],
    );
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end, pending_plan, pending_interval) VALUES
        ($1, 'business', 'maand', 17900, 'actief', now() - interval '1 month', now() - interval '1 hour', 'mkb', 'maand'),
        ($2, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour', NULL, NULL),
        ($3, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour', NULL, NULL),
        ($4, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour', NULL, NULL)`,
      [E, F, G, H],
    );
    await q.query(`INSERT INTO domain (organization_id, name, verification_token) SELECT $1, 'd' || g || '.nl', 'tok' || g FROM generate_series(1, 5) g`, [F]);
    await q.query(`INSERT INTO payment_mandate (organization_id, provider, status, revoked_at) VALUES ($1, 'nep', 'ingetrokken', now())`, [G]);
    await q.query(
      `INSERT INTO payment (organization_id, subscription_id, description, period_start, period_end, amount_excl_cents, vat_cents, amount_incl_cents, status, provider, plan_change)
       SELECT organization_id, id, 'Bijbetaling upgrade', current_period_end, current_period_end + interval '1 month', 1000, 210, 1210, 'open', 'nep', '{"naar":"business"}'
         FROM subscription WHERE organization_id = $1`,
      [H],
    );
    fin = await h.login('fin@qbicle.test', 'financieel');
  });
  afterAll(async () => h?.close());

  it('zet de juiste regels klaar', async () => {
    const res = await h.post('/api/incasso', { incassodatum: today() }, fin);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { batch: string; regels: number; zonderMachtiging: number };
    expect(body).toMatchObject({ regels: 3, zonderMachtiging: 1 });

    // Geplande downgrade: er wordt met het nieuwe pakket gerekend, maar er verandert nog niets.
    const [e] = await item(E);
    expect(e.description).toContain('Qbicle MKB');
    expect(e.amount_excl_cents).toBe(h.p.catalog.plans.find((x) => x.id === 'mkb')!.maandprijsCenten.maand);
    expect((await h.p.pool.query('SELECT plan, pending_plan FROM subscription WHERE organization_id = $1', [E])).rows[0]).toEqual({ plan: 'business', pending_plan: 'mkb' });

    // Extra domeinen boven de limiet als eigen factuurregel.
    const [f] = await item(F);
    const extra = 2 * h.p.catalog.extraDomeinCenten;
    expect(f.amount_excl_cents).toBe(5900 + extra);
    expect(f.lines).toHaveLength(2);
    expect(f.lines[1]).toMatchObject({ aantal: 2, totaalExclCenten: extra });

    // Ingetrokken machtiging: niet incasseren, wel meteen een betaalverzoek klaar.
    const [g] = await item(G);
    expect(g).toMatchObject({ status: 'uitgesloten', failure_reason: 'mandaat_ingetrokken' });
    const fu = (await h.p.pool.query('SELECT suggested_action FROM collection_followup WHERE item_id = $1', [g.id])).rows[0];
    expect(fu.suggested_action).toBe('factuur_sturen');
    expect((await h.post(`/api/incasso/${body.batch}/regels/${g.id}/terugzetten`, {}, fin)).status).toBe(409);

    // Een open bijbetaling voor een upgrade is geen verlenging.
    expect(await item(H)).toHaveLength(1);

    // Opnieuw klaarzetten maakt geen tweede regel of voorstel voor de klant zonder machtiging.
    expect((await h.post('/api/incasso', { incassodatum: today() }, fin)).status).toBe(409);

    // Factuurregels gaan mee naar betaling en factuur.
    expect((await h.post(`/api/incasso/${body.batch}/valideren`, {}, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/${body.batch}/indienen`, {}, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/regels/${f.id}/testuitkomst`, { uitkomst: 'betaald' }, fin)).status).toBe(200);
    const inv = (await h.p.pool.query('SELECT lines, amount_excl_cents FROM invoice WHERE organization_id = $1', [F])).rows[0];
    expect(inv.amount_excl_cents).toBe(5900 + extra);
    expect(inv.lines).toHaveLength(2);
  });
});
