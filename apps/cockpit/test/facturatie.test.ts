import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { cockpitHarness } from './support.ts';

describe.skipIf(!hasDb)('cockpit: abonnementen, facturen en betaalwijze', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let admin: string;
  let support: string;
  let fin: string;
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(`INSERT INTO organization (id, name, kind) VALUES ($1, 'Bakkerij De Korst', 'klant'), ($2, 'Groep Noord Holding', 'klant')`, [A, B]);
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end)
       VALUES ($1, 'mkb', 'jaar', 4900, 'actief', now(), now() + interval '1 year'),
              ($2, 'business', 'maand', 17900, 'achterstallig', now() - interval '1 month', now())`,
      [A, B],
    );
    await q.query(
      `INSERT INTO payment (organization_id, subscription_id, description, amount_excl_cents, vat_cents, amount_incl_cents, status, provider, paid_at, refunded_cents, refunded_at)
       SELECT organization_id, id, 'MKB jaar 2026', 58800, 12348, 71148, 'betaald', 'nep', now(), 0, NULL::timestamptz FROM subscription WHERE organization_id = $1
       UNION ALL
       SELECT organization_id, id, 'Business november', 17900, 3759, 21659, 'mislukt', 'nep', NULL::timestamptz, 0, NULL::timestamptz FROM subscription WHERE organization_id = $2
       UNION ALL
       SELECT organization_id, id, 'Business oktober', 17900, 3759, 21659, 'betaald', 'nep', now(), 21659, now() FROM subscription WHERE organization_id = $2`,
      [A, B],
    );
    admin = await h.login('beheer@qbicle.test', 'beheerder');
    support = await h.login('support@qbicle.test', 'support');
    fin = await h.login('fin@qbicle.test', 'financieel');
  });
  afterAll(async () => h?.close());

  it('abonnementen: lopend, filter op status, MRR', async () => {
    const html = await (await h.get('/abonnementen', admin)).text();
    expect(html).toContain('Bakkerij De Korst');
    expect(html).toContain('Groep Noord Holding');
    expect(html).toMatch(/€\s228\b/); // 49 + 179
    const achter = await (await h.get('/abonnementen?status=achterstallig', admin)).text();
    expect(achter).toContain('Groep Noord Holding');
    expect(achter).not.toContain('Bakkerij De Korst');
  });

  it('facturen: statussen en totalen, terugbetaald apart', async () => {
    const all = await (await h.get('/facturen', admin)).text();
    expect(all).toContain('MKB jaar 2026');
    expect(all).toContain('Terugbetaald');
    const mislukt = await (await h.get('/facturen?status=mislukt', admin)).text();
    expect(mislukt).toContain('Business november');
    expect(mislukt).not.toContain('MKB jaar 2026');
    const terug = await (await h.get('/facturen?status=terugbetaald', admin)).text();
    expect(terug).toContain('Business oktober');
    expect(terug).not.toContain('Business november');
    const betaald = await (await h.get('/facturen?status=betaald', admin)).text();
    expect(betaald).toContain('MKB jaar 2026');
    expect(betaald).not.toContain('Business oktober');
  });

  it('betaalwijze per klant: factuur vraagt een reden, alleen financieel/beheerder, in audit-log', async () => {
    const url = `/api/klanten/${B}/betaalwijze`;
    expect((await h.post(url, { methode: 'factuur', termijnDagen: 30 }, support)).status).toBe(403);
    expect((await h.post(url, { methode: 'factuur', termijnDagen: 30, notitie: '' }, fin)).status).toBe(400);
    expect((await h.post(url, { methode: 'factuur', termijnDagen: 120, notitie: 'x' }, fin)).status).toBe(400);
    expect((await h.post(url, { methode: 'factuur', termijnDagen: 30, notitie: 'Raamovereenkomst 2027, PO-nummer verplicht' }, fin)).status).toBe(200);

    const org = (await h.p.pool.query('SELECT payment_method, payment_terms_days FROM organization WHERE id = $1', [B])).rows[0];
    expect(org).toEqual({ payment_method: 'factuur', payment_terms_days: 30 });
    expect(await (await h.get('/abonnementen?methode=factuur', admin)).text()).toContain('Groep Noord Holding');
    expect(await (await h.get('/abonnementen?methode=factuur', admin)).text()).not.toContain('Bakkerij De Korst');

    const tab = await (await h.get(`/klanten/${B}?tab=facturatie`, support)).text();
    expect(tab).toContain('Raamovereenkomst 2027');
    expect(tab).not.toContain(`data-api="${url}"`);

    const log = await h.p.pool.query(`SELECT detail FROM audit_log WHERE action = 'cockpit.betaalwijze_gewijzigd' AND organization_id = $1`, [B]);
    expect(log.rows[0].detail).toMatchObject({ van: 'incasso', naar: 'factuur', termijn: 30 });
    expect((await h.post(url, { methode: 'incasso', termijnDagen: 14 }, admin)).status).toBe(200);
  });
});
