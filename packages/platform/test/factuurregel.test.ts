import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changePlan,
  createOrganization,
  getBilling,
  invoiceAllowed,
  loadCatalog,
  previewPlanChange,
  requestInvoicePayment,
  startSubscription,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

/**
 * Erik, 27-11-2026: betalen op factuur kan standaard alleen bij het Corporate-pakket
 * met jaarcontract. Maandelijks, en MKB (ook jaarlijks), is altijd automatische incasso.
 */
describe('factuurregel (zonder database)', () => {
  const c = loadCatalog();
  const mkb = c.plans.find((x) => x.product === 'mkb')!;
  const corp = c.plans.find((x) => x.product === 'corporate')!;
  it('alleen Corporate per jaar', () => {
    expect(invoiceAllowed(corp, 'jaar')).toBe(true);
    expect(invoiceAllowed(corp, 'maand')).toBe(false);
    expect(invoiceAllowed(mkb, 'jaar')).toBe(false);
    expect(invoiceAllowed(mkb, 'maand')).toBe(false);
    expect(invoiceAllowed(undefined, 'jaar')).toBe(false);
  });
});

type U = Awaited<ReturnType<typeof loginAs>>;

describe.skipIf(!hasDb)('factuurregel in de klantomgeving', () => {
  let p: TestPlatform;
  let eigenaar: U;

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'eva@groothandel.nl');
  });
  afterAll(async () => p?.close());

  async function nieuweKlant(naam: string, plan: string, interval: string) {
    const org = (await createOrganization(p, eigenaar, { name: naam, kind: 'klant' })).id;
    await startSubscription(p, eigenaar, org, { plan, interval });
    return org;
  }
  /** Lopende betaalde periode (geen proef meer). */
  async function betaald(org: string) {
    await p.pool.query(
      `UPDATE subscription SET status = 'actief', trial_ends_at = now() - interval '30 days',
              current_period_start = now() - interval '10 days', current_period_end = now() + interval '200 days'
        WHERE organization_id = $1 AND status <> 'beeindigd'`,
      [org],
    );
  }
  /** Zoals de cockpit het instelt. */
  async function opFactuur(org: string) {
    await p.pool.query(`UPDATE organization SET payment_method = 'factuur', payment_method_note = 'afspraak' WHERE id = $1`, [org]);
  }
  const methode = async (org: string) => (await p.pool.query('SELECT payment_method FROM organization WHERE id = $1', [org])).rows[0].payment_method;

  it('MKB (ook per jaar) en Corporate per maand kunnen geen factuur aanvragen', async () => {
    for (const [naam, plan, iv] of <[string, string, string][]>[
      ['MKB Jaar BV', 'mkb', 'jaar'],
      ['MKB Maand BV', 'mkb', 'maand'],
      ['Corporate Maand BV', 'business', 'maand'],
    ]) {
      const org = await nieuweKlant(naam, plan, iv);
      expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.factuurMogelijk).toBe(false);
      const err = await requestInvoicePayment(p, eigenaar, org, 'Wij werken met inkoopordernummers').catch((e) => e);
      expect(err).toMatchObject({ code: 'conflict' });
      expect(err.message).toContain('jaarcontract');
      const notes = await p.pool.query('SELECT 1 FROM org_note WHERE organization_id = $1', [org]);
      expect(notes.rowCount).toBe(0);
    }
  });

  it('Corporate per jaar kan factuur aanvragen', async () => {
    const org = await nieuweKlant('Corporate Jaar BV', 'business', 'jaar');
    expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.factuurMogelijk).toBe(true);
    await requestInvoicePayment(p, eigenaar, org, 'Wij werken met inkoopordernummers');
    expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.factuurAangevraagdOp).toBeTruthy();
  });

  it('een geplande wissel naar Corporate per jaar telt al mee', async () => {
    const org = await nieuweKlant('Wordt Jaar BV', 'business', 'maand');
    await betaald(org);
    await changePlan(p, eigenaar, org, { plan: 'business', interval: 'jaar' });
    expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.factuurMogelijk).toBe(true);
  });

  it('van Corporate jaar naar maand: waarschuwing vooraf, daarna terug naar incasso', async () => {
    const org = await nieuweKlant('Naar Maand BV', 'business', 'jaar');
    await betaald(org);
    await opFactuur(org);
    const pre = await previewPlanChange(p, eigenaar.userId, org, { plan: 'business', interval: 'maand' });
    expect(pre.waarschuwingen.join(' ')).toContain('automatische incasso');
    expect(await methode(org)).toBe('factuur');

    await changePlan(p, eigenaar, org, { plan: 'business', interval: 'maand' });
    expect(await methode(org)).toBe('incasso');
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.betaalwijze.teruggezetNaarIncassoOp).toBeTruthy();
    const note = await p.pool.query(`SELECT body FROM org_note WHERE organization_id = $1 AND source = 'systeem'`, [org]);
    expect(note.rows[0].body).toContain('teruggezet');
    const log = await p.pool.query(`SELECT 1 FROM audit_log WHERE organization_id = $1 AND action = 'betaalwijze.terug_naar_incasso'`, [org]);
    expect(log.rowCount).toBe(1);
  });

  it('van Corporate jaar naar MKB tijdens de proef: direct terug naar incasso', async () => {
    const org = await nieuweKlant('Naar MKB BV', 'business', 'jaar');
    await opFactuur(org);
    await changePlan(p, eigenaar, org, { plan: 'mkb', interval: 'jaar' });
    expect(await methode(org)).toBe('incasso');
  });

  it('Corporate jaar blijft op factuur bij een wissel die factuur toestaat', async () => {
    const org = await nieuweKlant('Blijft BV', 'business', 'jaar');
    await opFactuur(org);
    const pre = await previewPlanChange(p, eigenaar.userId, org, { plan: 'business', interval: 'jaar' });
    expect(pre.waarschuwingen).toEqual([]);
    await changePlan(p, eigenaar, org, { plan: 'business', interval: 'jaar' });
    expect(await methode(org)).toBe('factuur');
    expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.uitzondering).toBe(false);
  });

  it('een maatwerk-uitzondering uit de cockpit blijft staan en is herkenbaar', async () => {
    const org = await nieuweKlant('Maatwerk BV', 'mkb', 'maand');
    await opFactuur(org);
    expect((await getBilling(p, eigenaar.userId, org)).betaalwijze.uitzondering).toBe(true);
    await changePlan(p, eigenaar, org, { plan: 'mkb', interval: 'jaar' });
    expect(await methode(org)).toBe('factuur');
  });
});
