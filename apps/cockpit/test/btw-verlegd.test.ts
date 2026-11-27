import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { getAttention } from '../src/core/overview.ts';
import { cockpitHarness } from './support.ts';

/** Btw verlegd bij de incassobatch: bij elke verlenging VIES opnieuw, en een melding als het stopt. */
describe.skipIf(!hasDb)('cockpit: btw verlegd bij verlengen', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let fin: string;
  const BE = '55555555-5555-4555-8555-555555555555'; // geldig btw-nummer
  const DE = '66666666-6666-4666-8666-666666666666'; // was geldig, nu ongeldig
  const NL = '77777777-7777-4777-8777-777777777777';
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(
      `INSERT INTO organization (id, name, kind, billing_country, vat_number) VALUES
        ($1, 'Brouwerij Gent', 'klant', 'BE', 'BE0123456789'),
        ($2, 'Werkstatt Köln', 'klant', 'DE', 'DE123456789'),
        ($3, 'Bakkerij Utrecht', 'klant', 'NL', 'NL123456789B01')`,
      [BE, DE, NL],
    );
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end)
       SELECT id, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour' FROM organization WHERE id = ANY($1)`,
      [[BE, DE, NL]],
    );
    // Beide EU-klanten waren een maand geleden geldig.
    await q.query(
      `INSERT INTO vat_check (organization_id, country, vat_number, status, source, checked_at) VALUES
        ($1, 'BE', 'BE0123456789', 'geldig', 'klant', now() - interval '30 days'),
        ($2, 'DE', 'DE123456789', 'geldig', 'klant', now() - interval '30 days')`,
      [BE, DE],
    );
    h.p.vies.outcomes.set('DE123456789', 'ongeldig');
    fin = await h.login('fin@qbicle.test', 'financieel');
  });
  afterAll(async () => h?.close());

  it('klaarzetten controleert opnieuw bij VIES en rekent per klant de juiste btw', async () => {
    const res = await h.post('/api/incasso', { incassodatum: today() }, fin);
    expect(res.status).toBe(201);
    const { batch } = (await res.json()) as { batch: string };
    // Alleen de twee EU-klanten buiten NL, met bron 'verlenging'.
    expect(h.p.vies.calls.map((c) => c.countryCode).sort()).toEqual(['BE', 'DE']);
    const src = await h.p.pool.query(`SELECT DISTINCT source FROM vat_check WHERE checked_at > now() - interval '1 minute'`);
    expect(src.rows.map((r) => r.source)).toEqual(['verlenging']);

    const items = (await h.p.pool.query('SELECT organization_id, amount_excl_cents, vat_cents, vat_code, vat_rate FROM collection_item WHERE run_id = $1', [batch])).rows;
    const by = (id: string) => items.find((i) => i.organization_id === id)!;
    expect(by(BE)).toMatchObject({ vat_cents: 0, vat_code: 'eu_verlegd' });
    expect(by(DE)).toMatchObject({ vat_cents: 1239, vat_code: 'nl_standaard' });
    expect(by(NL)).toMatchObject({ vat_cents: 1239, vat_code: 'nl_standaard' });

    // Bedrag aanpassen houdt de btw-stand van de regel aan.
    const beItem = (await h.p.pool.query('SELECT id FROM collection_item WHERE run_id = $1 AND organization_id = $2', [batch, BE])).rows[0].id;
    expect((await h.post(`/api/incasso/${batch}/regels/${beItem}/bedrag`, { bedrag: '40', reden: 'korting' }, fin)).status).toBeLessThan(300);
    const adj = (await h.p.pool.query('SELECT amount_excl_cents, vat_cents FROM collection_item WHERE id = $1', [beItem])).rows[0];
    expect(adj).toEqual({ amount_excl_cents: 4000, vat_cents: 0 });
  });

  it('ongeldig geworden: melding in het overzicht en zichtbaar bij de klant', async () => {
    const att = await getAttention(h.p.pool);
    const a = att.find((x) => x.kind === 'btw_verlegd_gestopt');
    expect(a).toMatchObject({ organizationId: DE });
    expect(a!.detail).toMatch(/ongeldig/);
    const page = await (await h.get(`/klanten/${DE}`, fin)).text();
    expect(page).toContain('Ongeldig op');
    const be = await (await h.get(`/klanten/${BE}`, fin)).text();
    expect(be).toContain('Verlegd, 0%');
    expect((await (await h.get('/', fin)).text())).toContain('Btw verlegd gestopt');
  });
});
