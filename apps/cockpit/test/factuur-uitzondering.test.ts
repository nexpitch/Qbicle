import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@qbicle/platform';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { isInvoiceException } from '../src/labels.tsx';
import { cockpitHarness } from './support.ts';

/** Factuur buiten Corporate met jaarcontract is maatwerk en moet in de cockpit opvallen. */
describe('factuur-uitzondering herkennen', () => {
  const c = loadCatalog();
  it('alleen factuur buiten Corporate jaar is een uitzondering', () => {
    expect(isInvoiceException(c, 'factuur', 'business', 'jaar')).toBe(false);
    expect(isInvoiceException(c, 'factuur', 'business', 'maand')).toBe(true);
    expect(isInvoiceException(c, 'factuur', 'mkb', 'jaar')).toBe(true);
    expect(isInvoiceException(c, 'incasso', 'mkb', 'maand')).toBe(false);
  });
});

describe.skipIf(!hasDb)('cockpit: factuur-uitzonderingen', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let admin: string;
  const STD = '31111111-1111-4111-8111-111111111111';
  const UITZ = '32222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(
      `INSERT INTO organization (id, name, kind, payment_method, payment_method_note) VALUES
         ($1, 'Holding Standaard', 'klant', 'factuur', 'jaarcontract'), ($2, 'Winkel Maatwerk', 'klant', 'factuur', 'oude afspraak')`,
      [STD, UITZ],
    );
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end)
       VALUES ($1, 'business', 'jaar', 14900, 'actief', now(), now() + interval '1 year'),
              ($2, 'mkb', 'maand', 5900, 'actief', now(), now() + interval '1 month')`,
      [STD, UITZ],
    );
    admin = await h.login('beheer@qbicle.test', 'beheerder');
  });
  afterAll(async () => h?.close());

  it('abonnementen: filter "Factuur, uitzondering" toont alleen maatwerk', async () => {
    const html = await (await h.get('/abonnementen?methode=uitzondering', admin)).text();
    expect(html).toContain('Winkel Maatwerk');
    expect(html).not.toContain('Holding Standaard');
    expect(html).toContain('Uitzondering');
  });

  it('klantdetail: melding bij een uitzondering, niet bij Corporate jaar', async () => {
    const u = await (await h.get(`/klanten/${UITZ}?tab=facturatie`, admin)).text();
    expect(u).toContain('Uitzondering.');
    const s = await (await h.get(`/klanten/${STD}?tab=facturatie`, admin)).text();
    expect(s).not.toContain('Uitzondering.');
  });
});
